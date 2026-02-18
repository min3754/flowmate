/**
 * @module orchestrator/services/execution
 * Full execution orchestration: budget check, history loading, runner dispatch,
 * result persistence, and cost tracking.
 */

import path from "node:path";
import { eq } from "drizzle-orm";
import type { FlowmateDb } from "@flowmate/db";
import { executions } from "@flowmate/db";
import type { Attachment, ConversationMessage, FlowmateConfig, IpcMessage, McpServerConfig, TaskConfig } from "@flowmate/shared";
import type { Conversation } from "../context/thread-manager.js";
import { getConversationHistory } from "../context/thread-manager.js";
import type { RunnerBackend } from "../container/manager.js";
import { CostTracker } from "./cost-tracker.js";
import type { Logger } from "pino";

/**
 * Keep only the most recent messages when history exceeds the limit.
 * Prepends a system note so the runner knows earlier context was omitted.
 */
function truncateHistory(
  history: ConversationMessage[],
  maxMessages: number,
  logger: Logger,
): ConversationMessage[] {
  if (history.length <= maxMessages) {
    return history;
  }

  const omitted = history.length - maxMessages;
  logger.info(
    `Truncating conversation history: ${history.length} → ${maxMessages} messages (${omitted} omitted)`,
  );

  const recent = history.slice(-maxMessages);
  recent.unshift({
    role: "system",
    content: `[${omitted} earlier messages omitted for context window efficiency]`,
  });
  return recent;
}

/** Successful execution outcome returned to the caller (Slack handler or CLI). */
export interface ExecutionResult {
  text: string;
  costUsd: number;
  executionId: number;
}

/**
 * Orchestrates a complete execution lifecycle: validates budget, builds task config,
 * spawns the runner, and persists results.
 */
export class ExecutionService {
  private costTracker: CostTracker;
  /** Tracks in-flight execution promises for graceful shutdown draining. */
  private activeExecutions = new Map<number, { promise: Promise<ExecutionResult>; runnerId: string | null }>();

  constructor(
    private db: FlowmateDb,
    private runner: RunnerBackend,
    private config: FlowmateConfig,
    private logger: Logger,
    private mcpEntryPath: string,
  ) {
    this.costTracker = new CostTracker(db, config.timezone);
  }

  /** Number of currently running executions. */
  get activeCount(): number {
    return this.activeExecutions.size;
  }

  /**
   * Wait for all in-flight executions to complete, with a timeout.
   * After timeout, kills remaining runners.
   */
  async drain(timeoutMs: number = 10_000): Promise<void> {
    if (this.activeExecutions.size === 0) return;

    this.logger.info({ count: this.activeExecutions.size }, "Draining in-flight executions...");

    const drainPromise = Promise.allSettled(
      Array.from(this.activeExecutions.values()).map((e) => e.promise),
    );

    const timer = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    );

    const result = await Promise.race([drainPromise, timer]);

