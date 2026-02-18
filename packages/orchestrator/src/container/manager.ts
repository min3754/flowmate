/**
 * @module orchestrator/container/manager
 * Podman CLI container lifecycle management via child_process.spawn.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseIpcLine, IPC_PREFIX, type IpcMessage } from "@flowmate/shared";
import type { FlowmateConfig, TaskConfig } from "@flowmate/shared";
import type { Logger } from "pino";

/** Callbacks for IPC message delivery and process exit notification. */
export interface RunCallbacks {
  /** Called for each parsed IPC JSON line from stdout. */
  onMessage: (msg: IpcMessage) => void;
  /** Called when the container/process exits. */
  onExit: (code: number | null, signal: string | null) => void;
}

/** Handle to a running container/process, used for cleanup and kill. */
export interface RunHandle {
  containerId: string;
  child: ChildProcess;
}

/**
 * Common interface implemented by ContainerManager (production) and LocalRunner (dev).
 * Abstracts container vs. local process execution behind a unified API.
 */
export interface RunnerBackend {
  run(taskConfig: TaskConfig, callbacks: RunCallbacks): Promise<RunHandle>;
  kill(containerId: string): Promise<void>;
  imageExists(imageName: string): Promise<boolean>;
}

/**
 * Manages container lifecycle using Podman CLI commands.
 * Also compatible with Docker and nerdctl via the `command` config field.
 */
export class ContainerManager {
  private command: string;

  constructor(
    private containerConfig: FlowmateConfig["docker"],
    private logger: Logger,
  ) {
    this.command = containerConfig.command ?? "podman";
  }

  /**
   * Spawn a container with the runner image, streaming IPC output.
   *
   * @param taskConfig - Full task configuration to pass to the runner
   * @param callbacks - IPC message and exit handlers
   * @returns Handle containing the container ID and child process
   */
  async run(
    taskConfig: TaskConfig,
    callbacks: RunCallbacks,
  ): Promise<RunHandle> {
    const containerId = `flowmate-${taskConfig.executionId}`;
    const taskConfigJson = JSON.stringify(taskConfig);

    // Configs over 128KB (e.g., with base64 images) are written to a temp file
    // to avoid exceeding container CLI argument length limits
    const useFile = Buffer.byteLength(taskConfigJson) > 128 * 1024;

    const args = [
      "run",
      "--rm",
      "--name",
      containerId,
      // Run as host user for bind-mount write access + non-root for Claude CLI
      "--user",
      `${process.getuid!()}:${process.getgid!()}`,
      "-e",
      `HOME=/home/flowmate`,
      "--memory",
      String(this.containerConfig.memoryLimit),
      "--cpus",
      String(this.containerConfig.cpuLimit / 1e9),
      "-e",
      "ANTHROPIC_API_KEY",
    ];

    let tmpPath: string | undefined;
    if (useFile) {
      tmpPath = path.join(
        os.tmpdir(),
        `flowmate-task-${taskConfig.executionId}.json`,
      );
      fs.writeFileSync(tmpPath, taskConfigJson);
      args.push("-v", `${tmpPath}:/task-config.json:ro`);
      args.push("-e", "TASK_CONFIG_FILE=/task-config.json");
    } else {
      args.push("-e", `TASK_CONFIG=${taskConfigJson}`);
    }

    for (const dir of taskConfig.allowedDirectories) {
      args.push("-v", `${dir}:${dir}`);
    }

    args.push("-w", taskConfig.workingDirectory);
    args.push(this.containerConfig.runnerImage);

    this.logger.info({ containerId, args: args.slice(0, 6) }, "Spawning container");

    // stdin ignored; stdout is captured by Agent SDK; IPC goes through stderr with prefix
    const child = spawn(this.command, args, { stdio: ["ignore", "pipe", "pipe"] });

    // Log stdout for diagnostics (Agent SDK may write here)
    child.stdout!.on("data", (chunk: Buffer) => {
      this.logger.debug({ stdout: chunk.toString() }, "Container stdout");
    });

    // Parse stderr: lines with IPC_PREFIX are IPC messages, others are debug logs
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
        this.logger.debug({ stderr: line }, "Container stderr");
      }
    });

    // Use 'close' instead of 'exit': 'close' fires after all stdio streams are drained,
    // ensuring IPC messages are fully received before onExit checks resultReceived.
    child.on("close", (code, signal) => {
      if (tmpPath) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore cleanup errors
        }
      }
      callbacks.onExit(code, signal);
    });

    return { containerId, child };
  }

  /**
   * Gracefully stop a running container: SIGTERM → 5s grace → SIGKILL.
   * Uses `podman stop` which sends SIGTERM first, then SIGKILL after the timeout.
   */
  async kill(containerId: string): Promise<void> {
    return new Promise((resolve) => {
      this.logger.info({ containerId }, "Stopping container (5s grace period)");
      const child = spawn(this.command, ["stop", "--time=5", containerId]);
      child.on("exit", () => resolve());
    });
  }

  /** Check if a container image exists locally. Returns false if the container CLI is not found. */
  async imageExists(imageName: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.command, ["image", "inspect", imageName], {
        stdio: "ignore",
      });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
  }
}
