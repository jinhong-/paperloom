/**
 * Tests for the time-based check-in rules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EVERY_DAY,
  daysMask,
  formatMinute,
  localDayAndMinute,
  maskDays,
  parseMinute,
  resolveInterval,
  ruleCovers,
  type SyncRule,
} from "./rules.js";

/**
 * A rule with sensible defaults.
 */
function rule(overrides: Partial<SyncRule> = {}): SyncRule {
  return {
    id: 1,
    days: EVERY_DAY,
    startMinute: 0,
    endMinute: 1440,
    syncInterval: 3600,
    priority: 0,
    ...overrides,
  };
}

test("a rule that covers the whole day covers every moment", () => {
  const all = rule();
  assert.equal(ruleCovers(all, 0, 0), true);
  assert.equal(ruleCovers(all, 3, 720), true);
  assert.equal(ruleCovers(all, 6, 1439), true);
});

test("a rule only covers the days it names", () => {
  const weekdays = rule({ days: daysMask([1, 2, 3, 4, 5]) });
  assert.equal(ruleCovers(weekdays, 1, 600), true, "Monday");
  assert.equal(ruleCovers(weekdays, 5, 600), true, "Friday");
  assert.equal(ruleCovers(weekdays, 0, 600), false, "Sunday");
  assert.equal(ruleCovers(weekdays, 6, 600), false, "Saturday");
});

test("a rule only covers the hours it names", () => {
  const daytime = rule({ startMinute: 8 * 60, endMinute: 22 * 60 });
  assert.equal(ruleCovers(daytime, 1, 8 * 60), true, "the start is included");
  assert.equal(ruleCovers(daytime, 1, 21 * 60 + 59), true);
  assert.equal(ruleCovers(daytime, 1, 7 * 60 + 59), false);
  assert.equal(ruleCovers(daytime, 1, 22 * 60), false, "the end is excluded");
});

test("a rule that runs past midnight covers the small hours of the next day", () => {
  // 22:00 to 08:00, every day.
  const night = rule({ startMinute: 22 * 60, endMinute: 8 * 60 });
  assert.equal(ruleCovers(night, 1, 23 * 60), true, "late evening");
  assert.equal(ruleCovers(night, 2, 3 * 60), true, "small hours");
  assert.equal(ruleCovers(night, 2, 12 * 60), false, "middle of the day");
});

test("a night rule on weekdays does not cover the weekend", () => {
  // 22:00 to 08:00, Monday to Friday.
  const night = rule({
    days: daysMask([1, 2, 3, 4, 5]),
    startMinute: 22 * 60,
    endMinute: 8 * 60,
  });
  // 03:00 on Saturday belongs to Friday night, which is a weekday.
  assert.equal(ruleCovers(night, 6, 3 * 60), true);
  // 03:00 on Sunday belongs to Saturday night, which is not.
  assert.equal(ruleCovers(night, 0, 3 * 60), false);
});

test("no rule means there is nothing to check in for", () => {
  const daytime = rule({ startMinute: 8 * 60, endMinute: 22 * 60 });
  // Three in the morning: the rule does not cover it.
  assert.equal(resolveInterval([daytime], 1, 3 * 60), null);
  // Noon: the rule covers it.
  assert.equal(resolveInterval([daytime], 1, 12 * 60), 3600);
  // No rules at all.
  assert.equal(resolveInterval([], 1, 12 * 60), null);
});

test("the lower priority number wins", () => {
  const rules = [
    rule({ id: 1, syncInterval: 60, priority: 5 }),
    rule({ id: 2, syncInterval: 600, priority: 1 }),
  ];
  assert.equal(resolveInterval(rules, 1, 600), 600);
});

test("the more specific rule wins when the priorities are equal", () => {
  const rules = [
    // Every day, all day.
    rule({ id: 1, days: EVERY_DAY, syncInterval: 1800 }),
    // Weekdays only, during the working day.
    rule({
      id: 2,
      days: daysMask([1, 2, 3, 4, 5]),
      startMinute: 8 * 60,
      endMinute: 22 * 60,
      syncInterval: 300,
    }),
  ];

  // A weekday at noon: the weekday rule is more specific.
  assert.equal(resolveInterval(rules, 1, 12 * 60), 300);
  // A Saturday at noon: only the all-day rule applies.
  assert.equal(resolveInterval(rules, 6, 12 * 60), 1800);
});

test("a day mask round-trips", () => {
  const mask = daysMask([1, 3, 5]);
  assert.deepEqual(maskDays(mask), [1, 3, 5]);
  assert.deepEqual(maskDays(EVERY_DAY), [0, 1, 2, 3, 4, 5, 6]);
});

test("a clock time round-trips", () => {
  assert.equal(formatMinute(0), "00:00");
  assert.equal(formatMinute(8 * 60 + 30), "08:30");
  assert.equal(parseMinute("08:30"), 8 * 60 + 30);
  assert.equal(parseMinute("not a time"), null);
  assert.equal(parseMinute("25:00"), null);
});

test("the local day and minute follow the time zone", () => {
  // 2026-01-07T12:00:00Z is a Wednesday at 13:00 in Berlin.
  const moment = Date.parse("2026-01-07T12:00:00Z");

  const berlin = localDayAndMinute(moment, "Europe/Berlin");
  assert.equal(berlin.day, 3, "Wednesday");
  assert.equal(berlin.minute, 13 * 60);

  const utc = localDayAndMinute(moment, "UTC");
  assert.equal(utc.day, 3);
  assert.equal(utc.minute, 12 * 60);
});
