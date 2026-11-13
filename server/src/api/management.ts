/**
 * Management API.
 *
 * The endpoints behind the web UI: galleries, photos, devices, and the
 * session login. These are the human-facing side of the server and are
 * authenticated with a session cookie rather than a device signature.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AssetStore } from "../assets/store.js";
import type { Db } from "../db/index.js";
import type { ScheduleService } from "../schedule/service.js";
import { EVERY_DAY } from "../schedule/rules.js";
import { ROTATIONS, isRotation } from "../panel.js";

export interface ManagementOptions {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly schedules: ScheduleService;
  readonly basePath: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function registerManagementApi(app: FastifyInstance, options: ManagementOptions): void {
  const { db, assets, schedules, basePath } = options;

  /**
   * Require a signed-in user.
   */
  async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<number | null> {
    const token = request.cookies["paperloom_session"];
    if (!token) {
      await reply.code(401).send({ error: "not signed in" });
      return null;
    }

    const session = db
      .prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
      .get(token) as { user_id: number; expires_at: string } | undefined;

    if (!session || new Date(session.expires_at).getTime() < Date.now()) {
      await reply.code(401).send({ error: "session expired" });
      return null;
    }

    (request as FastifyRequest & { paperloomUser?: { id: number } }).paperloomUser = {
      id: session.user_id,
    };
    return session.user_id;
  }

  /**
   * Discard the materialised schedules of every device that shows a
   * gallery.
   *
   * A gallery's contents and policy decide what its devices are shown and
   * when, so a change to the gallery makes their existing schedule
   * windows wrong.
   */
  function invalidateGallery(galleryId: number): void {
    const devices = db
      .prepare("SELECT device_id FROM device_galleries WHERE gallery_id = ?")
      .all(galleryId) as Array<{ device_id: number }>;
    for (const device of devices) {
      schedules.invalidate(device.device_id);
    }
  }

  // ---------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------

  app.post(`${basePath}/auth/register`, async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    if (!body?.username || !body?.password) {
      await reply.code(400).send({ error: "username and password are required" });
      return;
    }
    if (body.password.length < 8) {
      await reply.code(400).send({ error: "password must be at least 8 characters" });
      return;
    }

    const existing = db
      .prepare("SELECT 1 FROM users WHERE username = ?")
      .get(body.username);
    if (existing) {
      await reply.code(409).send({ error: "username already taken" });
      return;
    }

    const result = db
      .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run(body.username, hashPassword(body.password));

    await reply.send({ user_id: Number(result.lastInsertRowid) });
  });

  app.post(`${basePath}/auth/login`, async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    if (!body?.username || !body?.password) {
      await reply.code(400).send({ error: "username and password are required" });
      return;
    }

    const user = db
      .prepare("SELECT id, password_hash FROM users WHERE username = ?")
      .get(body.username) as { id: number; password_hash: string } | undefined;

    if (!user || !verifyPassword(body.password, user.password_hash)) {
      await reply.code(401).send({ error: "invalid credentials" });
      return;
    }

    const token = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
      token,
      user.id,
      new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    );

    await reply
      .setCookie("paperloom_session", token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      })
      .send({ status: "ok" });
  });

  app.post(`${basePath}/auth/logout`, async (_request, reply) => {
    await reply.clearCookie("paperloom_session", { path: "/" }).send({ status: "ok" });
  });

  app.get(`${basePath}/auth/me`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;
    const user = db
      .prepare("SELECT id, username FROM users WHERE id = ?")
      .get(userId) as { id: number; username: string };
    await reply.send(user);
  });

  // ---------------------------------------------------------------------
  // Galleries
  // ---------------------------------------------------------------------

  app.get(`${basePath}/galleries`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const galleries = db
      .prepare(
        `SELECT g.id, g.name, g.rotation_mode, g.min_interval, g.max_interval,
                g.quiet_start, g.quiet_end, g.enabled,
                (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id) AS photo_count
         FROM galleries g
         WHERE g.user_id = ?
         ORDER BY g.name`,
      )
      .all(userId);

    await reply.send(galleries);
  });

  app.post(`${basePath}/galleries`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const body = request.body as {
      name?: string;
      rotation_mode?: "random" | "sequential";
      min_interval?: number;
      max_interval?: number;
    };
    if (!body?.name) {
      await reply.code(400).send({ error: "name is required" });
      return;
    }

    const result = db
      .prepare(
        `INSERT INTO galleries (user_id, name, rotation_mode, min_interval, max_interval)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        body.name,
        body.rotation_mode ?? "random",
        body.min_interval ?? 900,
        body.max_interval ?? 21600,
      );

    await reply.send({ id: Number(result.lastInsertRowid) });
  });

  app.patch(`${basePath}/galleries/:id`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const gallery = db
      .prepare("SELECT id FROM galleries WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!gallery) {
      await reply.code(404).send({ error: "unknown gallery" });
      return;
    }

    const body = request.body as Partial<{
      name: string;
      rotation_mode: "random" | "sequential";
      min_interval: number;
      max_interval: number;
      quiet_start: number | null;
      quiet_end: number | null;
      enabled: boolean;
    }>;

    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
    if (fields.length === 0) {
      await reply.send({ status: "ok" });
      return;
    }

    db.prepare(`UPDATE galleries SET ${fields.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(
      ...values,
      Number(id),
    );

    invalidateGallery(Number(id));

    await reply.send({ status: "ok" });
  });

  app.delete(`${basePath}/galleries/:id`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const gallery = db
      .prepare("SELECT id FROM galleries WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!gallery) {
      await reply.code(404).send({ error: "unknown gallery" });
      return;
    }

    // Collect the asset hashes so they can be garbage-collected.
    const hashes = db
      .prepare("SELECT content_hash FROM photos WHERE gallery_id = ? AND content_hash IS NOT NULL")
      .all(Number(id)) as Array<{ content_hash: string }>;

    /* The devices that showed this gallery now show something else, so
     * their schedules are rebuilt. */
    invalidateGallery(Number(id));

    db.prepare("DELETE FROM galleries WHERE id = ?").run(Number(id));
    for (const hash of hashes) await assets.remove(hash.content_hash);

    await reply.send({ status: "ok" });
  });

  // ---------------------------------------------------------------------
  // Photos
  // ---------------------------------------------------------------------

  app.get(`${basePath}/galleries/:id/photos`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const gallery = db
      .prepare("SELECT id FROM galleries WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!gallery) {
      await reply.code(404).send({ error: "unknown gallery" });
      return;
    }

    const photos = db
      .prepare(
        `SELECT id, filename, source_hash, content_hash, width, height,
                byte_size, taken_at, weight
         FROM photos WHERE gallery_id = ? ORDER BY id`,
      )
      .all(Number(id));

    await reply.send(photos);
  });

  /**
   * Upload a photo to a gallery.
   *
   * The image is rendered to a display-ready asset immediately, so the
   * device never has to do image work and the asset hash is known up front.
   */
  app.post(`${basePath}/galleries/:id/photos`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const gallery = db
      .prepare("SELECT id FROM galleries WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!gallery) {
      await reply.code(404).send({ error: "unknown gallery" });
      return;
    }

    const body = request.body as { filename?: string; data?: string };
    if (!body?.data) {
      await reply.code(400).send({ error: "data (base64 image) is required" });
      return;
    }

    const source = Buffer.from(body.data, "base64");
    const sourceHash = AssetStore.hash(source);
    const filename = body.filename ?? `${sourceHash.slice(0, 12)}.jpg`;

    /* Keep the original so the gallery can show the photo the owner
     * uploaded, rather than only the panel's rendering of it. */
    await assets.putSource(sourceHash, source);

    const { renderAsset } = await import("../image.js");

    /* Render the photo for each way a frame might be mounted.
     *
     * A frame that is turned needs the photo rendered at the turned
     * dimensions and then turned back, which is a different picture and
     * so a different asset. Rendering them all now means a frame can be
     * turned later without waiting for the photo to be rendered again. */
    const renderedByRotation = new Map<number, { hash: string; size: number }>();
    for (const rotation of ROTATIONS) {
      const rendered = await renderAsset(source, { rotation });
      const hash = AssetStore.hash(rendered.data);
      await assets.put(hash, rendered.data, 1200, 1600);
      renderedByRotation.set(rotation, { hash, size: rendered.data.length });
    }

    const upright = renderedByRotation.get(0)!;

    const result = db
      .prepare(
        `INSERT INTO photos
           (gallery_id, filename, source_hash, content_hash, width, height, byte_size, weight)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1.0)`,
      )
      .run(
        Number(id),
        filename,
        sourceHash,
        upright.hash,
        1200,
        1600,
        upright.size,
      );

    const photoId = Number(result.lastInsertRowid);

    /* Record the other renderings, so a frame that is turned can be told
     * about the right asset. */
    const insertAsset = db.prepare(
      "INSERT OR REPLACE INTO photo_assets (photo_id, rotation, content_hash) VALUES (?, ?, ?)",
    );
    for (const [rotation, rendered] of renderedByRotation) {
      insertAsset.run(photoId, rotation, rendered.hash);
    }

    /* A new photo changes what the gallery can show, so the schedules of
     * the devices that show it are rebuilt. */
    invalidateGallery(Number(id));

    await reply.send({
      id: photoId,
      filename,
      content_hash: upright.hash,
      byte_size: upright.size,
    });
  });

  /**
   * The original upload behind a photo.
   *
   * This is what the gallery preview shows: the photo as the owner
   * uploaded it, rather than the panel's six-colour rendering of it.
   */
  app.get(`${basePath}/photos/:id/preview`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const photo = db
      .prepare(
        `SELECT p.source_hash, p.filename FROM photos p
         JOIN galleries g ON g.id = p.gallery_id
         WHERE p.id = ? AND g.user_id = ?`,
      )
      .get(Number(id), userId) as { source_hash: string; filename: string } | undefined;

    if (!photo) {
      await reply.code(404).send({ error: "unknown photo" });
      return;
    }

    const bytes = await assets.getSource(photo.source_hash);
    if (!bytes) {
      await reply.code(404).send({ error: "the original is not available" });
      return;
    }

    /* The browser sniffs the type anyway, but sending the real one lets it
     * render without downloading the whole file first. */
    const extension = photo.filename.toLowerCase().split(".").pop() ?? "";
    const contentType =
      extension === "png"
        ? "image/png"
        : extension === "gif"
          ? "image/gif"
          : extension === "webp"
            ? "image/webp"
            : "image/jpeg";

    await reply
      .header("Content-Type", contentType)
      .header("Cache-Control", "private, max-age=3600")
      .send(bytes);
  });

  app.delete(`${basePath}/photos/:id`, async (request, reply) => {    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const photo = db
      .prepare(
        `SELECT p.id, p.content_hash, p.gallery_id FROM photos p
         JOIN galleries g ON g.id = p.gallery_id
         WHERE p.id = ? AND g.user_id = ?`,
      )
      .get(Number(id), userId) as
      | { id: number; content_hash: string; gallery_id: number }
      | undefined;

    if (!photo) {
      await reply.code(404).send({ error: "unknown photo" });
      return;
    }

    db.prepare("DELETE FROM photos WHERE id = ?").run(Number(id));
    if (photo.content_hash) await assets.remove(photo.content_hash);

    invalidateGallery(photo.gallery_id);

    await reply.send({ status: "ok" });
  });

  // ---------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------

  app.get(`${basePath}/devices`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const devices = db
      .prepare(
        `SELECT id, name, device_id, state, panel_width, panel_height, timezone,
                rotation, battery_mv, firmware_version, displayed_asset,
                last_seen_at, created_at
         FROM devices WHERE user_id = ? ORDER BY name`,
      )
      .all(userId);

    await reply.send(devices);
  });

  app.post(`${basePath}/devices/:id/galleries`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const body = request.body as { gallery_id?: number };

    const device = db
      .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!device) {
      await reply.code(404).send({ error: "unknown device" });
      return;
    }
    if (!body?.gallery_id) {
      await reply.code(400).send({ error: "gallery_id is required" });
      return;
    }

    db.prepare(
      `INSERT INTO device_galleries (device_id, gallery_id) VALUES (?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(Number(id), body.gallery_id);

    /* The device's schedule changes with its galleries, so the windows
     * that were materialised from the old set are no longer right. */
    schedules.invalidate(Number(id));

    await reply.send({ status: "ok" });
  });

  app.delete(`${basePath}/devices/:id/galleries/:galleryId`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id, galleryId } = request.params as { id: string; galleryId: string };
    db.prepare("DELETE FROM device_galleries WHERE device_id = ? AND gallery_id = ?").run(
      Number(id),
      Number(galleryId),
    );

    schedules.invalidate(Number(id));

    await reply.send({ status: "ok" });
  });

  app.patch(`${basePath}/devices/:id/policy`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const device = db
      .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!device) {
      await reply.code(404).send({ error: "unknown device" });
      return;
    }

    const body = request.body as Partial<{
      sync_interval: number;
      lookahead: number;
      quiet_start: number | null;
      quiet_end: number | null;
      timezone: string;
      rotation: number;
    }>;

    db.prepare(
      `INSERT INTO device_policies (device_id) VALUES (?)
       ON CONFLICT(device_id) DO NOTHING`,
    ).run(Number(id));

    /* The rotation is a property of the frame rather than of its policy,
     * because it describes how the frame is mounted. */
    if (body.rotation !== undefined) {
      if (!isRotation(body.rotation)) {
        await reply.code(400).send({ error: "the rotation must be 0, 90, 180 or 270" });
        return;
      }
      db.prepare("UPDATE devices SET rotation = ? WHERE id = ?").run(body.rotation, Number(id));
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      if (key === "rotation") continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length > 0) {
      db.prepare(`UPDATE device_policies SET ${fields.join(", ")} WHERE device_id = ?`).run(
        ...values,
        Number(id),
      );

      /* The policy decides the window boundaries and how far ahead the
       * schedule is built, so the materialised windows no longer describe
       * what the device should be shown. */
      schedules.invalidate(Number(id));
    }

    await reply.send({ status: "ok" });
  });

  /**
   * The time zones the server knows about.
   *
   * The list comes from the runtime, which uses the same IANA database as
   * the browser. The UI normally uses the browser's own list, but this
   * one is there for a client that wants the server's view.
   */
  app.get(`${basePath}/timezones`, async (_request, reply) => {
    const zones = Intl.supportedValuesOf
      ? Intl.supportedValuesOf("timeZone")
      : ["UTC"];
    await reply.send({ timezones: zones });
  });

  /**
   * The time-based check-in rules of a device.
   */
  app.get(`${basePath}/devices/:id/sync-rules`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const device = db
      .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!device) {
      await reply.code(404).send({ error: "unknown device" });
      return;
    }

    const rules = schedules.rulesFor(Number(id));
    await reply.send(
      rules.map((rule) => ({
        id: rule.id,
        days: rule.days,
        start_minute: rule.startMinute,
        end_minute: rule.endMinute,
        sync_interval: rule.syncInterval,
        priority: rule.priority,
      })),
    );
  });

  /**
   * Add a check-in rule.
   */
  app.post(`${basePath}/devices/:id/sync-rules`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const device = db
      .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!device) {
      await reply.code(404).send({ error: "unknown device" });
      return;
    }

    const body = request.body as Partial<{
      days: number;
      start_minute: number;
      end_minute: number;
      sync_interval: number;
      priority: number;
    }>;

    const days = body.days ?? EVERY_DAY;
    const startMinute = body.start_minute ?? 0;
    const endMinute = body.end_minute ?? 1440;
    const syncInterval = body.sync_interval ?? 3600;
    const priority = body.priority ?? 0;

    if (days < 0 || days > EVERY_DAY) {
      await reply.code(400).send({ error: "days must be a bit mask of the days of the week" });
      return;
    }
    if (startMinute < 0 || startMinute > 1440 || endMinute < 0 || endMinute > 1440) {
      await reply.code(400).send({ error: "the times must be minutes from midnight" });
      return;
    }
    if (syncInterval < 60) {
      await reply.code(400).send({ error: "the interval must be at least 60 seconds" });
      return;
    }

    const result = db
      .prepare(
        `INSERT INTO device_sync_rules
           (device_id, days, start_minute, end_minute, sync_interval, priority)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(Number(id), days, startMinute, endMinute, syncInterval, priority);

    await reply.send({ id: Number(result.lastInsertRowid) });
  });

  /**
   * Change a check-in rule.
   */
  app.patch(`${basePath}/devices/:id/sync-rules/:ruleId`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id, ruleId } = request.params as { id: string; ruleId: string };
    const device = db
      .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!device) {
      await reply.code(404).send({ error: "unknown device" });
      return;
    }

    const rule = db
      .prepare("SELECT id FROM device_sync_rules WHERE id = ? AND device_id = ?")
      .get(Number(ruleId), Number(id));
    if (!rule) {
      await reply.code(404).send({ error: "unknown rule" });
      return;
    }

    const body = request.body as Partial<{
      days: number;
      start_minute: number;
      end_minute: number;
      sync_interval: number;
      priority: number;
    }>;

    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ["days", "start_minute", "end_minute", "sync_interval", "priority"]) {
      const value = (body as Record<string, unknown>)[key];
      if (value === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length > 0) {
      db.prepare(
        `UPDATE device_sync_rules SET ${fields.join(", ")} WHERE id = ? AND device_id = ?`,
      ).run(...values, Number(ruleId), Number(id));
    }

    await reply.send({ status: "ok" });
  });

  /**
   * Remove a check-in rule.
   */
  app.delete(`${basePath}/devices/:id/sync-rules/:ruleId`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id, ruleId } = request.params as { id: string; ruleId: string };
    const device = db
      .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!device) {
      await reply.code(404).send({ error: "unknown device" });
      return;
    }

    db.prepare("DELETE FROM device_sync_rules WHERE id = ? AND device_id = ?").run(
      Number(ruleId),
      Number(id),
    );

    await reply.send({ status: "ok" });
  });

  /**
   * The schedule a device would currently receive.
   *
   * Useful for previewing the server's policy without a device attached.
   */
  app.get(`${basePath}/devices/:id/schedule`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const device = db
      .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!device) {
      await reply.code(404).send({ error: "unknown device" });
      return;
    }

    const window = schedules.getForDevice(Number(id), Date.now());

    /* The photo behind each asset, so the owner sees which picture is
     * going to be shown rather than a hash. */
    const photos = db
      .prepare(
        `SELECT id, content_hash, filename FROM photos
         WHERE content_hash IS NOT NULL`,
      )
      .all() as Array<{ id: number; content_hash: string; filename: string }>;
    const photoByHash = new Map(photos.map((p) => [p.content_hash, p]));

    await reply.send({
      revision: window.revision,
      items: window.items.map((item) => {
        const photo = photoByHash.get(item.asset);
        return {
          at: new Date(item.at).toISOString(),
          asset: item.asset,
          filename: photo?.filename ?? null,
          photo_id: photo?.id ?? null,
        };
      }),
    });
  });

  app.delete(`${basePath}/devices/:id`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const device = db
      .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!device) {
      await reply.code(404).send({ error: "unknown device" });
      return;
    }

    db.prepare("DELETE FROM devices WHERE id = ?").run(Number(id));
    await reply.send({ status: "ok" });
  });
}

/**
 * Hash a password with scrypt.
 *
 * The salt is stored alongside the derived key, so a change of algorithm
 * later remains possible by storing a parameter prefix.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

/**
 * Verify a password against a stored hash, in constant time.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const salt = Buffer.from(parts[1]!, "base64");
  const expected = Buffer.from(parts[2]!, "base64");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Hash used for looking up a photo by content.
 */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
