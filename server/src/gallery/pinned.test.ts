/**
 * Test of pinned photos.
 *
 * A picture sent from a chat is pinned to the next check-in of each frame
 * showing its gallery, so that it is shown on the next wake rather than
 * waiting for its turn in the rotation.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

import { openDatabase, type Db } from "../db/index.js";
import { GalleryPhotoService } from "../gallery/photos.js";
import { PinnedPhotoService } from "../gallery/pinned.js";
import { AssetStore } from "../assets/store.js";
import { ScheduleService } from "../schedule/service.js";
import { materializeSchedule } from "../schedule/materialize.js";
import type { Candidate, GalleryPolicy } from "../schedule/materialize.js";
import { generateKeyPair, publicKeyToBase64, signRequest } from "../auth/signing.js";
import { buildServer, type BuiltServer } from "../index.js";
import type { SyncResponse } from "../api/device.js";

/**
 * A server-side world with a gallery, a frame and a picture.
 */
interface World {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly schedules: ScheduleService;
  readonly pins: PinnedPhotoService;
  readonly photos: GalleryPhotoService;
  readonly galleryId: number;
  readonly deviceId: number;
}

async function makeWorld(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "paperloom-pin-"));
  const db = openDatabase({ path: join(dir, "paperloom.db") });

  const assets = new AssetStore(db, join(dir, "assets"), join(dir, "sources"));
  const schedules = new ScheduleService(db, assets);
  const pins = new PinnedPhotoService({ db, schedules });
  const photos = new GalleryPhotoService({ db, assets, schedules, pins });

  db.prepare("INSERT INTO users (username, password_hash) VALUES ('u', 'x')").run();
  const user = db.prepare("SELECT id FROM users WHERE username = 'u'").get() as { id: number };
  const userId = user.id;

  const galleryId = Number(
    db
      .prepare(
        `INSERT INTO galleries (user_id, name) VALUES (?, \'Gallery\')`,
      )
      .run(userId).lastInsertRowid,
  );

  /* The rules say how often the gallery changes and how the pictures are
   * picked, so a gallery needs one to change at all. */
  db.prepare(
    `INSERT INTO gallery_schedule_rules
       (gallery_id, days, start_minute, end_minute, min_interval, max_interval, rotation_mode)
     VALUES (?, 127, 0, 1440, 900, 900, 'random')`,
  ).run(galleryId);

  const deviceId = Number(
    db
      .prepare("INSERT INTO devices (user_id, name, device_id) VALUES (?, 'Frame', 'dev-1')")
      .run(userId).lastInsertRowid,
  );

  db.prepare("UPDATE devices SET gallery_id = ? WHERE id = ?").run(galleryId, deviceId);
  db.prepare("INSERT INTO device_policies (device_id) VALUES (?)").run(deviceId);

  return { db, assets, schedules, pins, photos, galleryId, deviceId };
}

/**
 * A small solid-colour PNG.
 */
async function image(r: number, g: number, b: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

/**
 * Build a server on a throwaway database.
 */
async function makeServer(): Promise<BuiltServer> {
  const dir = mkdtempSync(join(tmpdir(), "paperloom-pin-"));
  return buildServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    logLevel: "silent",
  });
}

/**
 * Create a user and a gallery with one photo, and return the ids.
 */
