/**
 * @module mcp/tools/stats
 * Operational statistics tools: daily stats, cost history, execution history, model usage.
 * Date boundaries are computed in the configured timezone, while DB stores UTC timestamps.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { todayInTz, dateRangeInTz } from "@flowmate/shared";

/**
 * Register all statistics tools on the given MCP server instance.
 *
 * @param server - The MCP server to register tools on
 * @param db - Readonly SQLite database connection
 * @param dailyBudgetLimit - Daily budget limit in USD for remaining budget calculation
 * @param timezone - IANA timezone for date boundary calculation (e.g. "Asia/Seoul")
 */
export function registerStatsTools(
  server: McpServer,
  db: Database.Database,
  dailyBudgetLimit: number,
  timezone: string,
): void {
  // --- get_daily_stats ---
  server.tool(
    "get_daily_stats",
    "Get today's operational stats: cost, budget remaining, execution count, average duration",
    { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date (YYYY-MM-DD) in configured timezone, defaults to today") },
    ({ date }) => {
      const targetDate = date ?? todayInTz(timezone);
      const { start, end } = dateRangeInTz(targetDate, timezone);

      const row = db
        .prepare(
          `SELECT
             COALESCE(SUM(cost_usd), 0) as total_cost_usd,
             COUNT(*) as total_executions,
             AVG(CASE WHEN status IN ('completed', 'failed') THEN duration_ms END) as avg_duration_ms
           FROM executions
           WHERE started_at >= ? AND started_at < ?`,
        )
        .get(start, end) as {
        total_cost_usd: number;
        total_executions: number;
        avg_duration_ms: number | null;
      };

      const result = {
        date: targetDate,
        totalCostUsd: row.total_cost_usd,
        dailyBudgetLimit,
        remainingBudget: Math.max(0, dailyBudgetLimit - row.total_cost_usd),
        totalExecutions: row.total_executions,
        avgDurationMs: row.avg_duration_ms
          ? Math.round(row.avg_duration_ms)
          : null,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // --- get_cost_history ---
  server.tool(
    "get_cost_history",
    "Get daily cost trend over recent days",
    { days: z.number().int().min(1).max(90).default(7).describe("Number of days to look back (default 7, max 90)") },
    ({ days }) => {
      const result: Array<{ date: string; totalCostUsd: number; totalExecutions: number }> = [];
      const todayStr = todayInTz(timezone);
      const [y, m, d] = todayStr.split("-").map(Number);

      const stmt = db.prepare(
        `SELECT
           COALESCE(SUM(cost_usd), 0) as total_cost_usd,
           COUNT(*) as total_executions
         FROM executions
         WHERE started_at >= ? AND started_at < ?`,
      );

      for (let i = 0; i < days; i++) {
        const dt = new Date(Date.UTC(y, m - 1, d - i));
        const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(dt);
        const { start, end } = dateRangeInTz(dateStr, timezone);

        const row = stmt.get(start, end) as { total_cost_usd: number; total_executions: number };

        result.push({
          date: dateStr,
          totalCostUsd: row.total_cost_usd,
          totalExecutions: row.total_executions,
        });
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // --- get_execution_history ---
  server.tool(
    "get_execution_history",
    "Get recent execution records with optional filtering by status or date",
    {
      limit: z.number().int().min(1).max(50).default(10).describe("Number of records (default 10, max 50)"),
      status: z.string().optional().describe("Filter by status: completed, failed, error, timeout"),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only executions since this date (YYYY-MM-DD) in configured timezone"),
    },
    ({ limit, status, since }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (status) {
        conditions.push("status = ?");
        params.push(status);
      }
      if (since) {
        const { start } = dateRangeInTz(since, timezone);
        conditions.push("started_at >= ?");
        params.push(start);
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const rows = db
        .prepare(
          `SELECT id, model, status, prompt, cost_usd, duration_ms, num_turns, started_at
           FROM executions
           ${where}
           ORDER BY started_at DESC
           LIMIT ?`,
        )
        .all(...params, limit) as Array<{
        id: number;
        model: string | null;
        status: string;
        prompt: string;
        cost_usd: number | null;
        duration_ms: number | null;
        num_turns: number | null;
        started_at: string | null;
      }>;

      const result = rows.map((r) => ({
        id: r.id,
        model: r.model,
        status: r.status,
        prompt:
          r.prompt.length > 100 ? r.prompt.slice(0, 100) + "..." : r.prompt,
        costUsd: r.cost_usd,
        durationMs: r.duration_ms,
        numTurns: r.num_turns,
        startedAt: r.started_at,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // --- get_model_usage ---
  server.tool(
    "get_model_usage",
    "Get usage stats grouped by model: execution count, cost, tokens",
    {
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only executions since this date (YYYY-MM-DD) in configured timezone, defaults to today"),
    },
    ({ since }) => {
      const { start } = dateRangeInTz(since ?? todayInTz(timezone), timezone);

      const rows = db
        .prepare(
          `SELECT
             model,
             COUNT(*) as execution_count,
             COALESCE(SUM(cost_usd), 0) as total_cost_usd,
             AVG(duration_ms) as avg_duration_ms,
             COALESCE(SUM(input_tokens), 0) as total_input_tokens,
             COALESCE(SUM(output_tokens), 0) as total_output_tokens
           FROM executions
           WHERE started_at >= ?
             AND status IN ('completed', 'failed')
           GROUP BY model
           ORDER BY total_cost_usd DESC`,
        )
        .all(start) as Array<{
        model: string | null;
        execution_count: number;
        total_cost_usd: number;
        avg_duration_ms: number | null;
        total_input_tokens: number;
        total_output_tokens: number;
      }>;

      const result = rows.map((r) => ({
        model: r.model,
        executionCount: r.execution_count,
        totalCostUsd: r.total_cost_usd,
        avgDurationMs: r.avg_duration_ms
          ? Math.round(r.avg_duration_ms)
          : null,
        totalInputTokens: r.total_input_tokens,
        totalOutputTokens: r.total_output_tokens,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