    if (result === "timeout") {
      this.logger.warn({ remaining: this.activeExecutions.size }, "Drain timeout, killing remaining runners");
      for (const [id, entry] of this.activeExecutions) {
        if (entry.runnerId) {
          this.runner.kill(entry.runnerId).catch(() => {});
        }
        this.logger.warn({ executionId: id }, "Force-killed execution on shutdown");
      }
    }
  }

  /**
   * Execute a user prompt within a conversation context.
   * Checks daily budget, loads history, spawns the runner backend,
   * handles progress/result/error IPC messages, and records costs.
   *
   * @param params - Execution parameters including conversation, prompt, and optional attachments
   * @returns The execution result with response text and cost
   * @throws {Error} When daily budget is exceeded, the task times out, or the runner fails
   */
  async execute(params: {
    conversation: Conversation;
    prompt: string;
    attachments?: Attachment[];
    onProgress?: (text: string) => Promise<void>;
  }): Promise<ExecutionResult> {
    // Check daily budget with pessimistic reservation for concurrent executions
    const budget = this.costTracker.checkBudget(
      this.config.limits.dailyBudgetLimit,
      this.config.limits.maxBudgetPerTask,
    );
    if (!budget.allowed) {
      throw new Error(
        `Daily budget exceeded. Remaining: $${budget.remaining.toFixed(2)}`,
      );
    }

    // Reserve budget for this execution; released when the execution settles
    const releaseReservation = this.costTracker.reserve();

    // Load conversation history, truncating to the configured limit
    const fullHistory = getConversationHistory(
      this.db,
      params.conversation.id,
    );
    const conversationMessages = truncateHistory(
      fullHistory,
      this.config.limits.maxHistoryMessages,
      this.logger,
    );

    // Create execution record with model for per-execution tracking
    const execution = this.db
      .insert(executions)
      .values({
        conversationId: params.conversation.id,
        model: this.config.model,
        status: "pending",
        prompt: params.prompt,
        startedAt: new Date().toISOString(),
      })
      .returning()
      .get();

    // Inject the built-in flowmate MCP server alongside user-configured servers
    const dbPath = path.resolve(this.config.database.path);
    const mcpServers: Record<string, McpServerConfig> = {
      ...this.config.mcpServers,
      flowmate: {
        command: "node",
        args: [
          this.mcpEntryPath,
          "--db", dbPath,
          "--budget", String(this.config.limits.dailyBudgetLimit),
          "--timezone", this.config.timezone,
        ],
      },
    };

    // Build task config
    const taskConfig: TaskConfig = {
      executionId: execution.id,
      model: this.config.model,
      conversationMessages,
      prompt: params.prompt,
      attachments: params.attachments,
      workingDirectory: this.config.defaultWorkingDirectory,
      allowedDirectories: this.config.allowedDirectories,
      mcpServers,
      limits: {
        // Cap per-task budget to the remaining daily allowance
        maxBudgetPerTask: Math.min(
          this.config.limits.maxBudgetPerTask,
          budget.remaining,
        ),
        maxTurnsPerTask: this.config.limits.maxTurnsPerTask,
        taskTimeoutMs: this.config.limits.taskTimeoutMs,
      },
      tools: this.config.tools,
      skills: this.config.skills,
    };

    // Update status to running
    this.db
      .update(executions)
      .set({ status: "running" })
      .where(eq(executions.id, execution.id))
      .run();

    // Wrap runner.run() in a Promise because the callback-based IPC model
    // needs to resolve/reject on message receipt rather than on spawn
    const entry = { promise: null as unknown as Promise<ExecutionResult>, runnerId: null as string | null };
    const executionPromise = new Promise<ExecutionResult>((resolve, reject) => {
      let resultReceived = false;
      // Stores the actual container/process ID from RunHandle for timeout kill
      let runnerId: string | null = null;

      // Timeout guard: kill the runner if no result arrives within the limit
      const timeout = setTimeout(() => {
        if (!resultReceived) {
          if (runnerId) {
            this.runner.kill(runnerId).catch(() => {});
          }
          this.db
            .update(executions)
            .set({
              status: "timeout",
              errorMessage: "Task timed out",
              finishedAt: new Date().toISOString(),
            })
            .where(eq(executions.id, execution.id))
            .run();
          reject(new Error("Task timed out"));
        }
      }, this.config.limits.taskTimeoutMs);

      // Debounce progress updates to avoid flooding the Slack API
      let lastProgressTime = 0;
      const PROGRESS_DEBOUNCE_MS = 3000;

      this.runner
        .run(taskConfig, {
          onMessage: (msg: IpcMessage) => {
            if (msg.type === "progress" && params.onProgress) {
              const now = Date.now();
              if (now - lastProgressTime >= PROGRESS_DEBOUNCE_MS) {
                lastProgressTime = now;
                params.onProgress(msg.text).catch((err) =>
                  this.logger.error(err, "Progress update failed"),
                );
              }
            } else if (msg.type === "result") {
              resultReceived = true;
              clearTimeout(timeout);

              this.db
                .update(executions)
                .set({
                  status: "completed",
                  resultText: msg.text,
                  costUsd: msg.costUsd,
                  inputTokens: msg.tokensUsed.input,
                  outputTokens: msg.tokensUsed.output,
                  cacheReadTokens: msg.tokensUsed.cacheRead,
                  cacheWriteTokens: msg.tokensUsed.cacheWrite,
                  durationMs: msg.durationMs,
                  numTurns: msg.numTurns,
                  finishedAt: new Date().toISOString(),
                })
                .where(eq(executions.id, execution.id))
                .run();

              resolve({
                text: msg.text,
                costUsd: msg.costUsd,
                executionId: execution.id,
              });
            } else if (msg.type === "error") {
              resultReceived = true;
              clearTimeout(timeout);

              this.db
                .update(executions)
                .set({
                  status: "failed",
                  errorMessage: msg.message,
                  costUsd: msg.costUsd,
                  inputTokens: msg.tokensUsed.input,
                  outputTokens: msg.tokensUsed.output,
                  cacheReadTokens: msg.tokensUsed.cacheRead,
                  cacheWriteTokens: msg.tokensUsed.cacheWrite,
                  durationMs: msg.durationMs,
                  numTurns: msg.numTurns,
                  finishedAt: new Date().toISOString(),
                })
                .where(eq(executions.id, execution.id))
                .run();

              reject(new Error(msg.message));
            }
          },
          onExit: (code, signal) => {
            clearTimeout(timeout);
            // If the process exits before sending a result IPC message,
            // treat it as an unexpected crash
            if (!resultReceived) {
              const errorMsg = `Runner exited without IPC result (code=${code}, signal=${signal}, containerId=${runnerId})`;
              this.logger.error({ code, signal, executionId: execution.id, runnerId }, errorMsg);
              this.db
                .update(executions)
                .set({
                  status: "error",
                  errorMessage: errorMsg,
                  finishedAt: new Date().toISOString(),
                })
                .where(eq(executions.id, execution.id))
                .run();
              reject(new Error(errorMsg));
            }
          },
        })
        .then((handle) => {
          runnerId = handle.containerId;
          entry.runnerId = handle.containerId;
          // Store the container ID after successful spawn for potential kill/cleanup
          this.db
            .update(executions)
            .set({ containerId: handle.containerId })
            .where(eq(executions.id, execution.id))
            .run();
        })
        .catch((err) => {
          clearTimeout(timeout);
          this.db
            .update(executions)
            .set({
              status: "error",
              errorMessage: err.message,
              finishedAt: new Date().toISOString(),
            })
            .where(eq(executions.id, execution.id))
            .run();
          reject(err);
        });
    });

    entry.promise = executionPromise;
    this.activeExecutions.set(execution.id, entry);

    // Clean up tracking and release budget reservation when execution settles.
    // .catch() suppresses the unhandled rejection — the actual error is handled by the caller's await.
    executionPromise.finally(() => {
      this.activeExecutions.delete(execution.id);
      releaseReservation();
    }).catch(() => {});

    return executionPromise;
  }
}
