/**
 * @module orchestrator/dev-cli
 * Dev CLI: Test the full execution pipeline without Slack or containers.
 *
 * Usage:
 *   make dev-cli                          # interactive mode
 *   make dev-cli ARGS='"your prompt"'     # one-shot mode
 */

import "dotenv/config";
import path from "node:path";
import readline from "node:readline";
import pino from "pino";
import { createDb, runMigrations } from "@flowmate/db";
import { loadConfig } from "./config/loader.js";
import { LocalRunner } from "./container/local-runner.js";
import { ExecutionService } from "./services/execution.js";
import {
  getOrCreateConversation,
  saveMessage,
} from "./context/thread-manager.js";

process.env.FLOWMATE_DEV = "true";

const verbose = process.argv.includes("--verbose");

const logger = pino({
  transport: { target: "pino-pretty", options: { colorize: true } },
  level: verbose ? "debug" : "info",
});

async function main(): Promise<void> {
  const projectRoot = process.cwd();

  const configPath = path.resolve(
    process.env.FLOWMATE_CONFIG ?? "config/flowmate.yaml",
  );
  const config = loadConfig(configPath);

  const dbPath = path.resolve(config.database.path);
  const { db } = createDb(dbPath);
  const migrationsFolder = path.resolve(
    projectRoot,
    "packages/db/src/migrations",
  );
  runMigrations(db, migrationsFolder);

  const runner = new LocalRunner(logger, projectRoot);
  const mcpEntryPath = path.resolve(projectRoot, "packages/mcp/dist/index.js");
  const executionService = new ExecutionService(db, runner, config, logger, mcpEntryPath);

  // Use a fixed thread for the CLI session
  const conversation = getOrCreateConversation(
    db,
    "dev-cli",
    `cli-${Date.now()}`,
    "dev-user",
  );

  // One-shot mode: first non-flag argument
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (args.length > 0) {
    await runPrompt(executionService, db, conversation, args.join(" "));
    return;
  }

  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("FlowMate Dev CLI (type 'exit' to quit)\n");

  const ask = (): void => {
    rl.question("you> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit") {
        rl.close();
        return;
      }
      await runPrompt(executionService, db, conversation, trimmed);
      ask();
    });
  };

  ask();
}

/** Execute a single prompt and print the result to the terminal. */
async function runPrompt(
  executionService: ExecutionService,
  db: Parameters<typeof saveMessage>[0],
  conversation: {
    id: number;
    channelId: string;
    threadTs: string;
    userId: string;
  },
  prompt: string,
): Promise<void> {
  saveMessage(db, conversation.id, "user", prompt);

  console.log("\n--- executing ---");
  const start = Date.now();

  try {
    const result = await executionService.execute({
      conversation,
      prompt,
      onProgress: async (text) => {
        const preview =
          text.length > 120 ? text.slice(0, 120) + "..." : text;
        process.stdout.write(`  [progress] ${preview}\n`);
      },
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `\n--- result (${elapsed}s, $${result.costUsd.toFixed(4)}) ---`,
    );
    console.log(result.text);
    console.log("");

    saveMessage(db, conversation.id, "assistant", result.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n--- error ---\n${msg}\n`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
