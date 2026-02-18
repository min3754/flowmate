/**
 * @module shared/timezone
 * Timezone-aware date utilities for converting between IANA timezones and UTC ranges.
 */

/** Get today's date in the given IANA timezone as YYYY-MM-DD. */
export function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

/**
 * Convert a date string (YYYY-MM-DD) in the given timezone to a UTC start/end range.
 * Handles DST transitions correctly by computing the actual UTC offset for each boundary.
 *
 * @param dateStr - Date in YYYY-MM-DD format, interpreted in the given timezone
 * @param tz - IANA timezone identifier (e.g. "Asia/Seoul", "UTC")
 * @returns Half-open UTC range [start, end) covering the full day in the given timezone
 */
export function dateRangeInTz(
  dateStr: string,
  tz: string,
): { start: string; end: string } {
  const toUtcEpoch = (localDateStr: string): number => {
    const ref = new Date(`${localDateStr}T12:00:00Z`);
    const utcStr = ref.toLocaleString("en-US", { timeZone: "UTC" });
    const tzStr = ref.toLocaleString("en-US", { timeZone: tz });
    const offsetMs =
      new Date(utcStr).getTime() - new Date(tzStr).getTime();
    return new Date(`${localDateStr}T00:00:00Z`).getTime() - offsetMs;
  };

  const [year, month, day] = dateStr.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
  }).format(nextDate);

  return {
    start: new Date(toUtcEpoch(dateStr)).toISOString(),
    end: new Date(toUtcEpoch(nextDateStr)).toISOString(),
  };
}
