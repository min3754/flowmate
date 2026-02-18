/**
 * @module orchestrator/container/cleanup
 * Periodic scanner that kills orphaned FlowMate containers.
 */

import { execFileSync } from "node:child_process";
import type { ContainerManager } from "./manager.js";
import type { Logger } from "pino";

/**
 * Periodically scans for FlowMate containers that have exceeded 2x the task timeout
 * and kills them. Runs every 60 seconds when started.
 */
export class ContainerCleanup {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private containerManager: ContainerManager,
    private timeoutMs: number,
    private logger: Logger,
    private command: string = "podman",
  ) {}

  /** Begin scanning every 60 seconds. */
  start(): void {
    this.intervalId = setInterval(() => {
      this.cleanup().catch((err) =>
        this.logger.error(err, "Container cleanup failed"),
      );
    }, 60_000);
  }

  /** Stop the periodic scanner. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Run a single cleanup pass: list containers, parse age, kill stale ones. */
  async cleanup(): Promise<void> {
    let output: string;
    try {
      output = execFileSync(
        this.command,
        ["ps", "--filter", "name=flowmate-", "--format", "{{.ID}}\t{{.Names}}\t{{.RunningFor}}"],
        { encoding: "utf-8", timeout: 10_000 },
      );
    } catch {
      return; // container ps failed, skip
    }

    // 2x timeout provides margin for normal teardown before considering a container orphaned
    const maxAgeMs = this.timeoutMs * 2;

    for (const line of output.trim().split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const name = parts[1];
      const runningFor = parts[2];

      const ageMs = parseRunningFor(runningFor);
      if (ageMs > maxAgeMs) {
        this.logger.warn({ name, ageMs }, "Killing orphan container");
        await this.containerManager.kill(name);
      }
    }
  }
}

/**
 * Parse Podman's human-readable "running for" duration string into milliseconds.
 *
 * @param s - Duration string (e.g., "2 days ago", "2 hours ago", "5 minutes ago")
 * @returns Duration in milliseconds
 */
function parseRunningFor(s: string): number {
  let ms = 0;
  const days = s.match(/(\d+)\s*day/);
  const hours = s.match(/(\d+)\s*hour/);
  const minutes = s.match(/(\d+)\s*minute/);
  const seconds = s.match(/(\d+)\s*second/);
  if (days) ms += parseInt(days[1]) * 86_400_000;
  if (hours) ms += parseInt(hours[1]) * 3_600_000;
  if (minutes) ms += parseInt(minutes[1]) * 60_000;
  if (seconds) ms += parseInt(seconds[1]) * 1_000;
  return ms;
}
