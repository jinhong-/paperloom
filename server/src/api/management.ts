/**
 * Management API.
 *
 * The endpoints behind the web UI: galleries, photos, devices, and the
 * session login. These are the human-facing side of the server and are
 * authenticated with a session cookie rather than a device signature.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AssetStore } from "../assets/store.js";
import type { Db } from "../db/index.js";
import type { ScheduleService } from "../schedule/service.js";
import { EVERY_DAY } from "../schedule/rules.js";
import { isRotation } from "../panel.js";
import { PRESETS } from "../tone.js";
import { GalleryPhotoService } from "../gallery/photos.js";

export interface ManagementOptions {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly schedules: ScheduleService;
  readonly basePath: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A rule about when a gallery changes its picture, and how.
 *
 * The gap between two pictures and the way the pictures are picked are
 * both said by the rule.
 */
interface GalleryRuleBody {
  days?: number;
  start_minute?: number;
  end_minute?: number;
  min_interval?: number | null;
  max_interval?: number | null;
  priority?: number;
  rotation_mode?: "random" | "sequential";
}

export function registerManagementApi(app: FastifyInstance, options: ManagementOptions): void {
  const { db, assets, schedules, basePath } = options;

  /* Adding a photo is shared with the Telegram bot, so it lives in one
   * place rather than being written out here as well. */
  const photos = new GalleryPhotoService({ db, assets, schedules });

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
   * Note that the plans of every device that shows a gallery are to
   * change.
   *
   * A gallery's contents and policy decide what its devices are shown and
   * when, so a change to the gallery means their plans are out of date.
   *
   * The plans are not thrown away. They are changed at each frame's next
   * check-in, so that the frame and the server keep working to the same
   * plan until then.
   */
  function invalidateGallery(galleryId: number): void {
    photos.invalidateGallery(galleryId, Date.now());
  }

  /**
   * Whether a rule about when a gallery changes makes sense.
   *
   * The days are a bit mask of the seven days of the week, and the times
   * are minutes from midnight. A rule with no interval at all is the
   * gallery being still for that time, which is allowed; a rule with one
   * interval has to have a sensible one.
   */
  function validRule(body: {
    days?: number;
    start_minute?: number;
    end_minute?: number;
    min_interval?: number | null;
    max_interval?: number | null;
    rotation_mode?: "random" | "sequential";
  }): boolean {
    if (body.days !== undefined && (!Number.isInteger(body.days) || body.days < 0 || body.days > 127)) {
      return false;
    }
    for (const key of ["start_minute", "end_minute"] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0 || value > 1440) return false;
    }
    for (const key of ["min_interval", "max_interval"] as const) {
      const value = body[key];
      if (value === undefined || value === null) continue;
      if (!Number.isFinite(value) || value < 60 || value > 604_800) return false;
    }
    if (
      body.rotation_mode !== undefined &&
      body.rotation_mode !== "random" &&
      body.rotation_mode !== "sequential"
    ) {
      return false;
    }
    return true;
  }

  /**
   * Add a rule to a gallery.
   */
  function insertRule(galleryId: number, body: GalleryRuleBody): void {
    db.prepare(
      `INSERT INTO gallery_schedule_rules
         (gallery_id, days, start_minute, end_minute, min_interval, max_interval,
          priority, rotation_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      galleryId,
      body.days ?? 127,
      body.start_minute ?? 0,
      body.end_minute ?? 1440,
      body.min_interval ?? null,
      body.max_interval ?? null,
      body.priority ?? 0,
      body.rotation_mode ?? "random",
    );
  }

  // ---------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------

  /**
   * Whether the first account can still be made.
   *
   * The sign-in page offers registration only when this is true, so that
   * the page does not offer something the server will refuse.
   */
  app.get(`${basePath}/auth/registration`, async (_request, reply) => {
    const owners = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    await reply.send({ open: owners.n === 0 });
  });

  app.post(`${basePath}/auth/register`, async (request, reply) => {
    /* Only the first account may be made this way.
     *
     * That account is the owner's, and the one that holds the frames.
     * Everybody else is invited by the owner, so that nobody can simply
     * make themselves an account and start looking at the owner's
     * photos. */
    const owners = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    if (owners.n > 0) {
      await reply.code(403).send({ error: "this server already has an owner" });
      return;
    }

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

  /**
   * Who has access to this server.
   *
   * The owner sees this, and uses it to invite people.
   */
  app.get(`${basePath}/users`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const users = db
      .prepare(
        `SELECT id, username, created_at FROM users ORDER BY id`,
      )
      .all() as Array<{ id: number; username: string; created_at: string }>;

    const invitations = db
      .prepare(
        `SELECT id, username, invite_code, invited_by, created_at, accepted_at
         FROM invitations ORDER BY id`,
      )
      .all() as Array<{
        id: number;
        username: string;
        invite_code: string;
        invited_by: number;
        created_at: string;
        accepted_at: string | null;
      }>;

    await reply.send({
      users,
      invitations: invitations.map((invitation) => ({
        id: invitation.id,
        username: invitation.username,
        invited_by: invitation.invited_by,
        created_at: invitation.created_at,
        accepted_at: invitation.accepted_at,
      })),
    });
  });

  /**
   * Invite somebody to this server.
   *
   * The invitation gives them a code to follow, and they choose their
   * own password with it. The code is shown once, when it is made, so
   * that it can be given to them.
   */
  app.post(`${basePath}/users/invitations`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const body = request.body as { username?: string };
    const username = body?.username?.trim();
    if (!username) {
      await reply.code(400).send({ error: "username is required" });
      return;
    }

    const existing = db
      .prepare("SELECT 1 FROM users WHERE username = ?")
      .get(username);
    if (existing) {
      await reply.code(409).send({ error: "username already taken" });
      return;
    }

    const pending = db
      .prepare("SELECT 1 FROM invitations WHERE username = ? AND accepted_at IS NULL")
      .get(username);
    if (pending) {
      await reply.code(409).send({ error: "there is already an invitation for that name" });
      return;
    }

    const inviteCode = randomBytes(12).toString("base64url");

    const result = db
      .prepare(
        `INSERT INTO invitations (username, invite_code, invited_by)
         VALUES (?, ?, ?)`,
      )
      .run(username, inviteCode, userId);

    await reply.send({
      id: Number(result.lastInsertRowid),
      username,
      invite_code: inviteCode,
    });
  });

  /**
   * Look at an invitation, so that the person can see who invited them.
   */
  app.get(`${basePath}/invitations/:code`, async (request, reply) => {
    const { code } = request.params as { code: string };

    const invitation = db
      .prepare(
        `SELECT username, invited_by, accepted_at FROM invitations WHERE invite_code = ?`,
      )
      .get(code) as
      | { username: string; invited_by: number; accepted_at: string | null }
      | undefined;

    if (!invitation) {
      await reply.code(404).send({ error: "unknown invitation" });
      return;
    }
    if (invitation.accepted_at) {
      await reply.code(410).send({ error: "this invitation has already been used" });
      return;
    }

    const inviter = db
      .prepare("SELECT username FROM users WHERE id = ?")
      .get(invitation.invited_by) as { username: string } | undefined;

    await reply.send({
      username: invitation.username,
      invited_by: inviter?.username ?? null,
    });
  });

  /**
   * Accept an invitation: choose a password and become a user.
   */
  app.post(`${basePath}/invitations/:code`, async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = request.body as { password?: string };

    if (!body?.password) {
      await reply.code(400).send({ error: "password is required" });
      return;
    }
    if (body.password.length < 8) {
      await reply.code(400).send({ error: "password must be at least 8 characters" });
      return;
    }

    const invitation = db
      .prepare(
        `SELECT id, username, accepted_at FROM invitations WHERE invite_code = ?`,
      )
      .get(code) as
      | { id: number; username: string; accepted_at: string | null }
      | undefined;

    if (!invitation) {
      await reply.code(404).send({ error: "unknown invitation" });
      return;
    }
    if (invitation.accepted_at) {
      await reply.code(410).send({ error: "this invitation has already been used" });
      return;
    }

    const existing = db
      .prepare("SELECT 1 FROM users WHERE username = ?")
      .get(invitation.username);
    if (existing) {
      await reply.code(409).send({ error: "username already taken" });
      return;
    }

    const result = db
      .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run(invitation.username, hashPassword(body.password));

    db.prepare("UPDATE invitations SET password_hash = ?, accepted_at = ? WHERE id = ?").run(
      hashPassword(body.password),
      new Date().toISOString(),
      invitation.id,
    );

    await reply.send({ user_id: Number(result.lastInsertRowid), username: invitation.username });
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
        secure: request.protocol === "https",
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
        `SELECT g.id, g.name,
                g.quiet_start, g.quiet_end, g.enabled, g.tone_preset, g.telegram_mode,
                g.schedule_enabled,
                (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id) AS photo_count,
                (SELECT COUNT(*) FROM gallery_schedule_rules r WHERE r.gallery_id = g.id) AS rule_count,
                (SELECT mp.photo_id FROM gallery_manual_pictures mp WHERE mp.gallery_id = g.id)
                  AS manual_photo_id
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
      schedule_enabled?: boolean;
      rules?: GalleryRuleBody[];
    };
    if (!body?.name) {
      await reply.code(400).send({ error: "name is required" });
      return;
    }

    const result = db
      .prepare("INSERT INTO galleries (user_id, name) VALUES (?, ?)")
      .run(userId, body.name);

    const galleryId = Number(result.lastInsertRowid);

    /* The rules say how often the gallery changes and how the pictures are
     * picked, and they are made with the gallery so that it is made the
     * way it is going to be used. */
    for (const rule of body.rules ?? []) {
      if (!validRule(rule)) {
        await reply.code(400).send({ error: "the rule does not make sense" });
        return;
      }
      insertRule(galleryId, rule);
    }

    if (body.schedule_enabled === false) {
      db.prepare("UPDATE galleries SET schedule_enabled = 0 WHERE id = ?").run(galleryId);
    }

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
      quiet_start: number | null;
      quiet_end: number | null;
      enabled: boolean;
      tone_preset: string;
      telegram_mode: "queue" | "latest";
      schedule_enabled: boolean;
    }>;

    /* The way the pictures are prepared has to be one we know. */
    if (body.tone_preset !== undefined && !PRESETS[body.tone_preset]) {
      await reply.code(400).send({ error: "unknown way of preparing the pictures" });
      return;
    }

    /* The way the pictures from a chat arrive has to be one we know. */
    if (body.telegram_mode !== undefined && body.telegram_mode !== "queue" && body.telegram_mode !== "latest") {
      await reply.code(400).send({ error: "unknown way of receiving pictures" });
      return;
    }

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

    /* The way of preparing the pictures is the gallery's, so changing it
     * changes every picture in the gallery. The pictures are rendered
     * again from their originals, which takes a moment. */
    if (body.tone_preset !== undefined) {
      await photos.rerenderGallery(Number(id));
    }

    invalidateGallery(Number(id));

    await reply.send({ status: "ok" });
  });

  // ---------------------------------------------------------------------
  // When a gallery changes its picture
  // ---------------------------------------------------------------------

  /**
   * The rules that say when a gallery changes its picture.
   */
  app.get(`${basePath}/galleries/:id/schedule-rules`, async (request, reply) => {
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

    const rules = schedules.galleryRulesFor(Number(id));
    await reply.send(
      rules.map((rule) => ({
        id: rule.id,
        days: rule.days,
        start_minute: rule.startMinute,
        end_minute: rule.endMinute,
        min_interval: rule.minInterval,
        max_interval: rule.maxInterval,
        priority: rule.priority,
        rotation_mode: rule.rotationMode,
      })),
    );
  });

  /**
   * Add a rule to a gallery.
   */
  app.post(`${basePath}/galleries/:id/schedule-rules`, async (request, reply) => {
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

    const body = request.body as GalleryRuleBody;

    if (!validRule(body)) {
      await reply.code(400).send({ error: "the rule does not make sense" });
      return;
    }

    insertRule(Number(id), body);

    invalidateGallery(Number(id));

    await reply.send({ status: "ok" });
  });

  /**
   * Change a rule.
   */
  app.patch(`${basePath}/galleries/:id/schedule-rules/:ruleId`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id, ruleId } = request.params as { id: string; ruleId: string };
    const gallery = db
      .prepare("SELECT id FROM galleries WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!gallery) {
      await reply.code(404).send({ error: "unknown gallery" });
      return;
    }

    const body = request.body as GalleryRuleBody;

    if (!validRule(body)) {
      await reply.code(400).send({ error: "the rule does not make sense" });
      return;
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length > 0) {
      const result = db
        .prepare(
          `UPDATE gallery_schedule_rules SET ${fields.join(", ")},
             updated_at = datetime('now')
           WHERE id = ? AND gallery_id = ?`,
        )
        .run(...values, Number(ruleId), Number(id));
      if (result.changes === 0) {
        await reply.code(404).send({ error: "unknown rule" });
        return;
      }
    }

    invalidateGallery(Number(id));

    await reply.send({ status: "ok" });
  });

  /**
   * Remove a rule.
   */
  app.delete(`${basePath}/galleries/:id/schedule-rules/:ruleId`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id, ruleId } = request.params as { id: string; ruleId: string };
    const gallery = db
      .prepare("SELECT id FROM galleries WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!gallery) {
      await reply.code(404).send({ error: "unknown gallery" });
      return;
    }

    const result = db
      .prepare("DELETE FROM gallery_schedule_rules WHERE id = ? AND gallery_id = ?")
      .run(Number(ruleId), Number(id));
    if (result.changes === 0) {
      await reply.code(404).send({ error: "unknown rule" });
      return;
    }

    invalidateGallery(Number(id));

    await reply.send({ status: "ok" });
  });

  // ---------------------------------------------------------------------
  // The picture a gallery shows when its schedule is off
  // ---------------------------------------------------------------------

  /**
   * The picture a gallery shows when it has no schedule.
   *
   * A gallery with no rules changes only when the owner says so. This is
   * the picture it shows then.
   */
  app.get(`${basePath}/galleries/:id/manual-picture`, async (request, reply) => {
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

    const manual = db
      .prepare(
        `SELECT mp.photo_id, mp.content_hash, p.filename
         FROM gallery_manual_pictures mp
         JOIN photos p ON p.id = mp.photo_id
         WHERE mp.gallery_id = ?`,
      )
      .get(Number(id)) as
      | { photo_id: number; content_hash: string; filename: string }
      | undefined;

    await reply.send({ picture: manual ?? null });
  });

  /**
   * Set the picture a gallery shows when it has no schedule.
   *
   * The picture has to be one of the gallery's own, so that it is
   * rendered for the panel in the first place.
   */
  app.put(`${basePath}/galleries/:id/manual-picture`, async (request, reply) => {
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

    const body = request.body as { photo_id?: number };
    if (!body?.photo_id) {
      await reply.code(400).send({ error: "photo_id is required" });
      return;
    }

    const photo = db
      .prepare("SELECT id, content_hash FROM photos WHERE id = ? AND gallery_id = ?")
      .get(body.photo_id, Number(id)) as { id: number; content_hash: string | null } | undefined;
    if (!photo) {
      await reply.code(404).send({ error: "unknown photo" });
      return;
    }
    if (!photo.content_hash) {
      await reply.code(400).send({ error: "the photo has not been rendered yet" });
      return;
    }

    db.prepare(
      `INSERT INTO gallery_manual_pictures (gallery_id, photo_id, content_hash)
       VALUES (?, ?, ?)
       ON CONFLICT(gallery_id) DO UPDATE SET
         photo_id = excluded.photo_id,
         content_hash = excluded.content_hash,
         updated_at = datetime('now')`,
    ).run(Number(id), photo.id, photo.content_hash);

    invalidateGallery(Number(id));

    await reply.send({ status: "ok" });
  });

  /**
   * Stop the gallery showing a set picture.
   */
  app.delete(`${basePath}/galleries/:id/manual-picture`, async (request, reply) => {
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

    db.prepare("DELETE FROM gallery_manual_pictures WHERE gallery_id = ?").run(Number(id));

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

    const added = await photos.addPhoto(Number(id), body.filename, source);

    await reply.send({
      id: added.id,
      filename: added.filename,
      content_hash: added.contentHash,
      byte_size: added.byteSize,
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
                last_seen_at, created_at, gallery_id
         FROM devices WHERE user_id = ? ORDER BY name`,
      )
      .all(userId) as Array<Record<string, unknown> & { id: number }>;

    /* The gallery a frame shows, and the policy that decides how it
     * checks in, come with it.
     *
     * Without them the management page has to guess, and what it shows is
     * not what the frame is actually doing. */
    const policyRows = db
      .prepare(
        `SELECT device_id, sync_interval, lookahead, quiet_start, quiet_end
         FROM device_policies`,
      )
      .all() as Array<{
      device_id: number;
      sync_interval: number;
      lookahead: number;
      quiet_start: number | null;
      quiet_end: number | null;
    }>;

    const policyByDevice = new Map(policyRows.map((row) => [row.device_id, row]));

    await reply.send(
      devices.map((device) => {
        const policy = policyByDevice.get(device.id);
        return {
          ...device,
          policy: policy
            ? {
                sync_interval: policy.sync_interval,
                lookahead: policy.lookahead,
                quiet_start: policy.quiet_start,
                quiet_end: policy.quiet_end,
              }
            : null,
        };
      }),
    );
  });

  app.post(`${basePath}/devices/:id/galleries`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const body = request.body as { gallery_id?: number };

    const device = db
      .prepare("SELECT id, gallery_id FROM devices WHERE id = ? AND user_id = ?")
      .get(Number(id), userId) as { id: number; gallery_id: number | null } | undefined;
    if (!device) {
      await reply.code(404).send({ error: "unknown device" });
      return;
    }
    if (!body?.gallery_id) {
      await reply.code(400).send({ error: "gallery_id is required" });
      return;
    }

    /* The gallery has to be the owner's. */
    const gallery = db
      .prepare("SELECT id FROM galleries WHERE id = ? AND user_id = ?")
      .get(body.gallery_id, userId);
    if (!gallery) {
      await reply.code(404).send({ error: "unknown gallery" });
      return;
    }

    /* A frame shows one gallery. Assigning a different one replaces the
     * one it had, rather than being refused, so that changing a frame's
     * gallery is a single step. */
    db.prepare("UPDATE devices SET gallery_id = ? WHERE id = ?").run(body.gallery_id, Number(id));

    /* The device's schedule changes with its gallery, so the windows
     * that were materialised from the old one are no longer right. */
    schedules.invalidate(Number(id), Date.now());

    await reply.send({ status: "ok" });
  });

  app.delete(`${basePath}/devices/:id/galleries/:galleryId`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id, galleryId } = request.params as { id: string; galleryId: string };
    const device = db
      .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
      .get(Number(id), userId);
    if (!device) {
      await reply.code(404).send({ error: "unknown device" });
      return;
    }

    /* The frame is only left without a gallery if the gallery being
     * removed is the one it has. */
    db.prepare("UPDATE devices SET gallery_id = NULL WHERE id = ? AND gallery_id = ?").run(
      Number(id),
      Number(galleryId),
    );

    schedules.invalidate(Number(id), Date.now());

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

    /* The time zone is a property of the frame too: it says where the
     * frame hangs, and the schedule is built against it. The policy keeps
     * a copy as a fallback, but the frame's own value is the one that
     * counts, so this is written to both. */
    if (body.timezone !== undefined) {
      db.prepare("UPDATE devices SET timezone = ? WHERE id = ?").run(body.timezone, Number(id));
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
      schedules.invalidate(Number(id), Date.now());
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

    /* A rule that is already there is not added a second time.
     *
     * Two identical rules cover exactly the same moments with the same
     * interval, so the second one changes nothing about how the frame
     * behaves. It only makes the list of rules harder to read, and makes
     * the owner wonder which of the two is the one that matters. */
    const existing = db
      .prepare(
        `SELECT id FROM device_sync_rules
         WHERE device_id = ? AND days = ? AND start_minute = ? AND end_minute = ?
           AND sync_interval = ? AND priority = ?`,
      )
      .get(Number(id), days, startMinute, endMinute, syncInterval, priority) as
      | { id: number }
      | undefined;

    if (existing) {
      await reply.send({ id: existing.id });
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

    /* Changing a rule must not turn it into a copy of another one.
     *
     * The same reasoning as when a rule is added: two identical rules
     * cover the same moments with the same interval, so the second one
     * changes nothing and only makes the list harder to read. */
    if (fields.length > 0) {
      const current = db
        .prepare(
          `SELECT days, start_minute, end_minute, sync_interval, priority
           FROM device_sync_rules WHERE id = ? AND device_id = ?`,
        )
        .get(Number(ruleId), Number(id)) as {
          days: number;
          start_minute: number;
          end_minute: number;
          sync_interval: number;
          priority: number;
        };

      const merged = { ...current };
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (value === undefined) continue;
        if (key in merged) (merged as Record<string, unknown>)[key] = value;
      }

      const duplicate = db
        .prepare(
          `SELECT id FROM device_sync_rules
           WHERE device_id = ? AND days = ? AND start_minute = ? AND end_minute = ?
             AND sync_interval = ? AND priority = ? AND id != ?`,
        )
        .get(
          Number(id),
          merged.days,
          merged.start_minute,
          merged.end_minute,
          merged.sync_interval,
          merged.priority,
          Number(ruleId),
        ) as { id: number } | undefined;

      if (duplicate) {
        await reply.code(409).send({ error: "an identical rule already exists" });
        return;
      }
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

    const now = Date.now();

    /* The plan the frame is following, and the plan it will be following
     * once the change has reached it.
     *
     * The frame is given the plan it is following until it checks in, and
     * the change is put in at that moment. The projected plan is what it
     * will be then, so that the owner can see what a change is going to do
     * before it happens. */
    const plans = schedules.planWithProjection(Number(id), now);

    /* Only the events that are still to come.
     *
     * The window is planned ahead of time, so it holds events the frame
     * has already shown. Those are of no interest to the owner: what they
     * want to see is what the frame is going to show next. */
    const upcoming = plans.current.items.filter((item) => item.at > now);
    const projected =
      plans.projected === null
        ? null
        : plans.projected.items.filter((item) => item.at > now);

    /* The photo behind each asset, so the owner sees which picture is
     * going to be shown rather than a hash. */
    const photos = db
      .prepare(
        `SELECT id, content_hash, filename FROM photos
         WHERE content_hash IS NOT NULL`,
      )
      .all() as Array<{ id: number; content_hash: string; filename: string }>;
    const photoByHash = new Map(photos.map((p) => [p.content_hash, p]));

    const describe = (items: typeof plans.current.items) =>
      items.map((item) => {
        const photo = photoByHash.get(item.asset);
        return {
          at: new Date(item.at).toISOString(),
          asset: item.asset,
          filename: photo?.filename ?? null,
          photo_id: photo?.id ?? null,
        };
      });

    await reply.send({
      revision: plans.current.revision,
      items: describe(upcoming),
      /* When the plan changes, if it is about to. */
      handover_at: plans.handoverAt === null ? null : new Date(plans.handoverAt).toISOString(),
      /* What the plan will be once it has changed. */
      projected: projected === null ? null : describe(projected),
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
