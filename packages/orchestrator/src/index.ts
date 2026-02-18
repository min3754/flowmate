/**
 * @module orchestrator/index
 * Application entrypoint: loads config, initializes DB, starts Slack bot,
 * and manages graceful shutdown.
 */

import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { createDb, runMigrations } from "@flowmate/db";
import { loadConfig } from "./config/loader.js";
import { createSlackApp } from "./slack/app.js";
import { registerHandlers } from "./slack/handlers.js";
import { ContainerManager, type RunnerBackend } from "./container/manager.js";
import { LocalRunner } from "./container/local-runner.js";
import { ContainerCleanup } from "./container/cleanup.js";
import { ExecutionService } from "./services/execution.js";

// FLOWMATE_DEV=true switches from Podman container to local runner
const isDev = process.env.FLOWMATE_DEV === "true";

const logDir = path.resolve("logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "flowmate.log");

const logger = pino(
  { level: "debug" },
  pino.transport({
    targets: [
      // Console: pretty in dev, JSON in production
      ...(process.env.NODE_ENV !== "production"
        ? [{ target: "pino-pretty", options: { colorize: true }, level: "info" as const }]
        : [{ target: "pino/file", options: { destination: 1 }, level: "info" as const }]),
      // File: always write all levels (debug+)
      { target: "pino/file", options: { destination: logFile, mkdir: true }, level: "debug" as const },
    ],
  }),
);

/** Validate that all required environment variables are set before initializing services. */
function validateEnv(): void {
  const required = ["ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

/** Bootstrap the orchestrator: config -> DB -> runner backend -> Slack -> signal handlers. */
async function main(): Promise<void> {
  logger.info("Starting FlowMate orchestrator...");

  validateEnv();

  // Load config
  const configPath = path.resolve(
    process.env.FLOWMATE_CONFIG ?? "config/flowmate.yaml",
  );
  const config = loadConfig(configPath);
  logger.info({ configPath }, "Config loaded");

  // Initialize DB
  const dbPath = path.resolve(config.database.path);
  const { db, sqlite } = createDb(dbPath);
  const migrationsFolder = path.resolve(
    __dirname,
    "../../db/src/migrations",
  );
  runMigrations(db, migrationsFolder);
  logger.info({ dbPath }, "Database initialized");

  // Runner backend: local process in dev, Podman container in production
  let runner: RunnerBackend;
  if (isDev) {
    runner = new LocalRunner(logger);
    logger.info("Dev mode: using local runner (no container)");
  } else {
    const containerManager = new ContainerManager(config.docker, logger);
    const imageReady = await containerManager.imageExists(
      config.docker.runnerImage,
    );
    if (!imageReady) {
      logger.warn(
        { image: config.docker.runnerImage },
        "Runner image not found. Build it with: make build",
      );
    }
    runner = containerManager;
  }

  // Dev: host absolute path, Production: container internal path
  const mcpEntryPath = isDev
    ? path.resolve("packages/mcp/dist/index.js")
    : "/app/mcp/dist/index.js";

  // Services
  const executionService = new ExecutionService(
    db,
    runner,
    config,
    logger,
    mcpEntryPath,
  );

  // Orphan container cleanup (production only)
  const cleanup = isDev
    ? null
    : new ContainerCleanup(
        runner as ContainerManager,
        config.limits.taskTimeoutMs,
        logger,
        config.docker.command,
      );
  cleanup?.start();

  // Slack app
  const { app, botUserId } = await createSlackApp();
  logger.info({ botUserId }, "Slack app connected");

  registerHandlers({
    app,
    botUserId,
    db,
    executionService,
    config,
    logger,
  });

  await app.start();
  logger.info("FlowMate orchestrator is running");

  // Graceful shutdown with in-flight execution draining
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "Shutting down...");
    cleanup?.stop();
    await app.stop();
    await executionService.drain(10_000);
    sqlite.close();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM").catch((err) => {
    logger.error(err, "Shutdown error");
    process.exit(1);
  }));
  process.on("SIGINT", () => shutdown("SIGINT").catch((err) => {
    logger.error(err, "Shutdown error");
    process.exit(1);
  }));
}

main().catch((err) => {
  logger.fatal(err, "Failed to start orchestrator");
  process.exit(1);
});
