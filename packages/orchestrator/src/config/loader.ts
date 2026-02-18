/**
 * @module orchestrator/config/loader
 * YAML configuration loading with Zod validation.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ALL_TOOLS, type FlowmateConfig } from "@flowmate/shared";

/** Zod schema for MCP server entries within the config. */
const mcpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const configSchema = z.object({
  model: z.string().default("sonnet"),
  timezone: z.string().default("UTC"),
  database: z.object({ path: z.string() }),
  docker: z.object({
    command: z.enum(["podman", "docker", "nerdctl"]).default("podman"),
    runnerImage: z.string().default("flowmate-runner:latest"),
    memoryLimit: z.number().default(4_294_967_296),
    cpuLimit: z.number().default(2_000_000_000),
  }),
  allowedDirectories: z.array(
    z.string().refine((p) => path.isAbsolute(p), { message: "allowedDirectories must be absolute paths" }),
  ),
  defaultWorkingDirectory: z.string().refine((p) => path.isAbsolute(p), { message: "defaultWorkingDirectory must be an absolute path" }),
  limits: z.object({
    maxBudgetPerTask: z.number().default(2.0),
    maxTurnsPerTask: z.number().default(100),
    taskTimeoutMs: z.number().default(600_000),
    dailyBudgetLimit: z.number().default(50.0),
    maxHistoryMessages: z.number().default(20),
  }),
  tools: z.array(z.string()).default([...ALL_TOOLS]),
  skills: z.object({ enabled: z.boolean().default(true) }),
  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
}).refine(
  (data) => data.allowedDirectories.some(
    (dir) => data.defaultWorkingDirectory === dir || data.defaultWorkingDirectory.startsWith(dir + "/"),
  ),
  { message: "defaultWorkingDirectory must be within one of the allowedDirectories" },
);

/**
 * Load and validate flowmate.yaml configuration.
 *
 * @param configPath - Path to the YAML config file
 * @returns Validated FlowmateConfig object
 * @throws {Error} If the file does not exist or fails Zod validation
 */
export function loadConfig(configPath: string): FlowmateConfig {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, "utf-8");
  const parsed = parseYaml(raw);
  const result = configSchema.safeParse(parsed);

  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config:\n${errors}`);
  }

  return result.data;
}
