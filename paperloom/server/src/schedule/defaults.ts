/**
 * The check-in rules a new frame starts with.
 *
 * There is no default interval: a frame that no rule covers has nothing
 * to check in for, and sleeps until a rule covers the time again. A
 * frame therefore comes with rules already set, and these are the ones
 * it gets.
 *
 * They are also the rules the management page offers when adding one,
 * so that the frame and the page agree about what a sensible rule is.
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
 * A rule that a new frame starts with.
 */
export interface DefaultRule {
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
 * The rules a new frame starts with.
 *
 * The first is for the hours when somebody is likely to be looking at
 * the frame, and the frame is responsive then. The second is for the
 * rest of the day and the small hours, when every check-in costs power
 * and nothing is being watched.
 */
export const DEFAULT_RULES: readonly DefaultRule[] = [
  { days: EVERY_DAY, startMinute: 8 * 60, endMinute: 22 * 60, syncInterval: 300, priority: 0 },
  { days: EVERY_DAY, startMinute: 22 * 60, endMinute: 8 * 60, syncInterval: 3600, priority: 1 },
];
