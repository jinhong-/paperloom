import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ruleAtMoment, ruleCovers, type GalleryRule } from "./galleryRules.js";

const rule = (over: Partial<GalleryRule> = {}): GalleryRule => ({
  id: 1,
  days: 127,
  startMinute: 0,
  endMinute: 1440,
  minInterval: null,
  maxInterval: null,
  priority: 0,
  rotationMode: "random",
  ...over,
});

describe("gallery rules", () => {
  it("covers the whole day when the range is the whole day", () => {
    assert.equal(ruleCovers(rule(), 3, 0), true);
    assert.equal(ruleCovers(rule(), 3, 1439), true);
  });

  it("covers only the hours it names", () => {
    const night = rule({ startMinute: 1320, endMinute: 480 });
    // The late evening is covered.
    assert.equal(ruleCovers(night, 3, 1380), true);
    // The small hours are covered.
    assert.equal(ruleCovers(night, 3, 60), true);
    // The middle of the day is not.
    assert.equal(ruleCovers(night, 3, 720), false);
  });

  it("is still when no rule covers the moment", () => {
    const gap = ruleAtMoment([], 3, 720);
    assert.equal(gap.min, 0);
    assert.equal(gap.max, 0);
  });

  it("uses the rule's interval when one covers the moment", () => {
    const slow = rule({ startMinute: 1320, endMinute: 480, minInterval: 3600, maxInterval: 3600 });
    const gap = ruleAtMoment([slow], 3, 60);
    assert.equal(gap.min, 3600);
    assert.equal(gap.max, 3600);
  });

  it("makes the gallery still when a rule has no interval", () => {
    const still = rule({ startMinute: 0, endMinute: 360 });
    const gap = ruleAtMoment([still], 3, 60);
    assert.equal(gap.min, 0);
    assert.equal(gap.max, 0);
  });

  it("prefers the rule with the lower priority number", () => {
    const first = rule({ id: 1, priority: 0, minInterval: 600, maxInterval: 600 });
    const second = rule({ id: 2, priority: 1, minInterval: 3600, maxInterval: 3600 });
    const gap = ruleAtMoment([second, first], 3, 60);
    assert.equal(gap.min, 600);
  });

  it("says how the pictures are picked", () => {
    /* A gallery can show its pictures in order by day and pick them at
     * random at night, because each rule says how its pictures are
     * picked. */
    const inOrder = rule({
      id: 1,
      priority: 0,
      startMinute: 0,
      endMinute: 720,
      minInterval: 3600,
      maxInterval: 3600,
      rotationMode: "sequential",
    });
    const atRandom = rule({
      id: 2,
      priority: 1,
      startMinute: 720,
      endMinute: 1440,
      minInterval: 3600,
      maxInterval: 3600,
      rotationMode: "random",
    });

    const byDay = ruleAtMoment([inOrder, atRandom], 3, 600);
    assert.equal(byDay.rotationMode, "sequential", "the daytime rule walks the gallery");

    const byNight = ruleAtMoment([inOrder, atRandom], 3, 900);
    assert.equal(byNight.rotationMode, "random", "the evening rule picks at random");
  });
});
