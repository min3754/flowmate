/**
 * @module runner/ipc
 * IPC communication with the orchestrator via stderr.
 *
 * The Agent SDK captures process.stdout for its own CLI communication,
 * so all IPC uses stderr with a unique prefix for the orchestrator to distinguish
 * IPC JSON lines from regular debug output.
 */

import { serializeIpc, IPC_PREFIX, type IpcMessage } from "@flowmate/shared";

/**
 * Write an IPC message to stderr with a unique prefix.
 * Returns a promise that resolves when the data is flushed,
 * ensuring the orchestrator receives the message before the process exits.
 */
export function emit(msg: IpcMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const flushed = process.stderr.write(IPC_PREFIX + serializeIpc(msg) + "\n");
    if (flushed) {
      resolve();
    } else {
      const onDrain = () => { process.stderr.removeListener("error", onError); resolve(); };
      const onError = (err: Error) => { process.stderr.removeListener("drain", onDrain); reject(err); };
      process.stderr.once("drain", onDrain);
      process.stderr.once("error", onError);
    }
  });
}

/** Write a debug log line to stderr (visible in orchestrator logs but not parsed as IPC). */
export function debug(text: string): void {
  process.stderr.write(`[runner] ${text}\n`);
}