async function seedGallery(server: BuiltServer): Promise<{ galleryId: number; contentHash: string }> {
  const db = server.db;

  const userId = Number(
    db
      .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run(`u-${randomUUID()}`, "x").lastInsertRowid,
  );

  const galleryId = Number(
    db
      .prepare(
        `INSERT INTO galleries (user_id, name) VALUES (?, \'Test\')`,
      )
      .run(userId).lastInsertRowid,
  );

  /* The rules say how often the gallery changes and how the pictures are
   * picked, so a gallery needs one to change at all. */
  db.prepare(
    `INSERT INTO gallery_schedule_rules
       (gallery_id, days, start_minute, end_minute, min_interval, max_interval, rotation_mode)
     VALUES (?, 127, 0, 1440, 900, 900, 'random')`,
  ).run(galleryId);

  /* A minimal but valid asset. The device API only cares that the hash
   * resolves to stored bytes. */
  const { gzipSync } = await import("node:zlib");
  const payload = gzipSync(Buffer.alloc(16, 0x11));
  const contentHash = AssetStore.hash(payload);
  await server.assets.put(contentHash, payload, 1200, 1600);

  db.prepare(
    `INSERT INTO photos (gallery_id, filename, source_hash, content_hash, width, height, byte_size, weight)
     VALUES (?, 'a.jpg', 'src', ?, 1200, 1600, ?, 1.0)`,
  ).run(galleryId, contentHash, payload.length);

  return { galleryId, contentHash };
}

/**
 * Sign and send a request the way the firmware does.
 */
async function signed(
  server: BuiltServer,
  keys: { privateKeyPem: string },
  deviceId: string,
  method: string,
  path: string,
  body: Buffer,
): Promise<{ status: number; body: unknown; raw: Buffer }> {
  const timestamp = Date.now();
  const nonce = randomUUID();
  const signature = signRequest(
    { method, path, timestamp, nonce, deviceId, body },
    keys.privateKeyPem,
  );

  const response = await server.app.inject({
    method: method as "GET",
    url: path,
    headers: {
      "content-type": "application/json",
      "x-paperloom-device": deviceId,
      "x-paperloom-timestamp": String(timestamp),
      "x-paperloom-nonce": nonce,
      "x-paperloom-signature": signature,
    },
    payload: body,
  });

  const raw = Buffer.from(response.rawPayload);
  let parsed: unknown;
  const contentType = response.headers["content-type"] ?? "";
  if (contentType.includes("application/json") && raw.length > 0) {
    parsed = JSON.parse(raw.toString("utf8"));
  }

  return { status: response.statusCode, body: parsed, raw };
}

test("a picture asked for is put after what the frame has already shown", async () => {
  const world = await makeWorld();

  world.db
    .prepare(
      `INSERT INTO device_sync_rules (device_id, days, start_minute, end_minute, sync_interval, priority)
       VALUES (?, 127, 0, 1440, 900, 0)`,
    )
    .run(world.deviceId);

  /* The frame has shown a picture, and it will not show anything at or
   * before that moment again. A picture asked for has to go after it,
   * or the frame would skip it and it would never appear. */
  const shownAt = Date.now() - 60_000;
  world.db
    .prepare("UPDATE devices SET displayed_at = ? WHERE id = ?")
    .run(shownAt, world.deviceId);

  const added = await world.photos.addPhoto(
    world.galleryId,
    "asked-for.png",
    await image(220, 30, 30),
  );

  const pin = world.pins.pinForOwner(
    world.deviceId,
    added.id,
    Date.now(),
  );

  assert.ok(
    pin.at > shownAt,
    "the picture must be put after the one the frame has already shown",
  );
});

test("a picture whose moment has passed is put at the next wake", async () => {
  const world = await makeWorld();

  world.db
    .prepare(
      `INSERT INTO device_sync_rules (device_id, days, start_minute, end_minute, sync_interval, priority)
       VALUES (?, 127, 0, 1440, 900, 0)`,
    )
    .run(world.deviceId);

  const added = await world.photos.addPhoto(
    world.galleryId,
    "late.png",
    await image(220, 30, 30),
  );

  /* The picture was asked for while the frame was asleep, and its moment
   * came and went without it being shown. */
  const moment = Date.now() - 60_000;
  world.db
    .prepare(
      "INSERT INTO pinned_photos (device_id, photo_id, at) VALUES (?, ?, ?)",
    )
    .run(world.deviceId, added.id, moment);

  const plan = world.schedules.getForDevice(world.deviceId, Date.now());

  const pinned = plan.items.find((item) => item.asset === added.contentHash);
  assert.ok(pinned, "the picture must still be in the plan");
  assert.ok(
    pinned!.at > moment,
    "the picture must be put at a moment that has not passed",
  );
});

