/**
 * How often a gallery changes its picture.
 *
 * The owner says how often, and in what unit: every 30 minutes, every 6
 * hours, every 5 days. The unit is only for showing; the schedule itself
 * is worked out in seconds by the server.
 *
 * The server also works out the limit a rule's days place on the
 * frequency: the picture can only change on the days the rule names, so
 * a rule that changed less often than the run of days it names would
 * leave the picture unchanged for longer than the owner asked for. The
 * limit is the *shortest* run of selected days.
 */

/** The units a frequency can be given in. */
export type FrequencyUnit = "minutes" | "hours" | "days";

/** The units, in the order they are offered. */
export const FREQUENCY_UNITS: readonly FrequencyUnit[] = ["minutes", "hours", "days"];

/** How many seconds there are in each unit. */
const SECONDS_IN: Record<FrequencyUnit, number> = {
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
};

/**
 * The bit for each day, in the order the calendar numbers them.
 */
const DAY_BITS = [1, 2, 4, 8, 16, 32, 64] as const;

/**
 * The week as it is walked when runs of days are measured: Monday first.
 *
 * The days are stored in calendar order, so this is a rotation of them
 * rather than a different set.
 */
const RUN_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/**
 * Turn a frequency into seconds.
 */
export function frequencyInSeconds(count: number, unit: FrequencyUnit): number {
  return count * SECONDS_IN[unit];
}

/**
 * Turn seconds into a frequency, in the largest unit that divides it
 * exactly.
 */
export function frequencyFromSeconds(seconds: number): { count: number; unit: FrequencyUnit } {
  for (const unit of ["days", "hours", "minutes"] as const) {
    if (seconds % SECONDS_IN[unit] === 0 && seconds / SECONDS_IN[unit] >= 1) {
      return { count: seconds / SECONDS_IN[unit], unit };
    }
  }
  return { count: seconds, unit: "minutes" };
}

/**
 * The number of days in the shortest run of selected days.
 *
 * @param days A bit mask of the days of the week.
 */
export function shortestRun(days: number): number {
  const selected = DAY_BITS.filter((bit) => (days & bit) !== 0);
  if (selected.length === 0) return 0;
  if (selected.length === DAY_BITS.length) return 7;

  const chosen = new Set(selected);
  const lengths: number[] = [];
  let run = 0;

  for (const day of RUN_ORDER) {
    if (chosen.has(DAY_BITS[day]!)) {
      run += 1;
    } else {
      if (run > 0) lengths.push(run);
      run = 0;
    }
  }
  if (run > 0) lengths.push(run);

  return Math.min(...lengths);
}

/**
 * The longest a frequency may be, in seconds.
 *
 * @param days A bit mask of the days of the week.
 */
export function frequencyLimit(days: number): number | null {
  const run = shortestRun(days);
  if (run === 0) return null;
  return run * SECONDS_IN.days;
}

/**
 * Whether a frequency is within the limit the days place on it.
 */
export function frequencyWithinLimit(count: number, unit: FrequencyUnit, days: number): boolean {
  const limit = frequencyLimit(days);
  if (limit === null) return true;
  return frequencyInSeconds(count, unit) <= limit;
}

/**
 * The name of a unit, in the singular and the plural.
 */
export function describeUnit(unit: FrequencyUnit, count: number): string {
  if (unit === "minutes") return count === 1 ? "minute" : "minutes";
  if (unit === "hours") return count === 1 ? "hour" : "hours";
  return count === 1 ? "day" : "days";
}
