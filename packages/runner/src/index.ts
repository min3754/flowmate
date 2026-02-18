/**
 * @module runner/index
 * Runner entrypoint: loads task config, calls Claude Agent SDK query(),
 * and emits results via IPC. Runs inside a Podman container (production)
 * or as a local Node process (dev).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, TaskConfig } from "@flowmate/shared";
import { emit, debug } from "./ipc.js";
import fs from "node:fs";
import crypto from "node:crypto";

/**
 * Validate that a parsed object has the required TaskConfig shape.
 * Lightweight runtime check — catches corrupted configs early with clear errors.
 *
 * @throws {Error} If required fields are missing or have incorrect types
 */
function validateTaskConfig(obj: unknown): asserts obj is TaskConfig {
  if (!obj || typeof obj !== "object") {
    throw new Error("Task config must be a JSON object");
  }
  const cfg = obj as Record<string, unknown>;
  const requiredStrings = ["model", "prompt", "workingDirectory"] as const;
  for (const field of requiredStrings) {
    if (typeof cfg[field] !== "string") {
      throw new Error(`Task config missing or invalid field: ${field}`);
    }
  }
  if (typeof cfg.executionId !== "number") {
    throw new Error("Task config missing or invalid field: executionId");
  }
  if (!Array.isArray(cfg.conversationMessages)) {
    throw new Error("Task config missing or invalid field: conversationMessages");
  }
  if (!Array.isArray(cfg.allowedDirectories)) {
    throw new Error("Task config missing or invalid field: allowedDirectories");
  }
  if (!cfg.limits || typeof cfg.limits !== "object") {
    throw new Error("Task config missing or invalid field: limits");
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") {
    throw new Error("Task config missing or invalid field: mcpServers");
  }
}

/**
 * Load TaskConfig from TASK_CONFIG_FILE (temp file) or TASK_CONFIG (env var).
 * File-based loading is used for large configs that exceed OS env var limits.
 *
 * @throws {Error} If neither source is available or the config is malformed
 */
function loadTaskConfig(): TaskConfig {
  let raw: unknown;

  const filePath = process.env.TASK_CONFIG_FILE;
  if (filePath) {
    debug(`Loading task config from file: ${filePath}`);
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } else {
    const envVar = process.env.TASK_CONFIG;
    if (envVar) {
      debug("Loading task config from environment variable");
      raw = JSON.parse(envVar);
    } else {
      throw new Error("No TASK_CONFIG or TASK_CONFIG_FILE provided");
    }
  }

  validateTaskConfig(raw);
  return raw;
}

/**
 * Build a prompt string that includes conversation history for multi-turn context.
 * Single-turn conversations return the raw prompt unchanged.
 */
function buildContextPrompt(config: TaskConfig): string {
  const history = config.conversationMessages;
  if (history.length <= 1) {
    return config.prompt;
  }

  let context = "Previous conversation:\n";
  // Exclude the last message (current prompt) from history — it's appended separately below
  for (const msg of history.slice(0, -1)) {
    if (msg.role === "system") {
      context += `${msg.content}\n\n`;
    } else {
      const prefix = msg.role === "user" ? "User" : "Assistant";
      context += `${prefix}: ${msg.content}\n\n`;
    }
  }
  context += `---\nCurrent request:\n${config.prompt}`;
  return context;
}

/**
 * Build a multimodal prompt with base64 image attachments
 * for the Agent SDK's streaming input format.
 *
 * @param textPrompt - Text portion of the prompt
 * @param attachments - Base64-encoded image attachments
 * @returns AsyncIterable that yields a single user message with image and text content blocks
 */
function buildImagePrompt(
  textPrompt: string,
  attachments: Attachment[],
): AsyncIterable<unknown> {
  const content: unknown[] = [];
  for (const att of attachments) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: att.mimeType, data: att.base64 },
    });
  }
  content.push({ type: "text", text: textPrompt || "Analyze this image." });

  // The Agent SDK expects an AsyncIterable for multimodal prompts;
  // wrap content blocks in a single user message
  async function* generate() {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: crypto.randomUUID(),
    };
  }
  return generate();
}

/**
 * Extract text content from an Agent SDK assistant message,
 * joining multiple text blocks.
 */
