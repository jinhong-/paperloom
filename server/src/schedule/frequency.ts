/**
 * How often a gallery changes its picture.
 *
 * The owner says how often the picture should change, and in what unit:
 * every 30 minutes, every 6 hours, every 5 days. The unit is only for
 * showing: the schedule itself is worked out in seconds.
 *
 * A rule also says which days it applies to, and that puts a limit on how
 * often the picture can change. The picture can only change on the days
 * the rule names, so a rule that changes less often than the run of days
 * it names would leave the picture unchanged for longer than the owner
 * asked for.
 *
 * The limit is the *shortest* run of selected days, because that is the
 * run in which the picture might not change often enough. A rule for
 * Monday to Wednesday and Saturday to Sunday has two runs, three days and
 * two days, and the limit is two days.
 *
 * The week is measured from Monday, so that Saturday and Sunday are one
 * run and not two. The bits the days are stored in follow the calendar,
 * where Sunday is the first day, so the week is walked as a rotation of
 * them rather than in their stored order.
 */

/** The units a frequency can be given in. */
export type FrequencyUnit = "minutes" | "hours" | "days";

/** How many seconds there are in each unit. */
const SECONDS_IN: Record<FrequencyUnit, number> = {
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
};

/** The units, in the order they are offered. */
export const FREQUENCY_UNITS: readonly FrequencyUnit[] = ["minutes", "hours", "days"];

/**
 * The name of a unit, in the singular and the plural.
 */
export function describeUnit(unit: FrequencyUnit, count: number): string {
  if (unit === "minutes") return count === 1 ? "minute" : "minutes";
  if (unit === "hours") return count === 1 ? "hour" : "hours";
  return count === 1 ? "day" : "days";
}

/**
 * Whether a unit is one we know.
 */
export function isFrequencyUnit(value: unknown): value is FrequencyUnit {
  return typeof value === "string" && (FREQUENCY_UNITS as readonly string[]).includes(value);
}

/**
 * The largest number of a unit, so that a frequency is not absurd.
 *
 * A year is longer than any gap anybody wants between two pictures.
 */
const MAX_PER_UNIT: Record<FrequencyUnit, number> = {
  minutes: 60 * 24 * 365,
  hours: 24 * 365,
  days: 365,
};

/**
 * A frequency, in the owner's own terms.
 */
export interface Frequency {
  /** How many units between two pictures. */
  readonly count: number;
  /** The unit the count is in. */
  readonly unit: FrequencyUnit;
}

/**
 * Turn a frequency into seconds.
 */
export function frequencyInSeconds(frequency: Frequency): number {
  return frequency.count * SECONDS_IN[frequency.unit];
}

/**
 * Turn seconds into a frequency, in the largest unit that divides it
 * exactly.
 *
 * This is what makes a frequency read back the way it was given: a gap
 * of three days is shown as three days, not as 4320 minutes.
 */
export function frequencyFromSeconds(seconds: number): Frequency {
  for (const unit of ["days", "hours", "minutes"] as const) {
    if (seconds % SECONDS_IN[unit] === 0 && seconds / SECONDS_IN[unit] >= 1) {
      return { count: seconds / SECONDS_IN[unit], unit };
    }
  }
  return { count: seconds, unit: "minutes" };
}

/**
 * Whether a frequency is sensible.
 *
 * A frequency has to be at least a minute, and it has to be less than a
 * year, and it has to be a whole number of units.
 */
export function validFrequency(frequency: Frequency): boolean {
  if (!Number.isInteger(frequency.count)) return false;
  if (frequency.count < 1) return false;
  if (frequency.count > MAX_PER_UNIT[frequency.unit]) return false;
  return true;
}

/**
 * The bits of the days of the week, in the order the calendar numbers
 * them: Sunday is the first day.
 */
const CALENDAR_BITS = [1, 2, 4, 8, 16, 32, 64] as const;

/**
 * The week as it is walked when runs of days are measured: Monday first.
 *
 * The days are stored in calendar order, so this is a rotation of them
 * rather than a different set.
 */
const RUN_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/**
 * The number of days in the shortest run of selected days.
 *
 * A rule that names every day has a run of seven. A rule that names no
 * days at all has no runs, and so has no limit.
 *
 * @param days A bit mask of the days of the week.
 * @return The length of the shortest run, in days.
 */
export function shortestRun(days: number): number {
  const selected = CALENDAR_BITS.filter((bit) => (days & bit) !== 0);
  if (selected.length === 0) return 0;
  if (selected.length === CALENDAR_BITS.length) return 7;

  const chosen = new Set(selected);
  const lengths: number[] = [];
  let run = 0;

  for (const day of RUN_ORDER) {
    if (chosen.has(CALENDAR_BITS[day]!)) {
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
 * The longest a rule's frequency may be, in seconds.
 *
 * The picture can only change on the days the rule names, so a rule that
 * changes less often than the shortest run of days it names would leave
 * the picture unchanged for longer than the owner asked for.
 *
 * A rule that names no days has no limit: it never applies.
 */
export function frequencyLimit(days: number): number | null {
  const run = shortestRun(days);
  if (run === 0) return null;
  return run * SECONDS_IN.days;
}

/**
 * Whether a frequency is within the limit a rule's days place on it.
 *
 * @param frequency The frequency the rule asks for.
 * @param days      The days the rule applies to.
 */
export function frequencyWithinLimit(frequency: Frequency, days: number): boolean {
  const limit = frequencyLimit(days);
  if (limit === null) return true;
  return frequencyInSeconds(frequency) <= limit;
}

/**
 * The days a rule names, as they are written.
 */
export function describeDays(days: number, names: readonly string[]): string {
  const chosen = CALENDAR_BITS.map((bit, index) =>
    (days & bit) !== 0 ? (names[index] ?? "") : null,
  ).filter((name): name is string => name !== null);

  if (chosen.length === 0) return "no days";
  if (chosen.length === 7) return "every day";
  return chosen.join(", ");
}