test("a picture from Telegram is pinned to the frame's next check-in", async () => {
  const world = await makeWorld();

  /* The frame checks in every fifteen minutes, so the moment it will next
   * check in is a fixed quarter of an hour away and does not drift with
   * the clock. */
  world.db
    .prepare(
      `INSERT INTO device_sync_rules (device_id, days, start_minute, end_minute, sync_interval, priority)
       VALUES (?, 127, 0, 1440, 900, 0)`,
    )
    .run(world.deviceId);

  const before = Date.now();
  const added = await world.photos.addPhoto(
    world.galleryId,
    "pinned.png",
    await image(220, 30, 30),
    { pin: true },
  );
  const after = Date.now();

  assert.equal(added.pinnedTo?.length, 1, "the picture must be pinned to the frame");

  /* The pin is the frame's next check-in, as the server works it out from
   * the frame's own policy.
   *
   * The picture is rendered first, so the check-in is worked out from a
   * moment between the two. The pin must therefore fall in that span. */
  const pinnedAt = added.pinnedTo?.[0]!.at;
  const earliest = world.schedules.nextCheckIn(world.deviceId, before);
  const latest = world.schedules.nextCheckIn(world.deviceId, after);
  assert.ok(
    pinnedAt >= earliest && pinnedAt <= latest,
    `the picture must be pinned to the frame's next check-in (pinned ${pinnedAt}, expected between ${earliest} and ${latest})`,
  );

  /* The pin is recorded. */
  const pin = world.pins.pinFor(world.deviceId);
  assert.ok(pin, "the pin must be recorded");
  assert.equal(pin!.photo_id, added.id);
  assert.equal(pin!.at, pinnedAt);
  assert.equal(pin!.shown, false);
});

test("the pin is in the future", async () => {
  const world = await makeWorld();
  const now = Date.now();

  await world.photos.addPhoto(world.galleryId, "pinned.png", await image(220, 30, 30), {
    pin: true,
  });

  const pin = world.pins.pinFor(world.deviceId);
  assert.ok(pin, "the picture must still be pinned");
  assert.ok(pin!.at > now, "the pin must be in the future");
});

test("a newer picture queues behind the one pinned before", async () => {
  const world = await makeWorld();

  const first = await world.photos.addPhoto(world.galleryId, "one.png", await image(220, 30, 30), {
    pin: true,
  });
  const second = await world.photos.addPhoto(world.galleryId, "two.png", await image(30, 30, 220), {
    pin: true,
  });

  const pins = world.db
    .prepare("SELECT COUNT(*) AS n FROM pinned_photos WHERE device_id = ?")
    .get(world.deviceId) as { n: number };
  assert.equal(pins.n, 2, "both pictures must be pinned, one after the other");

  /* The first picture is shown first, and the second after it. */
  const queued = world.pins.pendingFor(world.deviceId);
  assert.equal(queued.length, 2, "both pictures must be waiting");
  assert.equal(queued[0]!.photo_id, first.id, "the first picture must be first");
  assert.equal(queued[1]!.photo_id, second.id, "the second picture must be second");
  assert.ok(
    queued[1]!.at > queued[0]!.at,
    "the second picture must be shown after the first",
  );
});

test("in the latest mode a newer picture replaces the one waiting", async () => {
  const world = await makeWorld();

  /* A gallery that changes once a day has no use for a queue of
   * pictures: only the last one sent is of any interest. */
  world.db
    .prepare("UPDATE galleries SET telegram_mode = 'latest' WHERE id = ?")
    .run(world.galleryId);

  const first = await world.photos.addPhoto(world.galleryId, "one.png", await image(220, 30, 30), {
    pin: true,
  });
  const second = await world.photos.addPhoto(world.galleryId, "two.png", await image(30, 30, 220), {
    pin: true,
  });

  /* Only the newer picture is waiting. */
  const waiting = world.pins.pendingFor(world.deviceId);
  assert.equal(waiting.length, 1, "only one picture must be waiting");
  assert.equal(waiting[0]!.photo_id, second.id, "the newer picture must be the one waiting");

  /* And the one that was waiting has gone. */
  const all = world.db
    .prepare("SELECT photo_id FROM pinned_photos WHERE device_id = ?")
    .all(world.deviceId) as Array<{ photo_id: number }>;
  assert.equal(all.length, 1);
  assert.notEqual(all[0]!.photo_id, first.id, "the picture it replaced must be gone");
});