function extractText(message: { message?: { content?: unknown[] } }): string {
  if (!message.message?.content) return "";
  const parts: string[] = [];
  for (const block of message.message.content) {
    if (block && typeof block === "object" && "text" in block) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * Run a single Agent SDK query, streaming progress updates
 * and emitting the final result or error via IPC.
 */
async function main(): Promise<void> {
  const taskConfig = loadTaskConfig();
  debug(`Execution #${taskConfig.executionId} starting`);

  const contextPrompt = buildContextPrompt(taskConfig);
  const startTime = Date.now();

  const hasAttachments =
    taskConfig.attachments && taskConfig.attachments.length > 0;
  // String prompt for text-only; AsyncIterable for multimodal (with images)
  const prompt = hasAttachments
    ? buildImagePrompt(contextPrompt, taskConfig.attachments!)
    : contextPrompt;

  try {
    for await (const message of query({
      prompt: prompt as string,
      options: {
        model: taskConfig.model,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            "You are FlowMate, a personal AI assistant. Respond in the same language as the user.",
        },
        // Runner operates in a sandboxed environment (container) so all permissions are pre-authorized
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: taskConfig.limits.maxTurnsPerTask,
        maxBudgetUsd: taskConfig.limits.maxBudgetPerTask,
        cwd: taskConfig.workingDirectory,
        tools: taskConfig.tools,
        // Type cast needed because Agent SDK's MCP type is more specific than our config type
        mcpServers: taskConfig.mcpServers as Record<string, never>,
        settingSources: taskConfig.skills.enabled ? ["project"] : [],
        stderr: (data: string) => debug(`sdk-stderr: ${data.trimEnd()}`),
      },
    })) {
      debug(`sdk-message: type=${message.type}, keys=${Object.keys(message).join(",")}`);
      if (message.type === "assistant") {
        const text = extractText(
          message as { message?: { content?: unknown[] } },
        );
        if (text) {
          await emit({
            type: "progress",
            text,
            timestamp: new Date().toISOString(),
          });
        }
      } else if (message.type === "result") {
        const durationMs = Date.now() - startTime;
        // The Agent SDK result message shape is not fully typed; cast to access fields
        const resultMsg = message as Record<string, unknown>;

        debug(`sdk-result: subtype=${resultMsg.subtype}, hasResult=${"result" in resultMsg}, hasCost=${"total_cost_usd" in resultMsg}`);
        if (resultMsg.subtype === "success") {
          await emit({
            type: "result",
            text: (resultMsg.result as string) ?? "",
            costUsd: (resultMsg.total_cost_usd as number) ?? 0,
            tokensUsed: {
              input:
                ((resultMsg.usage as Record<string, number>)
                  ?.input_tokens as number) ?? 0,
              output:
                ((resultMsg.usage as Record<string, number>)
                  ?.output_tokens as number) ?? 0,
              cacheRead:
                ((resultMsg.usage as Record<string, number>)
                  ?.cache_read_input_tokens as number) ?? 0,
              cacheWrite:
                ((resultMsg.usage as Record<string, number>)
                  ?.cache_creation_input_tokens as number) ?? 0,
            },
            durationMs,
            numTurns: (resultMsg.num_turns as number) ?? 0,
          });
        } else {
          const errors = (resultMsg.errors as string[]) ?? [
            resultMsg.subtype as string,
          ];
          await emit({
            type: "error",
            message: errors.join("; "),
            costUsd: (resultMsg.total_cost_usd as number) ?? 0,
            tokensUsed: {
              input:
                ((resultMsg.usage as Record<string, number>)
                  ?.input_tokens as number) ?? 0,
              output:
                ((resultMsg.usage as Record<string, number>)
                  ?.output_tokens as number) ?? 0,
              cacheRead:
                ((resultMsg.usage as Record<string, number>)
                  ?.cache_read_input_tokens as number) ?? 0,
              cacheWrite:
                ((resultMsg.usage as Record<string, number>)
                  ?.cache_creation_input_tokens as number) ?? 0,
            },
            durationMs,
            numTurns: (resultMsg.num_turns as number) ?? 0,
          });
        }
      }
    }
    debug("sdk-loop: for-await loop completed normally");
  } catch (err) {
    debug(`sdk-loop: caught error: ${err instanceof Error ? err.message : String(err)}`);
    await emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      costUsd: 0,
      tokensUsed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      durationMs: Date.now() - startTime,
      numTurns: 0,
    });
    process.exitCode = 1;
  }

  debug(`Execution #${taskConfig.executionId} finished`);
}

main().catch(async (err) => {
  await emit({
    type: "error",
    message: err instanceof Error ? err.message : String(err),
    costUsd: 0,
    tokensUsed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    durationMs: 0,
    numTurns: 0,
  });
  process.exitCode = 1;
});
