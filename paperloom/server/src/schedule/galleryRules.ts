/**
 * When a gallery changes its picture.
 *
 * A gallery does not have to change at the same rate all day. The rules
 * say which days they apply to, the time of day they cover, and how often
 * the picture changes during that time.
 *
 * The rules belong to the gallery rather than to the frame, because they are
 * about the pictures. The check-in rules are per frame, because they are
 * about the radio.
 *
 * A rule with no interval at all means the gallery is still for that
 * time: nothing is shown, and the panel keeps whatever it has.
 */

import { DAY_BITS, DAY_NAMES } from "./defaults.js";
import { localDayAndMinute } from "./rules.js";

/**
 * One rule about when a gallery changes, and how.
 */
export interface GalleryRule {
  readonly id: number;
  /** Bit mask of the days of the week the rule applies to. */
  readonly days: number;
  /** Minutes from local midnight. */
  readonly startMinute: number;
  /** Minutes from local midnight. */
  readonly endMinute: number;
  /** The smallest gap between two pictures, in seconds. */
  readonly minInterval: number | null;
  /** The largest gap between two pictures, in seconds. */
  readonly maxInterval: number | null;
  /** Lower numbers win when several rules cover the same moment. */
  readonly priority: number;
  /**
   * How the pictures of this rule are picked.
   *
   * In order, so that the gallery is walked through, or at random. It
   * belongs to the rule rather than to the gallery, so that a gallery
   * can show its pictures in order by day and pick them at random at
   * night.
   */
  readonly rotationMode: "random" | "sequential";
}

/**
 * What a rule says about a moment.
 */
export interface RuleAtMoment {
  /** The smallest gap between two pictures, in seconds. Zero means still. */
  readonly min: number;
  /** The largest gap between two pictures, in seconds. */
  readonly max: number;
  /** How the pictures are picked. */
  readonly rotationMode: "random" | "sequential";
}

/**
 * The rule that applies at a moment.
 *
 * The rule with the lowest priority number wins. When no rule covers the
 * moment, the gallery is still: there is nothing to show and nothing to
 * pick.
 *
 * @param rules  The gallery's rules.
 * @param day    The day of the week, 0 for Sunday.
 * @param minute The minute from local midnight.
 */
export function ruleAtMoment(
  rules: readonly GalleryRule[],
  day: number,
  minute: number,
): RuleAtMoment {
  let best: GalleryRule | undefined;

  for (const rule of rules) {
    if (!ruleCovers(rule, day, minute)) continue;

    if (best === undefined) {
      best = rule;
      continue;
    }
    if (rule.priority < best.priority) {
      best = rule;
    }
  }

  if (best === undefined) {
    /* Nothing covers this moment, so the gallery is still. */
    return { min: 0, max: 0, rotationMode: "random" };
  }

  /* A rule with no interval at all means the gallery is still. */
  if (best.minInterval === null && best.maxInterval === null) {
    return { min: 0, max: 0, rotationMode: best.rotationMode };
  }

  const min = best.minInterval ?? 0;
  const max = best.maxInterval ?? min;
  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
    rotationMode: best.rotationMode,
  };
}

/**
 * Whether a rule covers a moment.
 *
 * A rule whose range runs past midnight covers the hours after midnight
 * on the days it names, and the hours before midnight on the days before
 * them.
 */
export function ruleCovers(rule: GalleryRule, day: number, minute: number): boolean {
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
    // previous day, so it is the previous day's name that decides.
    const previousDay = (day + 6) % 7;
    const previousBit = DAY_BITS[previousDay]!;
    return (rule.days & previousBit) !== 0;
  }

  return false;
}

/**
 * The day and minute of a moment, in the frame's own zone.
 */
export function galleryMoment(
  epochMs: number,
  timezone: string,
): { day: number; minute: number } {
  return localDayAndMinute(epochMs, timezone);
}

/**
 * The names of the days, for the management page.
 */
export { DAY_NAMES };