test("in the latest mode the picture is shown at the moment the old one was waiting for", async () => {
  const world = await makeWorld();

  world.db
    .prepare("UPDATE galleries SET telegram_mode = 'latest' WHERE id = ?")
    .run(world.galleryId);

  await world.photos.addPhoto(world.galleryId, "one.png", await image(220, 30, 30), { pin: true });
  const firstMoment = world.pins.pendingFor(world.deviceId)[0]!.at;

  await world.photos.addPhoto(world.galleryId, "two.png", await image(30, 30, 220), { pin: true });

  const waiting = world.pins.pendingFor(world.deviceId);
  assert.equal(waiting.length, 1);
  assert.equal(
    waiting[0]!.at,
    firstMoment,
    "the picture must be shown at the moment the frame was already expecting one",
  );
});

test("every picture in the queue is in the plan", () => {
  const candidates: Candidate[] = [
    { photoId: 2, contentHash: "ordinary", weight: 1, belongsTo: 1 },
  ];
  const galleries: GalleryPolicy[] = [
    {
      galleryId: 1,
      rules: [
        {
          id: 1,
          days: 127,
          startMinute: 0,
          endMinute: 1440,
          minInterval: 900,
          maxInterval: 900,
          priority: 0,
          rotationMode: "random",
        },
      ],
    },
  ];
  const policy = {
    syncInterval: 3600,
    lookahead: 10800,
    quietStart: null,
    quietEnd: null,
    timezone: "UTC",
  };

  const windowStart = 1_700_000_000_000;

  /* Two pictures are waiting, each for a moment of its own. Both must be
   * in the plan, so that the frame is shown them one after the other. */
  const first = windowStart + 2 * 900 * 1000;
  const second = windowStart + 5 * 900 * 1000;

  const events = materializeSchedule({
    deviceId: "dev-1",
    windowStart,
    windowEnd: windowStart + 10800 * 1000,
    candidates,
    galleries,
    policy,
    pinned: [
      { at: first, contentHash: "first" },
      { at: second, contentHash: "second" },
    ],
  });

  const firsts = events.filter((e) => e.asset === "first");
  const seconds = events.filter((e) => e.asset === "second");
  assert.equal(firsts.length, 1, "the first picture must be shown exactly once");
  assert.equal(seconds.length, 1, "the second picture must be shown exactly once");
  assert.equal(firsts[0]!.at, first, "the first picture must be shown when it was pinned for");
  assert.equal(seconds[0]!.at, second, "the second picture must be shown when it was pinned for");
});

test("in the latest mode the plan holds only the picture that is waiting", async () => {
  const world = await makeWorld();

  /* A gallery that changes once a day. */
  world.db
    .prepare(
      `UPDATE gallery_schedule_rules
       SET min_interval = 86400, max_interval = 86400
       WHERE gallery_id = ?`,
    )
    .run(world.galleryId);
  world.db
    .prepare("UPDATE galleries SET telegram_mode = 'latest' WHERE id = ?")
    .run(world.galleryId);

  /* Two pictures are sent. Only the second one is of any interest. */
  await world.photos.addPhoto(world.galleryId, "one.png", await image(220, 30, 30), {
    pin: true,
  });
  const second = await world.photos.addPhoto(world.galleryId, "two.png", await image(30, 30, 220), {
    pin: true,
  });

  const waiting = world.pins.pendingFor(world.deviceId);
  assert.equal(waiting.length, 1, "only one picture must be waiting");

  /* The plan the frame is following must hold that one picture, and only
   * that one. The picture that was replaced must not be in it. */
  const plan = world.schedules.getForDevice(world.deviceId, Date.now());

  const shown = plan.items.filter((item) => item.asset === second.contentHash);
  assert.ok(shown.length > 0, "the waiting picture must be in the plan");

  const replaced = world.db
    .prepare("SELECT content_hash FROM photos WHERE filename = 'one.png'")
    .get() as { content_hash: string };
  const stale = plan.items.filter((item) => item.asset === replaced.content_hash);
  assert.equal(stale.length, 0, "the picture that was replaced must not be in the plan");
});

