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

    const { renderAsset } = await import("../image.js");
    const rendered = await renderAsset(source);

    const contentHash = AssetStore.hash(rendered.data);
    await assets.put(contentHash, rendered.data, 1200, 1600);

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
        contentHash,
        1200,
        1600,
        rendered.data.length,
      );

    await reply.send({
      id: Number(result.lastInsertRowid),
      filename,
      content_hash: contentHash,
      byte_size: rendered.data.length,
    });
  });

  app.delete(`${basePath}/photos/:id`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const photo = db
      .prepare(
        `SELECT p.id, p.content_hash FROM photos p
         JOIN galleries g ON g.id = p.gallery_id
         WHERE p.id = ? AND g.user_id = ?`,
      )
      .get(Number(id), userId) as { id: number; content_hash: string } | undefined;

    if (!photo) {
      await reply.code(404).send({ error: "unknown photo" });
      return;
    }

    db.prepare("DELETE FROM photos WHERE id = ?").run(Number(id));
    if (photo.content_hash) await assets.remove(photo.content_hash);

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
                battery_mv, firmware_version, displayed_asset, last_seen_at, created_at
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
    }>;

    db.prepare(
      `INSERT INTO device_policies (device_id) VALUES (?)
       ON CONFLICT(device_id) DO NOTHING`,
    ).run(Number(id));

    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length > 0) {
      db.prepare(`UPDATE device_policies SET ${fields.join(", ")} WHERE device_id = ?`).run(
        ...values,
        Number(id),
      );
    }

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
    await reply.send({
      revision: window.revision,
      items: window.items.map((item) => ({
        at: new Date(item.at).toISOString(),
        asset: item.asset,
      })),
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
