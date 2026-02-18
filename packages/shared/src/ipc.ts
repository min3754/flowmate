/**
 * @module shared/ipc
 * JSON Lines IPC protocol between orchestrator and runner.
 * IPC messages are sent via stderr with a unique prefix to avoid
 * conflicts with the Agent SDK's stdout capture.
 */

/**
 * Prefix that marks a stderr line as an IPC message (not debug output).
 * The `@flowmate` prefix ensures no accidental collision with normal log lines.
 */
export const IPC_PREFIX = "@flowmate ";

/** Token consumption breakdown for a single execution. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Intermediate progress update emitted during execution. */
export interface IpcProgressMessage {
  type: "progress";
  text: string;
  timestamp: string;
}

/** Final success result with cost and usage metrics. */
export interface IpcResultMessage {
  type: "result";
  text: string;
  costUsd: number;
  tokensUsed: TokenUsage;
  durationMs: number;
  numTurns: number;
}

/** Error result with partial cost and progress tracking. */
export interface IpcErrorMessage {
  type: "error";
  message: string;
  costUsd: number;
  tokensUsed: TokenUsage;
  /** Wall-clock time elapsed before the error occurred. */
  durationMs: number;
  /** Number of agentic turns completed before the error. */
  numTurns: number;
}

/** Discriminated union of all IPC message types. */
export type IpcMessage = IpcProgressMessage | IpcResultMessage | IpcErrorMessage;

/** Valid IPC message type discriminants. */
const IPC_TYPES = new Set(["progress", "result", "error"]);

/**
 * Runtime check that a parsed JSON object conforms to the IpcMessage discriminated union.
 * Validates the type discriminant and required fields for each message type.
 */
function isValidIpcMessage(obj: unknown): obj is IpcMessage {
  if (!obj || typeof obj !== "object" || !("type" in obj)) return false;
  const msg = obj as Record<string, unknown>;
  if (!IPC_TYPES.has(msg.type as string)) return false;

  if (msg.type === "progress") {
    return typeof msg.text === "string";
  }
  // result and error both require numeric metrics and token usage
  if (typeof msg.costUsd !== "number" || typeof msg.durationMs !== "number") {
    return false;
  }
  if (!msg.tokensUsed || typeof msg.tokensUsed !== "object") {
    return false;
  }
  if (msg.type === "result") {
    return typeof msg.text === "string";
  }
  // error
  return typeof msg.message === "string";
}

/**
 * Parse a single JSON Lines IPC message from raw text.
 * Returns null for empty, malformed, or structurally invalid lines.
 *
 * @param line - Raw IPC line from the runner process (prefix already stripped)
 * @returns Parsed and validated IPC message, or null if invalid
 */
export function parseIpcLine(line: string): IpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isValidIpcMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Serialize an IPC message to a single JSON line for stderr transport.
 *
 * @param msg - IPC message to serialize
 */
export function serializeIpc(msg: IpcMessage): string {
  return JSON.stringify(msg);
}