test("in the latest mode every replaced picture is left out of the plan", async () => {
  const world = await makeWorld();

  world.db
    .prepare(
      `UPDATE gallery_schedule_rules
       SET min_interval = 86400, max_interval = 86400
       WHERE gallery_id = ?`,
    )
    .run(world.galleryId);
  world.db
    .prepare("UPDATE galleries SET telegram_mode = 'latest' WHERE id = ?")
    .run(world.galleryId);

  /* Three pictures are sent, one after another. Only the last one is of
   * any interest, and the other two are not to be shown at all. */
  const first = await world.photos.addPhoto(world.galleryId, "one.png", await image(220, 30, 30), {
    pin: true,
  });
  const second = await world.photos.addPhoto(world.galleryId, "two.png", await image(30, 30, 220), {
    pin: true,
  });
  const third = await world.photos.addPhoto(world.galleryId, "three.png", await image(30, 220, 30), {
    pin: true,
  });

  const plan = world.schedules.getForDevice(world.deviceId, Date.now());

  assert.equal(
    plan.items.filter((item) => item.asset === first.contentHash).length,
    0,
    "the first picture must not be in the plan",
  );
  assert.equal(
    plan.items.filter((item) => item.asset === second.contentHash).length,
    0,
    "the second picture must not be in the plan",
  );

  const wanted = plan.items.filter((item) => item.asset === third.contentHash);
  assert.ok(wanted.length > 0, "the picture that is waiting must be in the plan");

  const distinct = new Set(plan.items.map((item) => item.asset));
  assert.equal(distinct.size, 1, "the plan must hold only the picture that is waiting");
});

test("a picture asked for takes the place of the one that was waiting", async () => {
  const world = await makeWorld();

  world.db
    .prepare(
      `INSERT INTO device_sync_rules (device_id, days, start_minute, end_minute, sync_interval, priority)
       VALUES (?, 127, 0, 1440, 900, 0)`,
    )
    .run(world.deviceId);

  /* A picture from a chat is waiting to be shown. */
  const first = await world.photos.addPhoto(
    world.galleryId,
    "from-chat.png",
    await image(220, 30, 30),
    { pin: true },
  );

  /* The owner asks for a different one to be shown next. */
  const second = await world.photos.addPhoto(
    world.galleryId,
    "asked-for.png",
    await image(30, 30, 220),
  );
  const made = world.pins.pinForOwner(world.deviceId, second.id, Date.now());
  world.schedules.addPinnedEvent(
    made.device_id,
    made.at,
    made.photo_id,
    made.replaced,
  );

  const plan = world.schedules.getForDevice(world.deviceId, Date.now());

  const stale = plan.items.filter((item) => item.asset === first.contentHash);
  assert.equal(stale.length, 0, "the picture it replaced must not be in the plan");

  const wanted = plan.items.filter((item) => item.asset === second.contentHash);
  assert.ok(wanted.length > 0, "the picture that was asked for must be in the plan");
});

