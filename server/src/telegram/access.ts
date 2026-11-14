/**
 * Who may send pictures to a bot.
 *
 * A Telegram user is not a Paperloom user. They have no account and no
 * password: their identity is the id Telegram gives them, and the bot's
 * token is what proves that a message came through the bot it was sent
 * to.
 *
 * A person who sends a picture to a bot they are not known to is not
 * turned away. They are recorded, their picture is held, and they show up
 * in the management interface as somebody to allow or to block. That way
 * a person can send a picture and see that it was received, rather than
 * being met with silence, and the owner decides who may fill the gallery.
 *
 * The access is per bot, and therefore per gallery. Allowing somebody to
 * one gallery's bot says nothing about any other.
 */

import type { Db } from "../db/index.js";

/** Whether a person may send pictures to a bot. */
export type AccessStatus = "allowed" | "pending" | "blocked";

/** A person who talks to a bot. */
export interface TelegramPerson {
  readonly id: number;
  readonly telegramId: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/** A person's access to a bot. */
export interface PersonAccess {
  readonly person: TelegramPerson;
  readonly botId: number;
  readonly status: AccessStatus;
  readonly decidedAt: string | null;
  /** The picture that is waiting for a decision, if there is one. */
  readonly heldJobId: number | null;
  readonly heldFilename: string | null;
  /** How many pictures are waiting for a decision. */
  readonly heldCount: number;
}

export interface TelegramAccessOptions {
  readonly db: Db;
}

export class TelegramAccessService {
  constructor(private readonly options: TelegramAccessOptions) {}

  /**
   * What a person may do with a bot.
   *
   * A person who has never sent anything has no access at all, and is
   * treated as pending: their picture is held and they show up as
   * somebody to decide about.
   */
  statusFor(botId: number, telegramId: string): AccessStatus {
    const row = this.options.db
      .prepare(
        `SELECT a.status
         FROM telegram_user_access a
         JOIN telegram_users u ON u.id = a.user_id
         WHERE a.bot_id = ? AND u.telegram_id = ?`,
      )
      .get(botId, telegramId) as { status: AccessStatus } | undefined;

    return row?.status ?? "pending";
  }

  /**
   * Record a person, and give them access to a bot.
   *
   * A person who is already known keeps the access they had. A person
   * who is new is given "pending", and the first time they send
   * something.
   *
   * @return the person's row id.
   */
  record(botId: number, telegramId: string, username: string | null, displayName: string | null): number {
    const { db } = this.options;

    db.prepare(
      `INSERT INTO telegram_users (telegram_id, username, display_name)
       VALUES (?, ?, ?)
       ON CONFLICT (telegram_id) DO UPDATE SET
         username = COALESCE(excluded.username, telegram_users.username),
         display_name = COALESCE(excluded.display_name, telegram_users.display_name),
         last_seen_at = datetime('now')`,
    ).run(telegramId, username, displayName);

    const person = db
      .prepare("SELECT id FROM telegram_users WHERE telegram_id = ?")
      .get(telegramId) as { id: number };

    /* The access is only given to somebody who has none. Somebody who
     * was blocked stays blocked, and somebody who was allowed stays
     * allowed. */
    db.prepare(
      `INSERT INTO telegram_user_access (user_id, bot_id, status)
       VALUES (?, ?, 'pending')
       ON CONFLICT (user_id, bot_id) DO NOTHING`,
    ).run(person.id, botId);

    return person.id;
  }

  /**
   * Allow a person to send pictures to a bot.
   */
  allow(botId: number, telegramId: string, decidedBy: number): void {
    this.decide(botId, telegramId, "allowed", decidedBy);
  }

  /**
   * Block a person from sending pictures to a bot.
   */
  block(botId: number, telegramId: string, decidedBy: number): void {
    this.decide(botId, telegramId, "blocked", decidedBy);
  }

  /**
   * Decide whether a person may send pictures to a bot.
   *
   * The person is recorded if they are not known yet, so that the owner
   * can allow or block somebody the server has never heard of. That is
   * not a case that arises on its own, but it makes the decision
   * unconditional: there is always somebody to decide about.
   */
  private decide(
    botId: number,
    telegramId: string,
    status: AccessStatus,
    decidedBy: number,
  ): void {
    this.record(botId, telegramId, null, null);

    this.options.db
      .prepare(
        `UPDATE telegram_user_access
         SET status = ?, decided_by = ?, decided_at = datetime('now'),
             updated_at = datetime('now')
         WHERE bot_id = ?
           AND user_id = (SELECT id FROM telegram_users WHERE telegram_id = ?)`,
      )
      .run(status, decidedBy, botId, telegramId);
  }

