/**
 * @module orchestrator/container/local-runner
 * Dev-mode runner that spawns a local Node process instead of a container.
 * No image build required — reads compiled dist directly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseIpcLine, IPC_PREFIX } from "@flowmate/shared";
import type { TaskConfig } from "@flowmate/shared";
import type { RunCallbacks, RunHandle } from "./manager.js";
import type { Logger } from "pino";

/** Grace period (ms) between SIGTERM and SIGKILL for local processes. */
const KILL_GRACE_MS = 5000;
/** Maximum stderr buffer size (bytes) to prevent unbounded memory growth. */
const MAX_STDERR_BUF = 10 * 1024;

/**
 * Dev mode runner: spawns the runner as a local Node process instead of a Podman container.
 * No container image build required — reads compiled dist.
 */
export class LocalRunner {
  private projectRoot: string;
  /** Active child processes tracked by process ID for graceful termination. */
  private processes = new Map<string, ChildProcess>();

  constructor(private logger: Logger, projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.cwd();
  }

  /**
   * Spawn the runner as a local Node.js child process with IPC via stdout.
   *
   * @param taskConfig - Full task configuration to pass to the runner
   * @param callbacks - IPC message and exit handlers
   * @returns Handle containing the process ID and child process
   */
  async run(
    taskConfig: TaskConfig,
    callbacks: RunCallbacks,
  ): Promise<RunHandle> {
    const processId = `local-${taskConfig.executionId}`;
    const runnerEntry = path.resolve(
      this.projectRoot,
      "packages/runner/dist/index.js",
    );

    const taskConfigJson = JSON.stringify(taskConfig);
    const useFile = Buffer.byteLength(taskConfigJson) > 128 * 1024;

    this.logger.info(
      { processId, runnerEntry, configSize: Buffer.byteLength(taskConfigJson), useFile },
      "Spawning local runner process",
    );

    // Write large configs (e.g. with image attachments) to a temp file
    // to avoid exceeding OS env var size limits.
    let tmpPath: string | undefined;
    if (useFile) {
      tmpPath = path.join(
        os.tmpdir(),
        `flowmate-task-${taskConfig.executionId}.json`,
      );
      fs.writeFileSync(tmpPath, taskConfigJson);
    }

    // Build a clean env:
    // - Remove CLAUDECODE to avoid nested-session detection
    // - Set NODE_PATH so runner can resolve workspace deps from any cwd
    const { CLAUDECODE: _, ...restEnv } = process.env;
    const nodeModulesPath = path.resolve(this.projectRoot, "node_modules");
    const env: Record<string, string | undefined> = {
      ...restEnv,
      NODE_PATH: nodeModulesPath,
    };
    if (useFile) {
      env.TASK_CONFIG_FILE = tmpPath;
    } else {
      env.TASK_CONFIG = taskConfigJson;
    }

    const child = spawn("node", [runnerEntry], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd: taskConfig.workingDirectory,
    });

    // Log stdout for diagnostics (Agent SDK may write here)
    child.stdout!.on("data", (chunk: Buffer) => {
      this.logger.debug({ stdout: chunk.toString() }, "Runner stdout");
    });

    // Parse stderr: lines with IPC_PREFIX are IPC messages, others are debug logs
    let stderrBuf = "";
    const rl = createInterface({ input: child.stderr! });
    rl.on("line", (line) => {
      if (line.startsWith(IPC_PREFIX)) {
        const msg = parseIpcLine(line.slice(IPC_PREFIX.length));
        if (msg) {
          callbacks.onMessage(msg);
        } else {
          this.logger.warn({ line }, "Malformed IPC message");
        }
      } else {
        stderrBuf += line + "\n";
        // Cap buffer to last MAX_STDERR_BUF bytes to prevent unbounded memory growth
        if (stderrBuf.length > MAX_STDERR_BUF) {
          stderrBuf = stderrBuf.slice(-MAX_STDERR_BUF);
        }
        this.logger.debug({ stderr: line }, "Runner stderr");
      }
    });

    this.processes.set(processId, child);

    child.on("close", (code, signal) => {
      this.processes.delete(processId);
      if (tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      if (code !== 0 && stderrBuf.trim()) {
        this.logger.error(
          { code, stderr: stderrBuf.trim() },
          "Runner process failed",
        );
      }
      callbacks.onExit(code, signal);
    });

    return { containerId: processId, child };
  }

  /**
   * Gracefully terminate a local runner process: SIGTERM → grace period → SIGKILL.
   *
   * @param containerId - Process ID assigned during run() (e.g. "local-42")
   */
  async kill(containerId: string): Promise<void> {
    const child = this.processes.get(containerId);
    if (!child || child.exitCode !== null) {
      this.logger.debug({ containerId }, "Process already exited or not found");
      return;
    }

    this.logger.info({ containerId }, "Sending SIGTERM to local runner");
    child.kill("SIGTERM");

    // Wait for graceful exit, then force-kill if still running
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) {
          this.logger.warn({ containerId }, "Grace period expired, sending SIGKILL");
          child.kill("SIGKILL");
        }
        resolve();
      }, KILL_GRACE_MS);

      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
    });
  }

  /** Always returns true in dev mode — no image build needed. */
  async imageExists(_imageName: string): Promise<boolean> {
    return true;
  }
}