test("every frame showing the gallery gets the picture pinned", async () => {
  const world = await makeWorld();

  /* A second frame showing the same gallery. */
  const secondDevice = Number(
    world.db
      .prepare("INSERT INTO devices (user_id, name, device_id) VALUES (1, 'Second', 'dev-2')")
      .run().lastInsertRowid,
  );
  world.db
    .prepare("UPDATE devices SET gallery_id = ? WHERE id = ?")
    .run(world.galleryId, secondDevice);
  world.db.prepare("INSERT INTO device_policies (device_id) VALUES (?)").run(secondDevice);

  const added = await world.photos.addPhoto(world.galleryId, "pinned.png", await image(220, 30, 30), {
    pin: true,
  });

  assert.equal(added.pinnedTo?.length, 2, "both frames must be pinned");
  const deviceIds = added.pinnedTo!.map((p) => p.deviceId).sort();
  assert.deepEqual(deviceIds, [world.deviceId, secondDevice].sort());
});

test("a picture uploaded through the management UI is not pinned", async () => {
  const world = await makeWorld();

  await world.photos.addPhoto(world.galleryId, "uploaded.png", await image(220, 30, 30));

  const pins = world.db.prepare("SELECT COUNT(*) AS n FROM pinned_photos").get() as { n: number };
  assert.equal(pins.n, 0, "an uploaded picture must not be pinned to a check-in");
});

test("a pinned picture is in the gallery as well, and joins the ordinary rotation", async () => {
  const world = await makeWorld();

  const added = await world.photos.addPhoto(
    world.galleryId,
    "pinned.png",
    await image(220, 30, 30),
    { pin: true },
  );

  /* The picture is in the gallery, as any picture is. The pin is extra:
   * it brings the picture forward, it does not set it apart. */
  const photos = world.db
    .prepare("SELECT id, filename, content_hash FROM photos WHERE gallery_id = ?")
    .all(world.galleryId) as Array<{ id: number; filename: string; content_hash: string }>;

  assert.equal(photos.length, 1, "the pinned picture must be in the gallery");
  assert.equal(photos[0]!.id, added.id);
  assert.equal(photos[0]!.filename, "pinned.png");
  assert.ok(photos[0]!.content_hash, "the picture must have an asset hash");

  /* So the scheduler picks it up as an ordinary candidate, and it can be
   * shown again later as part of the rotation. */
  const now = Date.now();
  const window = world.schedules.getForDevice(world.deviceId, now);

  assert.ok(window.items.length > 0, "the picture must be scheduled as an ordinary one");
  assert.ok(
    window.items.every((e) => e.asset === photos[0]!.content_hash),
    "the picture must appear in the ordinary rotation",
  );
});

test("the pinned picture takes the place of whatever would have been shown", () => {
  const candidates: Candidate[] = [
    { photoId: 1, contentHash: "old", weight: 1, belongsTo: 1 },
  ];
  const galleries: GalleryPolicy[] = [
    {
      galleryId: 1,
      rules: [
        {
          id: 1,
          days: 127,
          startMinute: 0,
          endMinute: 1440,
          minInterval: 900,
          maxInterval: 900,
          priority: 0,
          rotationMode: "random",
        },
      ],
    },
  ];
  const policy = {
    syncInterval: 3600,
    lookahead: 10800,
    quietStart: null,
    quietEnd: null,
    timezone: "UTC",
  };

  const windowStart = 1_700_000_000_000;

  /* Without a pin, the only picture is shown. */
  const withoutPin = materializeSchedule({
    deviceId: "dev-1",
    windowStart,
    windowEnd: windowStart + 10800 * 1000,
    candidates,
    galleries,
    policy,
  });
  assert.ok(withoutPin.length > 0);
  assert.ok(
    withoutPin.every((e) => e.asset === "old"),
    "every event must be the ordinary picture",
  );

  /* With a pin, the pinned picture is shown at the pinned moment. */
  const pinAt = windowStart + 2 * 900 * 1000;
  const withPin = materializeSchedule({
    deviceId: "dev-1",
    windowStart,
    windowEnd: windowStart + 10800 * 1000,
    candidates,
    galleries,
    policy,
    pinned: [{ at: pinAt, contentHash: "pinned" }],
  });

  const pinnedEvents = withPin.filter((e) => e.asset === "pinned");
  assert.equal(pinnedEvents.length, 1, "the pinned picture must be shown exactly once");
  assert.ok(
    pinnedEvents[0]!.at >= pinAt,
    "the pinned picture must be shown at or after the moment it was pinned for",
  );

  /* The rest of the window is planned as it would have been. */
  assert.ok(
    withPin.length >= withoutPin.length,
    "the rest of the window must still be planned",
  );
  assert.ok(
    withPin.filter((e) => e.asset === "old").length > 0,
    "the ordinary picture must still appear",
  );
});

