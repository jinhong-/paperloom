/**
 * Helpers for the check-in rules.
 *
 * A rule says which days of the week it applies to, the time of day it
 * covers, and how often the frame should check in during that time.
 */

import { DAY_NAMES } from "@/lib/dayNames";

/** The bit for each day in a rule's day mask. */
export const DAY_BITS = [1, 2, 4, 8, 16, 32, 64] as const;

/** A mask that covers every day of the week. */
export const EVERY_DAY = 127;

/**
 * The days in a mask.
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
 * The mask for a set of days.
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
 * A short label for a rule's days.
 *
 * "Every day", "Weekdays", "Weekends", or the list of days.
 */
export function describeDays(mask: number): string {
  const days = maskDays(mask);
  if (days.length === 7) return "Every day";
  if (days.length === 0) return "Never";

  const isWeekdays = days.join(",") === "1,2,3,4,5";
  if (isWeekdays) return "Weekdays";
  const isWeekend = days.join(",") === "0,6";
  if (isWeekend) return "Weekends";

  return days.map((day) => DAY_NAMES[day]!.slice(0, 3)).join(", ");
}

/**
 * Format a minute-of-day as a clock time.
 *
 * The clock is always 24-hour, whatever the browser's locale says. The
 * server, the firmware and the rules are all 24-hour, and a page that
 * mixed the two would show "08:00-22:00" next to "10:00 pm" for the
 * same rule.
 */
export function formatMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const mins = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/**
 * Parse a clock time into minutes from midnight.
 *
 * Only the 24-hour form is accepted, so that what a person types and what
 * the page shows are the same thing.
 */
export function parseMinute(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 24 || mins > 59) return null;
  return hours * 60 + mins;
}

/**
 * Count something with a unit, in a way that reads as English.
 *
 * "1 hour", "5 minutes", "1.5 hours". The unit is spelled out so that the
 * list of rules reads as one piece of English rather than as a table of
 * abbreviations.
 */
export function countWithUnit(value: number, unit: string): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text} ${value === 1 ? unit : `${unit}s`}`;
}

/**
 * Describe how often a frame checks in, in a way a person can read.
 *
 * The same unit is used everywhere: seconds below a minute, minutes below
 * an hour, hours below a day, and days above that.
 */
export function describeInterval(seconds: number): string {
  if (seconds < 60) return countWithUnit(seconds, "second");
  if (seconds < 3600) return countWithUnit(seconds / 60, "minute");
  if (seconds < 86400) return countWithUnit(seconds / 3600, "hour");
  return countWithUnit(seconds / 86400, "day");
}
