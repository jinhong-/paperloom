/**
 * Telegram API.
 *
 * The management endpoints for the Telegram bot: setting a gallery's
 * bot token, adding the chats that talk to it, and looking at the
 * pictures that are waiting to be rendered.
 *
 * The bot itself does not use these endpoints. It polls Telegram for
 * updates, so there is no webhook to secure and the server does not have
 * to be reachable from the public internet.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AssetStore } from "../assets/store.js";
import type { Db } from "../db/index.js";
import { GalleryPhotoService } from "../gallery/photos.js";
import { PhotoQueue } from "../queue/photos.js";
import { TelegramAccessService } from "../telegram/access.js";
import type { TelegramBotManager } from "../telegram/manager.js";

export interface TelegramApiOptions {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly schedules: import("../schedule/service.js").ScheduleService;
  readonly basePath: string;
  /** The bots, and the pollers that go with them. */
  readonly manager: TelegramBotManager;
  /** Who may send pictures to a bot. */
  readonly access: TelegramAccessService;
  /** The gallery service, for filing a picture that was held. */
  readonly photos: GalleryPhotoService;
}

export function registerTelegramApi(app: FastifyInstance, options: TelegramApiOptions): void {
  const { db, assets, schedules, basePath, manager, access, photos } = options;

  const queue = new PhotoQueue({ db, assets, photos });

  /**
   * Require a signed-in user.
   */
  async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<number | null> {
    const sessionToken = request.cookies["paperloom_session"];
    if (!sessionToken) {
      await reply.code(401).send({ error: "not signed in" });
      return null;
    }

    const session = db
      .prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
      .get(sessionToken) as { user_id: number; expires_at: string } | undefined;

    if (!session || new Date(session.expires_at).getTime() < Date.now()) {
      await reply.code(401).send({ error: "session expired" });
      return null;
    }

    return session.user_id;
  }

  /**
   * Require the owner of a gallery.
   *
   * The bot's token is the gallery's secret, and only the person who
   * owns the gallery has any business setting it.
   */
  async function requireGalleryOwner(
    request: FastifyRequest,
    reply: FastifyReply,
    galleryId: number,
  ): Promise<number | null> {
    const userId = await requireUser(request, reply);
    if (userId === null) return null;

    if (!ownedGallery(galleryId, userId)) {
      await reply.code(404).send({ error: "unknown gallery" });
      return null;
    }

    return userId;
  }

  /**
   * A gallery the signed-in person owns.
   *
   * A bot belongs to a gallery, so the person who owns the gallery owns
   * its bot: they set its token, and they decide which chats may file
   * pictures into it. The bot is a secret for that gallery rather than
   * for the whole server.
   */
  function ownedGallery(galleryId: number, userId: number): boolean {
    const row = db
      .prepare("SELECT id FROM galleries WHERE id = ? AND user_id = ?")
      .get(galleryId, userId);
    return row !== undefined;
  }

  // ---------------------------------------------------------------------
  // The bot
  // ---------------------------------------------------------------------

  /**
   * The bots that are set up, and the chats that talk to them.
   */
  app.get(`${basePath}/telegram/bots`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const rows = db
      .prepare(
        `SELECT b.id, b.gallery_id, b.username, b.error, b.polling, b.created_at,
                g.name AS gallery_name,
                (SELECT COUNT(*) FROM telegram_user_access a
                  WHERE a.bot_id = b.id AND a.status = 'allowed') AS allowed_count,
                (SELECT COUNT(*) FROM telegram_user_access a
                  WHERE a.bot_id = b.id AND a.status = 'pending') AS pending_count
         FROM telegram_bots b
         JOIN galleries g ON g.id = b.gallery_id
         WHERE g.user_id = ?
         ORDER BY g.name`,
      )
      .all(userId) as Array<{
      id: number;
      gallery_id: number;
      username: string | null;
      error: string | null;
      polling: number;
      created_at: string;
      gallery_name: string;
      allowed_count: number;
      pending_count: number;
    }>;

    await reply.send({
      bots: rows.map((row) => ({
        id: row.id,
        gallery_id: row.gallery_id,
        gallery_name: row.gallery_name,
        username: row.username,
        error: row.error,
        polling: row.polling === 1,
        allowed_count: row.allowed_count,
        pending_count: row.pending_count,
        created_at: row.created_at,
      })),
    });
  });

  /**
   * Set a gallery's bot token.
   *
   * The token is checked with Telegram before it is saved, so that a
   * mistyped token is reported straight away rather than showing up
   * later as every picture failing.
   */
  app.post(`${basePath}/telegram/galleries/:id/bot`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const galleryId = Number(id);

    const userId = await requireGalleryOwner(request, reply, galleryId);
    if (userId === null) return;

    const body = request.body as { token?: string };
    const token = body?.token?.trim();
    if (!token) {
      await reply.code(400).send({ error: "token is required" });
      return;
    }

    /* Two galleries must not share a bot, because a picture arriving
     * through it could be filed into either. */
    const existing = manager.botForToken(token);
    if (existing && existing.gallery_id !== galleryId) {
      await reply.code(409).send({
        error: "that bot already belongs to another gallery",
      });
      return;
    }

    /* The token is checked before anything is saved, so that a mistyped
     * token is reported here and does not leave a broken bot behind
     * that looks as though it is working. */
    const check = await manager.checkToken(token);
    if (!check.ok) {
      await reply.code(502).send({
        error: check.error ?? "Telegram did not accept that token",
      });
      return;
    }

    db.prepare(
      `INSERT INTO telegram_bots (gallery_id, token, username)
       VALUES (?, ?, ?)
       ON CONFLICT(gallery_id) DO UPDATE SET
         token = excluded.token,
         username = excluded.username,
         error = NULL,
         updated_at = datetime('now')`,
    ).run(galleryId, token, check.username ?? null);

    const bot = manager.botForGallery(galleryId);
    if (!bot) {
      await reply.code(500).send({ error: "the bot could not be saved" });
      return;
    }

    await manager.start(bot);

    await reply.send({
      status: "ok",
      gallery_id: galleryId,
      username: check.username ?? null,
    });
  });

  /**
   * Take a gallery's bot away.
   */
  app.delete(`${basePath}/telegram/galleries/:id/bot`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const galleryId = Number(id);

    const userId = await requireGalleryOwner(request, reply, galleryId);
    if (userId === null) return;

    const bot = manager.botForGallery(galleryId);
    if (bot) {
      await manager.stop(bot.id);
    }

    db.prepare("DELETE FROM telegram_bots WHERE gallery_id = ?").run(galleryId);

    await reply.send({ status: "ok" });
  });

  // ---------------------------------------------------------------------
  // The people who talk to the bots
  // ---------------------------------------------------------------------

  /**
   * The people who talk to a bot, and what they may do with it.
   *
   * The people waiting to be let in are the ones the owner has to decide
   * about: somebody who has sent a picture and has not been allowed yet.
   */
  app.get(`${basePath}/telegram/bots/:id/people`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id } = request.params as { id: string };
    const botId = Number(id);

    const bot = db
      .prepare(
        `SELECT b.id, b.gallery_id FROM telegram_bots b
         JOIN galleries g ON g.id = b.gallery_id
         WHERE b.id = ? AND g.user_id = ?`,
      )
      .get(botId, userId);
    if (!bot) {
      await reply.code(404).send({ error: "unknown bot" });
      return;
    }

    await reply.send({
      pending: access.pendingFor(botId),
      allowed: access.allowedFor(botId),
    });
  });

  /**
   * Allow a person to send pictures to a bot.
   *
   * The pictures they sent while they were waiting are then filed, so
   * that they are not lost.
   */
  app.post(`${basePath}/telegram/bots/:id/people/:telegramId/allow`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id, telegramId } = request.params as { id: string; telegramId: string };
    const botId = Number(id);

    const bot = db
      .prepare(
        `SELECT b.id, b.gallery_id FROM telegram_bots b
         JOIN galleries g ON g.id = b.gallery_id
         WHERE b.id = ? AND g.user_id = ?`,
      )
      .get(botId, userId) as { id: number; gallery_id: number } | undefined;
    if (!bot) {
      await reply.code(404).send({ error: "unknown bot" });
      return;
    }

    access.allow(botId, telegramId, userId);

    /* The pictures they sent while they were waiting are filed now. */
    const held = access.releaseHeld(bot.gallery_id, telegramId);
    let filed = 0;
    for (const picture of held) {
      const bytes = await assets.getSource(picture.sourceHash);
      if (!bytes) continue;
      await queue.enqueue(bot.gallery_id, picture.filename, bytes, "telegram");
      filed++;
    }

    await reply.send({ status: "allowed", filed });
  });

  /**
   * Block a person from sending pictures to a bot.
   *
   * The pictures they sent while they were waiting are thrown away, since
   * they were only waiting to be seen.
   */
  app.post(`${basePath}/telegram/bots/:id/people/:telegramId/block`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const { id, telegramId } = request.params as { id: string; telegramId: string };
    const botId = Number(id);

    const bot = db
      .prepare(
        `SELECT b.id, b.gallery_id FROM telegram_bots b
         JOIN galleries g ON g.id = b.gallery_id
         WHERE b.id = ? AND g.user_id = ?`,
      )
      .get(botId, userId) as { id: number; gallery_id: number } | undefined;
    if (!bot) {
      await reply.code(404).send({ error: "unknown bot" });
      return;
    }

    access.block(botId, telegramId, userId);

    /* The pictures they sent are thrown away. The bytes themselves are
     * left alone: they are kept by their content, so the same picture
     * sent twice is only kept once, and removing it would take away
     * somebody else's picture too. */
    const held = access.releaseHeld(bot.gallery_id, telegramId);

    await reply.send({ status: "blocked", discarded: held.length });
  });

  // ---------------------------------------------------------------------
  // The queue
  // ---------------------------------------------------------------------

  /**
   * The pictures waiting to be rendered.
   */
  app.get(`${basePath}/telegram/queue`, async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (userId === null) return;

    const rows = db
      .prepare(
        `SELECT j.id, j.filename, j.status, j.origin, j.attempts, j.error, j.created_at,
                g.name AS gallery_name
         FROM photo_jobs j
         JOIN galleries g ON g.id = j.gallery_id
         WHERE g.user_id = ?
         ORDER BY j.id DESC
         LIMIT 100`,
      )
      .all(userId);

    await reply.send({ pending: queue.countPending(), jobs: rows });
  });
}