test("a plan that already has the pinned moment is not given it twice", () => {
  /* The pinned picture is a candidate like any other, so that the replay
   * of an existing plan can keep it. */
  const candidates: Candidate[] = [
    { photoId: 1, contentHash: "old", weight: 1, belongsTo: 1 },
    { photoId: 2, contentHash: "pinned", weight: 1, belongsTo: 1 },
  ];
  const galleries: GalleryPolicy[] = [
    {
      galleryId: 1,
      rules: [
        {
          id: 1,
          days: 127,
          startMinute: 0,
          endMinute: 1440,
          minInterval: 900,
          maxInterval: 900,
          priority: 0,
          rotationMode: "random",
        },
      ],
    },
  ];
  const policy = {
    syncInterval: 3600,
    lookahead: 10800,
    quietStart: null,
    quietEnd: null,
    timezone: "UTC",
  };

  const windowStart = 1_700_000_000_000;
  const pinAt = windowStart + 2 * 900 * 1000;

  /* The plan already has an event at the moment the pin is for, which is
   * what happens when the plan is extended after the pin was made. */
  const existing = [{ at: pinAt, asset: "pinned" }];

  const events = materializeSchedule({
    deviceId: "dev-1",
    windowStart,
    windowEnd: windowStart + 10800 * 1000,
    existing,
    candidates,
    galleries,
    policy,
    pinned: [{ at: pinAt, contentHash: "pinned" }],
  });

  const atPin = events.filter((e) => e.at === pinAt);
  assert.equal(atPin.length, 1, "the moment must hold one event, not two");
  assert.equal(atPin[0]!.asset, "pinned");
});
test("a pinned picture outside the window is not shown in it", () => {  const candidates: Candidate[] = [
    { photoId: 1, contentHash: "old", weight: 1, belongsTo: 1 },
  ];
  const galleries: GalleryPolicy[] = [
    {
      galleryId: 1,
      rules: [
        {
          id: 1,
          days: 127,
          startMinute: 0,
          endMinute: 1440,
          minInterval: 900,
          maxInterval: 900,
          priority: 0,
          rotationMode: "random",
        },
      ],
    },
  ];
  const policy = {
    syncInterval: 3600,
    lookahead: 10800,
    quietStart: null,
    quietEnd: null,
    timezone: "UTC",
  };

  const windowStart = 1_700_000_000_000;

  const events = materializeSchedule({
    deviceId: "dev-1",
    windowStart,
    windowEnd: windowStart + 10800 * 1000,
    candidates,
    galleries,
    policy,
    // Well beyond the end of the window.
    pinned: [{ at: windowStart + 10 * 10800 * 1000, contentHash: "pinned" }],
  });

  assert.ok(
    events.every((e) => e.asset !== "pinned"),
    "a pin beyond the window must not be shown in it",
  );
});

test("a pin that is shown is not shown again", async () => {
  const world = await makeWorld();

  const added = await world.photos.addPhoto(
    world.galleryId,
    "pinned.png",
    await image(220, 30, 30),
    { pin: true },
  );

  const pin = world.pins.pinFor(world.deviceId);
  assert.ok(pin);
  world.pins.markShown(pin!.id);

  const after = world.pins.pinFor(world.deviceId);
  assert.equal(after!.shown, true, "the pin must be marked as shown");
  assert.equal(
    world.pins.dueFor(world.deviceId, Date.now() + 60 * 60 * 1000).length,
    0,
    "a pin that has been shown must not be offered again",
  );

  /* The photo is still in the gallery, so it can be shown again as part of
   * the ordinary rotation. */
  const photos = world.db
    .prepare("SELECT COUNT(*) AS n FROM photos WHERE gallery_id = ?")
    .get(world.galleryId) as { n: number };
  assert.equal(photos.n, 1);
  assert.equal(added.pinnedTo?.length, 1);
});

