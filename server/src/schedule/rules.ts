/**
 * Time-based check-in rules.
 *
 * A frame does not need to check in at the same rate all day. During the
 * hours when somebody is around, it can be responsive: a photo scheduled
 * for 09:15 shows up within a minute or two of when it should. Overnight
 * nobody is watching, and every check-in costs power, so the frame can
 * wait an hour between them.
 *
 * A rule says which days of the week it applies to, the time of day it
 * covers, and how often the frame should check in during that time. The
 * device's single `sync_interval` is the fallback for any moment that no
 * rule covers.
 */

/** The days of the week, as the server stores them. */
export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The bit for each day in a rule's day mask. */
export const DAY_BITS = [1, 2, 4, 8, 16, 32, 64] as const;

/** A mask that covers every day of the week. */
export const EVERY_DAY = 127;

/**
 * One check-in rule.
 */
export interface SyncRule {
  readonly id: number;
  /** Bit mask of the days the rule applies to. */
  readonly days: number;
  /** Minutes from local midnight. */
  readonly startMinute: number;
  /** Minutes from local midnight. */
  readonly endMinute: number;
  /** How often the frame should check in during this time, in seconds. */
  readonly syncInterval: number;
  /** Lower numbers win when several rules cover the same moment. */
  readonly priority: number;
}

/**
 * The mask for a set of day numbers.
 *
 * The day numbers follow `Date.getDay()`: 0 is Sunday.
 */
export function daysMask(days: readonly number[]): number {
  let mask = 0;
  for (const day of days) {
    if (day >= 0 && day < 7) {
      mask |= DAY_BITS[day]!;
    }
  }
  return mask;
}

/**
 * The day numbers in a mask.
 */
export function maskDays(mask: number): number[] {
  const days: number[] = [];
  for (let day = 0; day < 7; day++) {
    if ((mask & DAY_BITS[day]!) !== 0) {
      days.push(day);
    }
  }
  return days;
}

/**
 * Whether a rule covers a moment.
 *
 * A rule whose range runs past midnight covers the hours after midnight
 * on the days it names, and the hours before midnight on the days before
 * them.
 *
 * @param rule    The rule.
 * @param day     The day of the week, 0 for Sunday.
 * @param minute  Minutes from local midnight.
 */
export function ruleCovers(rule: SyncRule, day: number, minute: number): boolean {
  const dayBit = DAY_BITS[day];
  if (dayBit === undefined) return false;

  const start = rule.startMinute;
  const end = rule.endMinute;

  if (start === end) {
    // A rule with no span covers the whole day.
    return (rule.days & dayBit) !== 0;
  }

  if (start < end) {
    // A rule within a single day.
    if ((rule.days & dayBit) === 0) return false;
    return minute >= start && minute < end;
  }

  // The range runs past midnight.
  if (minute >= start) {
    // The late evening, on a day the rule names.
    return (rule.days & dayBit) !== 0;
  }
  if (minute < end) {
    // The small hours. These belong to the night that began on the
    // previous day, so it is the previous day's name that decides whether
    // the rule applies.
    const previousDay = (day + 6) % 7;
    const previousBit = DAY_BITS[previousDay]!;
    return (rule.days & previousBit) !== 0;
  }

  return false;
}

/**
 * How specific a rule is.
 *
 * A rule that names one day and a short window is more specific than one
 * that covers every day and the whole of it. When two rules cover the
 * same moment and have the same priority, the more specific one wins,
 * which is what an owner means when they add a weekday rule to go with
 * an all-day one.
 *
 * A lower number is more specific.
 */
function specificity(rule: SyncRule): number {
  const days = maskDays(rule.days).length;
  const span = rule.endMinute >= rule.startMinute
    ? rule.endMinute - rule.startMinute
    : 1440 - rule.startMinute + rule.endMinute;

  // The window matters most: a rule covering a few hours says more about
  // the moment than one covering all day. Within that, naming fewer days
  // says more than naming every day.
  return span * 8 + (7 - days);
}

/**
 * The check-in interval that applies at a moment.
 *
 * When several rules cover the same moment, the one with the lowest
 * priority number wins, so the owner can say "this rule overrides that
 * one" without having to make the rules non-overlapping. Rules with the
 * same priority are settled by how specific they are.
 *
 * @param rules   The device's rules.
 * @param day     The day of the week, 0 for Sunday.
 * @param minute  Minutes from local midnight.
 * @param fallback The interval to use when no rule covers the moment.
 */
export function resolveInterval(
  rules: readonly SyncRule[],
  day: number,
  minute: number,
  fallback: number,
): number {
  let best: SyncRule | undefined;

  for (const rule of rules) {
    if (!ruleCovers(rule, day, minute)) continue;
    if (best === undefined) {
      best = rule;
      continue;
    }
    if (rule.priority < best.priority) {
      best = rule;
    } else if (rule.priority === best.priority && specificity(rule) < specificity(best)) {
      best = rule;
    }
  }

  return best ? best.syncInterval : fallback;
}

/**
 * The local day and minute for a timestamp.
 *
 * We use the device's timezone via `Intl`, which keeps the server free of
 * a timezone database dependency.
 */
export function localDayAndMinute(
  epochMs: number,
  timezone = "UTC",
): { day: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = formatter.formatToParts(new Date(epochMs));

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";

  // Intl gives the short name ("Wed"); the day names here are the full
  // ones, so the lookup is by the first three letters.
  const day = DAY_NAMES.findIndex((name) => name.startsWith(weekday));
  return { day: day < 0 ? 0 : day, minute: (hour % 24) * 60 + minute };
}

/**
 * Format a minute-of-day as a clock time.
 */
export function formatMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const mins = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/**
 * Parse a clock time into minutes from midnight.
 */
export function parseMinute(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 24 || mins > 59) return null;
  return hours * 60 + mins;
}
