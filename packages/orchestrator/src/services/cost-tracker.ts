/**
 * @module orchestrator/services/cost-tracker
 * Daily cost aggregation from executions table for budget enforcement.
 * Date boundaries are computed in the configured timezone while DB stores UTC timestamps.
 */

import { sql } from "drizzle-orm";
import type { FlowmateDb } from "@flowmate/db";
import { executions } from "@flowmate/db";
import { todayInTz, dateRangeInTz } from "@flowmate/shared";

/**
 * Computes daily API costs by aggregating from the executions table.
 * Date boundaries use the configured IANA timezone.
 */
export class CostTracker {
  constructor(
    private db: FlowmateDb,
    private timezone: string,
  ) {}

  /**
   * Get the total cost accumulated for a given date in the configured timezone.
   *
   * @param date - Date string (YYYY-MM-DD) in configured timezone. Defaults to today.
   * @returns Total cost in USD
   */
  getDailyCost(date?: string): number {
    const { start, end } = dateRangeInTz(
      date ?? todayInTz(this.timezone),
      this.timezone,
    );
    const row = this.db
      .select({
        total: sql<number>`COALESCE(SUM(${executions.costUsd}), 0)`,
      })
      .from(executions)
      .where(
        sql`${executions.startedAt} >= ${start} AND ${executions.startedAt} < ${end}`,
      )
      .get();
    return row?.total ?? 0;
  }

  /**
   * Check whether the daily budget allows another execution.
   * Reserves `maxBudgetPerTask` to prevent concurrent executions from collectively exceeding the limit.
   *
   * @param dailyLimit - Maximum daily spend in USD
   * @param maxBudgetPerTask - Maximum cost a single execution can incur (used as pessimistic reservation)
   * @returns Whether a new execution is allowed and the remaining budget
   */
  checkBudget(dailyLimit: number, maxBudgetPerTask: number = 0): { allowed: boolean; remaining: number } {
    const used = this.getDailyCost();
    const reserved = this.pendingReservations * maxBudgetPerTask;
    const remaining = Math.max(0, dailyLimit - used - reserved);
    return { allowed: remaining >= maxBudgetPerTask, remaining };
  }

  /** Number of in-flight executions holding budget reservations. */
  private pendingReservations = 0;

  /** Add a budget reservation for an in-flight execution. Returns a release function. */
  reserve(): () => void {
    this.pendingReservations++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.pendingReservations--;
      }
    };
  }
}