test("a picture is slotted into the frame's next check-in", async () => {
  const server = await makeServer();
  const db = server.db;

  const { galleryId, contentHash } = await seedGallery(server);
  const deviceId = `dev-${randomUUID()}`;
  const keys = generateKeyPair();

  /* Enrol and claim the frame. */
  const enroll = await server.app.inject({
    method: "POST",
    url: "/api/device/enroll",
    payload: {
      device_id: deviceId,
      name: "Living room",
      public_key: publicKeyToBase64(keys.publicKeyPem),
    },
  });
  assert.equal(enroll.statusCode, 200);

  const user = db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() as { id: number };
  const userId = user.id;
  const deviceRow = db.prepare("SELECT id FROM devices WHERE device_id = ?").get(deviceId) as
    | { id: number }
    | undefined;
  assert.ok(deviceRow, "the enrolment must have made a row for the frame");
  const deviceRowId = deviceRow.id;

  db.prepare("UPDATE devices SET state = 'claimed', user_id = ? WHERE id = ?").run(
    userId,
    deviceRowId,
  );
  db.prepare("UPDATE devices SET gallery_id = ? WHERE id = ?").run(galleryId, deviceRowId);
  db.prepare(
    "INSERT INTO device_policies (device_id, sync_interval, lookahead) VALUES (?, 3600, 10800)",
  ).run(deviceRowId);

  /* The frame checks in, and is told when to come back. */
  const sync = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(
      JSON.stringify({
        device_id: deviceId,
        displayed_asset: null,
        battery_mv: 3850,
        firmware_version: "0.1.0",
        wake_reason: "timer",
      }),
    ),
  );
  assert.equal(sync.status, 200, sync.raw.toString("utf8"));

  /* The server's own estimate of when the frame will check in again is
   * the moment the picture is pinned to. */
  const before = Date.now();
  const earliest = server.schedules.nextCheckIn(deviceRowId, before);

  /* A picture arrives and is pinned to that moment. */
  const pins = new PinnedPhotoService({ db, schedules: server.schedules });
  const galleryPhotos = new GalleryPhotoService({
    db,
    assets: server.assets,
    schedules: server.schedules,
    pins,
  });

  const photo = await galleryPhotos.addPhoto(
    galleryId,
    "telegram.png",
    await image(220, 30, 30),
    { pin: true },
  );
  const latest = server.schedules.nextCheckIn(deviceRowId, Date.now());

  assert.equal(photo.pinnedTo?.length, 1);
  const pinnedAt = photo.pinnedTo?.[0]!.at;
  assert.ok(
    pinnedAt >= earliest && pinnedAt <= latest,
    `the picture must be pinned to the frame's next check-in (pinned ${pinnedAt}, expected between ${earliest} and ${latest})`,
  );

  /* The frame syncs again and is given the picture at that moment. */
  const again = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(
      JSON.stringify({
        device_id: deviceId,
        displayed_asset: null,
        battery_mv: 3850,
        firmware_version: "0.1.0",
        wake_reason: "timer",
      }),
    ),
  );
  assert.equal(again.status, 200);

  const body = again.body as SyncResponse;
  const items = body.schedule.items;
  assert.ok(items.length > 0, "the frame must be given a schedule");

  const atPin = items.filter((i) => Math.abs(new Date(i.at).getTime() - pinnedAt) < 1000);
  assert.equal(
    atPin.length,
    1,
    "there must be an event at the pinned moment",
  );
  assert.equal(
    atPin[0]!.asset,
    photo.contentHash,
    "the event at the pinned moment must be the pinned picture",
  );

  /* The ordinary picture is still in the plan as well. */
  assert.ok(
    items.some((i) => i.asset === contentHash),
    "the ordinary picture must still be scheduled",
  );
});
