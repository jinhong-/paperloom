import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  describeUnit,
  frequencyFromSeconds,
  frequencyInSeconds,
  frequencyLimit,
  frequencyWithinLimit,
  shortestRun,
  validFrequency,
  type Frequency,
} from "./frequency.js";

/**
 * A bit mask of the days of the week.
 *
 * The days are numbered as the calendar numbers them: Sunday is the
 * first day.
 */
const mask = (...days: number[]): number =>
  days.reduce((bits, day) => bits | (1 << day), 0);

const SUNDAY = 0;
const MONDAY = 1;
const TUESDAY = 2;
const WEDNESDAY = 3;
const THURSDAY = 4;
const FRIDAY = 5;
const SATURDAY = 6;

describe("the runs of days a rule names", () => {
  it("counts a run of weekdays as five days", () => {
    assert.equal(
      shortestRun(mask(MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY)),
      5,
    );
  });

  it("counts the weekend as two days", () => {
    assert.equal(shortestRun(mask(SATURDAY, SUNDAY)), 2);
  });

  it("takes the shortest of several runs", () => {
    /* Monday to Wednesday is three days, and Saturday to Sunday is two.
     * The two days decide, because that is the run in which the picture
     * might not change often enough. */
    assert.equal(
      shortestRun(mask(MONDAY, TUESDAY, WEDNESDAY, SATURDAY, SUNDAY)),
      2,
    );
  });

  it("counts a week as seven days", () => {
    assert.equal(shortestRun(127), 7);
  });

  it("counts days that are not joined as one day each", () => {
    assert.equal(shortestRun(mask(MONDAY, WEDNESDAY)), 1);
  });

  it("counts the end of the week and the start of it as separate", () => {
    /* The week is measured from Monday, so Saturday and Sunday are one
     * run and Monday is another. */
    assert.equal(shortestRun(mask(SATURDAY, SUNDAY, MONDAY)), 1);
  });

  it("has no runs when no days are named", () => {
    assert.equal(shortestRun(0), 0);
  });
});

describe("the limit a rule's days place on its frequency", () => {
  it("allows a change every day for a rule that names every day", () => {
    assert.equal(frequencyLimit(127), 7 * 24 * 60 * 60);
  });

  it("allows a change every five days for a rule that names the weekdays", () => {
    const weekdays = mask(MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY);
    assert.equal(frequencyLimit(weekdays), 5 * 24 * 60 * 60);
  });

  it("limits a rule to the shortest of its runs", () => {
    const days = mask(MONDAY, TUESDAY, WEDNESDAY, SATURDAY, SUNDAY);
    assert.equal(frequencyLimit(days), 2 * 24 * 60 * 60);
  });

  it("has no limit for a rule that names no days", () => {
    assert.equal(frequencyLimit(0), null);
  });

  it("refuses a frequency longer than the limit", () => {
    const weekdays = mask(MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY);

    assert.equal(
      frequencyWithinLimit({ count: 5, unit: "days" }, weekdays),
      true,
      "every five days is within a five day limit",
    );
    assert.equal(
      frequencyWithinLimit({ count: 6, unit: "days" }, weekdays),
      false,
      "every six days is beyond a five day limit",
    );
  });

  it("allows a frequency well within the limit", () => {
    const weekdays = mask(MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY);
    assert.equal(frequencyWithinLimit({ count: 1, unit: "days" }, weekdays), true);
    assert.equal(frequencyWithinLimit({ count: 30, unit: "minutes" }, weekdays), true);
  });
});

describe("a frequency", () => {
  it("is measured in seconds", () => {
    assert.equal(frequencyInSeconds({ count: 30, unit: "minutes" }), 1800);
    assert.equal(frequencyInSeconds({ count: 6, unit: "hours" }), 21600);
    assert.equal(frequencyInSeconds({ count: 5, unit: "days" }), 432000);
  });

  it("is read back in the largest unit that fits it exactly", () => {
    assert.deepEqual(frequencyFromSeconds(432000), { count: 5, unit: "days" });
    assert.deepEqual(frequencyFromSeconds(21600), { count: 6, unit: "hours" });
    assert.deepEqual(frequencyFromSeconds(1800), { count: 30, unit: "minutes" });
  });

  it("round-trips through seconds", () => {
    const frequencies: Frequency[] = [
      { count: 1, unit: "minutes" },
      { count: 30, unit: "minutes" },
      { count: 12, unit: "hours" },
      { count: 5, unit: "days" },
      { count: 30, unit: "days" },
    ];
    for (const frequency of frequencies) {
      assert.deepEqual(frequencyFromSeconds(frequencyInSeconds(frequency)), frequency);
    }
  });

  it("has to be a whole number of units", () => {
    assert.equal(validFrequency({ count: 1.5, unit: "hours" }), false);
    assert.equal(validFrequency({ count: 2, unit: "hours" }), true);
  });

  it("has to be at least a minute and less than a year", () => {
    assert.equal(validFrequency({ count: 0, unit: "minutes" }), false);
    assert.equal(validFrequency({ count: -1, unit: "minutes" }), false);
    assert.equal(validFrequency({ count: 1, unit: "minutes" }), true);
    assert.equal(validFrequency({ count: 366, unit: "days" }), false);
    assert.equal(validFrequency({ count: 365, unit: "days" }), true);
  });

  it("is named in the singular when it is one", () => {
    assert.equal(describeUnit("days", 1), "day");
    assert.equal(describeUnit("days", 5), "days");
    assert.equal(describeUnit("hours", 1), "hour");
    assert.equal(describeUnit("hours", 6), "hours");
    assert.equal(describeUnit("minutes", 1), "minute");
    assert.equal(describeUnit("minutes", 30), "minutes");
  });
});
