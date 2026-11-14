import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { galleryIntervalAt, ruleCovers, type GalleryRule } from "./galleryRules.js";

const rule = (over: Partial<GalleryRule> = {}): GalleryRule => ({
  id: 1,
  days: 127,
  startMinute: 0,
  endMinute: 1440,
  minInterval: null,
  maxInterval: null,
  priority: 0,
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

  it("uses the gallery's own interval when no rule covers the moment", () => {
    const gap = galleryIntervalAt([], 120, 300, 3, 720);
    assert.equal(gap.min, 120);
    assert.equal(gap.max, 300);
  });

  it("uses the rule's interval when one covers the moment", () => {
    const slow = rule({ startMinute: 1320, endMinute: 480, minInterval: 3600, maxInterval: 3600 });
    const gap = galleryIntervalAt([slow], 120, 300, 3, 60);
    assert.equal(gap.min, 3600);
    assert.equal(gap.max, 3600);
  });

  it("makes the gallery still when a rule has no interval", () => {
    const still = rule({ startMinute: 0, endMinute: 360 });
    const gap = galleryIntervalAt([still], 120, 300, 3, 60);
    assert.equal(gap.min, 0);
    assert.equal(gap.max, 0);
  });

  it("prefers the rule with the lower priority number", () => {
    const first = rule({ id: 1, priority: 0, minInterval: 600, maxInterval: 600 });
    const second = rule({ id: 2, priority: 1, minInterval: 3600, maxInterval: 3600 });
    const gap = galleryIntervalAt([second, first], 120, 300, 3, 60);
    assert.equal(gap.min, 600);
  });
});