  /**
   * Hold a picture from somebody who is not allowed yet.
   *
   * The bytes are already in the asset store, so only the hash has to be
   * kept. The picture waits here until the owner allows the person, and
   * is filed then.
   */
  hold(
    galleryId: number,
    telegramId: string,
    sourceHash: string,
    filename: string,
    chatId: string | null,
  ): number {
    const result = this.options.db
      .prepare(
        `INSERT INTO held_photos (gallery_id, telegram_id, source_hash, filename, chat_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(galleryId, telegramId, sourceHash, filename, chatId);
    return Number(result.lastInsertRowid);
  }

  /**
   * The pictures held for a person, oldest first.
   */
  heldFor(galleryId: number, telegramId: string): Array<{
    id: number;
    sourceHash: string;
    filename: string;
    chatId: string | null;
  }> {
    const rows = this.options.db
      .prepare(
        `SELECT id, source_hash, filename, chat_id
         FROM held_photos
         WHERE gallery_id = ? AND telegram_id = ?
         ORDER BY id`,
      )
      .all(galleryId, telegramId) as Array<{
      id: number;
      source_hash: string;
      filename: string;
      chat_id: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sourceHash: row.source_hash,
      filename: row.filename,
      chatId: row.chat_id,
    }));
  }

  /**
   * The pictures held for a bot, for the owner to look at.
   */
  heldForGallery(galleryId: number): Array<{
    id: number;
    telegramId: string;
    username: string | null;
    displayName: string | null;
    filename: string;
    chatId: string | null;
  }> {
    const rows = this.options.db
      .prepare(
        `SELECT h.id, h.telegram_id, h.filename, h.chat_id,
                u.username, u.display_name
         FROM held_photos h
         LEFT JOIN telegram_users u ON u.telegram_id = h.telegram_id
         WHERE h.gallery_id = ?
         ORDER BY h.id`,
      )
      .all(galleryId) as Array<{
      id: number;
      telegram_id: string;
      filename: string;
      chat_id: string | null;
      username: string | null;
      display_name: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      telegramId: row.telegram_id,
      username: row.username,
      displayName: row.display_name,
      filename: row.filename,
      chatId: row.chat_id,
    }));
  }

  /**
   * Take the pictures held for a person out of the holding place.
   *
   * This is called when the owner allows somebody: the pictures they
   * sent while they were waiting are then filed, so that they are not
   * lost. The caller does the filing, because only it knows how to render
   * a picture for the panel.
   */
  releaseHeld(galleryId: number, telegramId: string): Array<{
    id: number;
    sourceHash: string;
    filename: string;
    chatId: string | null;
  }> {
    const held = this.heldFor(galleryId, telegramId);

    if (held.length > 0) {
      const placeholders = held.map(() => "?").join(", ");
      this.options.db
        .prepare(`DELETE FROM held_photos WHERE id IN (${placeholders})`)
        .run(...held.map((h) => h.id));
    }

    return held;
  }

  /**
   * The people who are waiting to be let in, for a bot.
   *
   * These are the ones the owner has to decide about: a person who has
   * sent a picture and is not yet allowed to.
   */
  pendingFor(botId: number): PersonAccess[] {
    const rows = this.options.db
      .prepare(
        `SELECT u.id, u.telegram_id, u.username, u.display_name,
                u.first_seen_at, u.last_seen_at,
                a.status, a.decided_at,
                (SELECT COUNT(*) FROM held_photos h
                  JOIN telegram_bots b2 ON b2.gallery_id = (
                    SELECT gallery_id FROM telegram_bots WHERE id = a.bot_id)
                  WHERE h.telegram_id = u.telegram_id) AS held_count,
                (SELECT h.filename FROM held_photos h
                  WHERE h.telegram_id = u.telegram_id
                  ORDER BY h.id DESC LIMIT 1) AS held_filename
         FROM telegram_user_access a
         JOIN telegram_users u ON u.id = a.user_id
         WHERE a.bot_id = ? AND a.status = 'pending'
         ORDER BY u.last_seen_at DESC`,
      )
      .all(botId) as Array<{
      id: number;
      telegram_id: string;
      username: string | null;
      display_name: string | null;
      first_seen_at: string;
      last_seen_at: string;
      status: AccessStatus;
      decided_at: string | null;
      held_count: number;
      held_filename: string | null;
    }>;

    return rows.map((row) => ({
      person: {
        id: row.id,
        telegramId: row.telegram_id,
        username: row.username,
        displayName: row.display_name,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      },
      botId,
      status: row.status,
      decidedAt: row.decided_at,
      heldJobId: null,
      heldFilename: row.held_filename,
      heldCount: row.held_count,
    }));
  }

  /**
   * The people who may send pictures to a bot.
   */
  allowedFor(botId: number): PersonAccess[] {
    const rows = this.options.db
      .prepare(
        `SELECT u.id, u.telegram_id, u.username, u.display_name,
                u.first_seen_at, u.last_seen_at,
                a.status, a.decided_at
         FROM telegram_user_access a
         JOIN telegram_users u ON u.id = a.user_id
         WHERE a.bot_id = ? AND a.status = 'allowed'
         ORDER BY u.username, u.display_name`,
      )
      .all(botId) as Array<{
      id: number;
      telegram_id: string;
      username: string | null;
      display_name: string | null;
      first_seen_at: string;
      last_seen_at: string;
      status: AccessStatus;
      decided_at: string | null;
    }>;

    return rows.map((row) => ({
      person: {
        id: row.id,
        telegramId: row.telegram_id,
        username: row.username,
        displayName: row.display_name,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      },
      botId,
      status: row.status,
      decidedAt: row.decided_at,
      heldJobId: null,
      heldFilename: null,
      heldCount: 0,
    }));
  }
}
