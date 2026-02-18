/**
 * @module mcp/index
 * FlowMate MCP server entrypoint. Parses CLI args, opens a readonly DB connection,
 * registers tools, and starts the stdio transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openReadonlyDb } from "./db.js";
import { registerStatsTools } from "./tools/stats.js";

/** Parse `--key value` pairs from process.argv. */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const dbPath = args["db"];
  if (!dbPath) {
    console.error("Usage: node index.js --db <path> [--budget <limit>]");
    process.exit(1);
  }

  const rawBudget = args["budget"] ? Number(args["budget"]) : 50;
  const dailyBudgetLimit = Number.isFinite(rawBudget) ? rawBudget : 50;
  const timezone = args["timezone"] ?? "UTC";

  const db = openReadonlyDb(dbPath);

  const server = new McpServer({
    name: "flowmate",
    version: "0.0.1",
  });

  registerStatsTools(server, db, dailyBudgetLimit, timezone);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so stdout stays clean for MCP JSON-RPC
  console.error("[flowmate-mcp] Server started");
}

main().catch((err) => {
  console.error("[flowmate-mcp] Fatal:", err);
  process.exit(1);
});
