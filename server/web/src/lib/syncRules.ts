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

/**
 * Describe how often a frame checks in, in a way a person can read.
 */
export function describeInterval(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) {
    const hours = seconds / 3600;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  }
  return `${(seconds / 86400).toFixed(1)} days`;
}
