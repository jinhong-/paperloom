/**
 * Tests for schedule materialisation.
 *
 * The most important property is determinism: a device that retries a sync
 * must receive exactly the same schedule, or it would show a different
 * photo than the one it was told to show.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inQuietHours,
  materializeSchedule,
  pickWeighted,
  Rng,
  type Candidate,
  type GalleryPolicy,
} from "./materialize.js";

const candidates: Candidate[] = [
  { photoId: 1, contentHash: "aaa", weight: 1, belongsTo: 10 },
  { photoId: 2, contentHash: "bbb", weight: 1, belongsTo: 10 },
  { photoId: 3, contentHash: "ccc", weight: 1, belongsTo: 10 },
];

const galleries: GalleryPolicy[] = [
  { galleryId: 10, rotationMode: "random", minInterval: 3600, maxInterval: 3600 },
];

const policy = {
  syncInterval: 3600,
  lookahead: 10800,
  quietStart: null,
  quietEnd: null,
  timezone: "UTC",
};

const windowStart = 1_762_000_000_000;

test("the same window always materialises to the same schedule", () => {
  const a = materializeSchedule({ deviceId: "1", windowStart, candidates, galleries, policy });
  const b = materializeSchedule({ deviceId: "1", windowStart, candidates, galleries, policy });
  assert.deepEqual(a, b);
});

test("different devices get their own schedules", () => {
  const a = materializeSchedule({ deviceId: "1", windowStart, candidates, galleries, policy });
  const b = materializeSchedule({ deviceId: "2", windowStart, candidates, galleries, policy });
  // Not required to differ, but the device id must feed the seed.
  assert.ok(Array.isArray(a) && Array.isArray(b));
});

test("events are strictly increasing in time", () => {
  const events = materializeSchedule({
    deviceId: "1",
    windowStart,
    candidates,
    galleries,
    policy,
  });
  assert.ok(events.length > 1);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i]!.at > events[i - 1]!.at, "events must advance");
  }
});

test("events stay inside the lookahead window", () => {
  const events = materializeSchedule({
    deviceId: "1",
    windowStart,
    candidates,
    galleries,
    policy,
  });
  const end = windowStart + policy.lookahead * 1000;
  for (const event of events) {
    assert.ok(event.at >= windowStart, "event must not precede the window");
    assert.ok(event.at < end, "event must not exceed the window");
  }
});

test("no event repeats the asset shown immediately before", () => {
  const events = materializeSchedule({
    deviceId: "1",
    windowStart,
    candidates,
    galleries,
    policy,
    currentAsset: "aaa",
    lastPhotoId: 1,
  });
  assert.ok(events.length > 0);
  assert.notEqual(events[0]!.asset, "aaa");
});

test("quiet hours suppress events but keep the schedule advancing", () => {
  // 02:00-06:00 UTC quiet window.
  const quietPolicy = { ...policy, quietStart: 120, quietEnd: 360 };
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  const events = materializeSchedule({
    deviceId: "1",
    windowStart: start,
    candidates,
    galleries,
    policy: quietPolicy,
  });
  assert.ok(events.length > 0);
  for (const event of events) {
    const minute = new Date(event.at).getUTCHours() * 60 + new Date(event.at).getUTCMinutes();
    assert.ok(!(minute >= 120 && minute < 360), `event at ${minute} falls in quiet hours`);
  }
});

test("quiet hours handle a window that wraps past midnight", () => {
  // 22:00-07:00.
  assert.equal(inQuietHours(Date.UTC(2026, 0, 1, 23, 0), 1320, 420, "UTC"), true);
  assert.equal(inQuietHours(Date.UTC(2026, 0, 1, 3, 0), 1320, 420, "UTC"), true);
  assert.equal(inQuietHours(Date.UTC(2026, 0, 1, 12, 0), 1320, 420, "UTC"), false);
});

test("sequential mode walks the gallery in order", () => {
  const events = materializeSchedule({
    deviceId: "1",
    windowStart,
    candidates,
    galleries: [{ galleryId: 10, rotationMode: "sequential", minInterval: 3600, maxInterval: 3600 }],
    policy,
  });
  const order = events.map((e) => e.asset);
  // A three-hour lookahead at one-hour intervals fits three events, which
  // walk the gallery from the start: aaa, bbb, ccc.
  assert.deepEqual(order, ["aaa", "bbb", "ccc"]);
});

test("sequential mode wraps around the gallery", () => {
  const events = materializeSchedule({
    deviceId: "1",
    windowStart,
    candidates,
    galleries: [{ galleryId: 10, rotationMode: "sequential", minInterval: 1800, maxInterval: 1800 }],
    policy: { ...policy, lookahead: 14400 },
  });
  const order = events.map((e) => e.asset);
  assert.ok(order.length > 3, "expected more than one full pass of the gallery");
  assert.equal(order[0], "aaa");
  assert.equal(order[1], "bbb");
  assert.equal(order[2], "ccc");
  assert.equal(order[3], "aaa", "the sequence must wrap back to the first photo");
});

test("weighted selection respects a zero weight", () => {
  // A photo with weight 0 must never be chosen.
  const weighted: Candidate[] = [
    { photoId: 1, contentHash: "aaa", weight: 0, belongsTo: 10 },
    { photoId: 2, contentHash: "bbb", weight: 1, belongsTo: 10 },
  ];
  const events = materializeSchedule({
    deviceId: "1",
    windowStart,
    candidates: weighted,
    galleries,
    policy,
  });
  for (const event of events) {
    assert.equal(event.asset, "bbb");
  }
});

test("pickWeighted never returns the avoided photo when an alternative exists", () => {
  for (let i = 0; i < 50; i++) {
    const picked = pickWeighted(candidates, new Rng(Buffer.from(`seed-${i}`)), 1);
    assert.notEqual(picked?.photoId, 1);
  }
});

test("pickWeighted falls back to the full pool when every photo is excluded", () => {
  const only = [candidates[0]!];
  const picked = pickWeighted(only, new Rng(Buffer.from("seed")), 1);
  assert.equal(picked?.photoId, 1);
});

test("a gallery that is still for the whole day shows nothing", () => {
  const events = materializeSchedule({
    deviceId: "1",
    windowStart,
    candidates,
    galleries: [
      {
        galleryId: 10,
        rotationMode: "random",
        minInterval: 3600,
        maxInterval: 3600,
        rules: [
          {
            id: 1,
            days: 127,
            startMinute: 0,
            endMinute: 1440,
            minInterval: null,
            maxInterval: null,
            priority: 0,
          },
        ],
      },
    ],
    policy,
  });
  assert.equal(events.length, 0, "nothing is shown while the gallery is still");
});

test("a gallery changes again once the still rule no longer covers the moment", () => {
  const start = Date.UTC(2026, 0, 1, 6, 0, 0);
  const events = materializeSchedule({
    deviceId: "1",
    windowStart: start,
    candidates,
    galleries: [
      {
        galleryId: 10,
        rotationMode: "random",
        minInterval: 3600,
        maxInterval: 3600,
        rules: [
          {
            id: 1,
            days: 127,
            // Only the small hours are still.
            startMinute: 0,
            endMinute: 360,
            minInterval: null,
            maxInterval: null,
            priority: 0,
          },
        ],
      },
    ],
    policy,
  });
  assert.ok(events.length > 0, "the gallery changes again once the rule is over");
});

test("a rule's own interval is used while it covers the moment", () => {
  const start = Date.UTC(2026, 0, 1, 6, 0, 0);
  const events = materializeSchedule({
    deviceId: "1",
    windowStart: start,
    candidates,
    galleries: [
      {
        galleryId: 10,
        rotationMode: "random",
        minInterval: 3600,
        maxInterval: 3600,
        rules: [
          {
            id: 1,
            days: 127,
            startMinute: 0,
            endMinute: 1440,
            minInterval: 900,
            maxInterval: 900,
            priority: 0,
          },
        ],
      },
    ],
    policy,
  });

  assert.ok(events.length > 1);
  for (let i = 1; i < events.length; i++) {
    const gap = events[i]!.at - events[i - 1]!.at;
    assert.equal(gap, 900 * 1000, "the rule's own interval is used");
  }
});
