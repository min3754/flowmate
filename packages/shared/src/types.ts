/**
 * @module shared/types
 * Core type definitions shared across all FlowMate packages.
 */

/** Lifecycle state of a Slack thread conversation. */
export type ConversationStatus = "active" | "archived";

/** Lifecycle state of a single runner execution. */
export type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "error"
  | "timeout";

/** Role identifier for messages in conversation history. */
export type MessageRole = "user" | "assistant" | "system";

/** A single message in the conversation history passed to the runner. */
export interface ConversationMessage {
  role: MessageRole;
  content: string;
}

/** Configuration for an MCP (Model Context Protocol) server passed to the Agent SDK. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Per-execution resource limits enforced by the orchestrator and runner. */
export interface TaskLimits {
  /** Maximum cost in USD before the Agent SDK stops. */
  maxBudgetPerTask: number;
  maxTurnsPerTask: number;
  /** Wall-clock timeout in milliseconds. */
  taskTimeoutMs: number;
}

/** A file attachment (image) encoded as base64 for the runner. */
export interface Attachment {
  filename: string;
  mimeType: string;
  base64: string;
}

/**
 * Complete configuration passed to the runner process via IPC.
 * Contains everything the runner needs to execute a single query.
 */
export interface TaskConfig {
  executionId: number;
  model: string;
  conversationMessages: ConversationMessage[];
  prompt: string;
  attachments?: Attachment[];
  workingDirectory: string;
  allowedDirectories: string[];
  mcpServers: Record<string, McpServerConfig>;
  limits: TaskLimits;
  /** Agent SDK tools available to the runner. */
  tools: string[];
  /** Whether CLAUDE.md project skill loading is enabled. */
  skills: { enabled: boolean };
}

/** All Agent SDK built-in tools that can be configured. */
export const ALL_TOOLS = [
  "Read", "Edit", "Write", "Bash", "Glob",
  "Grep", "Task", "WebSearch", "WebFetch",
] as const;

/** Top-level application configuration loaded from flowmate.yaml. */
export interface FlowmateConfig {
  model: string;
  /** IANA timezone for date boundaries (e.g. "Asia/Seoul"). Defaults to "UTC". */
  timezone: string;
  database: { path: string };
  docker: {
    /** Container CLI command (default: "podman"). Supports podman, docker, nerdctl. */
    command: string;
    runnerImage: string;
    /** Container memory limit in bytes. */
    memoryLimit: number;
    /** CPU limit in nanoCPUs (1e9 = 1 CPU). */
    cpuLimit: number;
  };
  allowedDirectories: string[];
  defaultWorkingDirectory: string;
  limits: {
    maxBudgetPerTask: number;
    maxTurnsPerTask: number;
    taskTimeoutMs: number;
    dailyBudgetLimit: number;
    /** Maximum number of conversation messages to include in runner context. */
    maxHistoryMessages: number;
  };
  /** Agent SDK tools available to the runner. Defaults to all tools. */
  tools: string[];
  skills: { enabled: boolean };
  mcpServers: Record<string, McpServerConfig>;
}
