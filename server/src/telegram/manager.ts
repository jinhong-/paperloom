/**
 * The Telegram bots.
 *
 * Each gallery has its own bot, with its own token. The server asks
 * Telegram for each bot's updates in turn, and a picture that arrives
 * through a bot is filed into that bot's gallery.
 *
 * The bots are held here rather than in one place in the server, because
 * they come and go: a bot is added when its token is saved and removed
 * when it is taken away. Each one has its own poller, and each poller
 * has to be stopped when the bot goes, or the server would keep asking
 * Telegram for a bot that is no longer there.
 */

import type { Db } from "../db/index.js";
import type { AssetStore } from "../assets/store.js";
import { GalleryPhotoService } from "../gallery/photos.js";
import { PhotoQueue } from "../queue/photos.js";
import { TelegramBot } from "./bot.js";
import { TelegramClient } from "./client.js";
import { TelegramPoller } from "./poller.js";

/** A bot as it is stored. */
export interface StoredBot {
  readonly id: number;
  readonly gallery_id: number;
  readonly token: string;
  readonly username: string | null;
  readonly error: string | null;
  readonly polling: boolean;
}

export interface TelegramBotManagerOptions {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly photos: GalleryPhotoService;
  /** Where to reach the Bot API. */
  readonly apiBase?: string;
  /** How often to ask Telegram for updates, in milliseconds. */
  readonly intervalMs?: number;
  /** Called when something goes wrong, for the log. */
  readonly onError?: (error: unknown, botId: number) => void;
}

export class TelegramBotManager {
  /** The poller for each bot, by bot id. */
  private readonly pollers = new Map<number, TelegramPoller>();

  constructor(private readonly options: TelegramBotManagerOptions) {}

  /**
   * The bots that are set up.
   */
  bots(): StoredBot[] {
    const rows = this.options.db
      .prepare(
        `SELECT id, gallery_id, token, username, error, polling
         FROM telegram_bots ORDER BY id`,
      )
      .all() as Array<{
      id: number;
      gallery_id: number;
      token: string;
      username: string | null;
      error: string | null;
      polling: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      gallery_id: row.gallery_id,
      token: row.token,
      username: row.username,
      error: row.error,
      polling: row.polling === 1,
    }));
  }

  /**
   * The bot for a gallery, if it has one.
   */
  botForGallery(galleryId: number): StoredBot | undefined {
    const row = this.options.db
      .prepare(
        `SELECT id, gallery_id, token, username, error, polling
         FROM telegram_bots WHERE gallery_id = ?`,
      )
      .get(galleryId) as
      | {
          id: number;
          gallery_id: number;
          token: string;
          username: string | null;
          error: string | null;
          polling: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      gallery_id: row.gallery_id,
      token: row.token,
      username: row.username,
      error: row.error,
      polling: row.polling === 1,
    };
  }

  /**
   * The bot with a token, if there is one.
   *
   * Two galleries must not share a bot, because a picture that arrives
   * through it could be filed into either. The token is the bot's
   * identity, so the first gallery to claim a token keeps it.
   */
  botForToken(token: string): StoredBot | undefined {
    const row = this.options.db
      .prepare(
        `SELECT id, gallery_id, token, username, error, polling
         FROM telegram_bots WHERE token = ?`,
      )
      .get(token) as
      | {
          id: number;
          gallery_id: number;
          token: string;
          username: string | null;
          error: string | null;
          polling: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      gallery_id: row.gallery_id,
      token: row.token,
      username: row.username,
      error: row.error,
      polling: row.polling === 1,
    };
  }

  /**
   * Start asking Telegram for a bot's updates.
   *
   * Called when a bot is saved and when the server starts, so that a
   * server that is restarted picks up the bots it already has.
   */
  async start(bot: StoredBot): Promise<void> {
    if (this.pollers.has(bot.id)) return;

    const client = new TelegramClient({ token: bot.token, apiBase: this.options.apiBase });
    const queue = new PhotoQueue({
      db: this.options.db,
      assets: this.options.assets,
      photos: this.options.photos,
    });
    const handler = new TelegramBot({
      db: this.options.db,
      client,
      queue,
      photos: this.options.photos,
      botId: bot.id,
    });

    const poller = new TelegramPoller({
      fetchUpdates: (offset, timeout) => client.getUpdates(offset, timeout),
      onUpdate: async (update) => {
        await handler.handleUpdate(update, bot.gallery_id);
      },
      intervalMs: this.options.intervalMs,
      onError: (error) => {
        this.options.onError?.(error, bot.id);
      },
    });

    this.pollers.set(bot.id, poller);
    poller.start();

    this.options.db
      .prepare("UPDATE telegram_bots SET polling = 1, updated_at = datetime('now') WHERE id = ?")
      .run(bot.id);
  }

  /**
   * Stop asking Telegram for a bot's updates.
   */
  async stop(botId: number): Promise<void> {
    const poller = this.pollers.get(botId);
    if (poller) {
      await poller.stop();
      this.pollers.delete(botId);
    }

    this.options.db
      .prepare("UPDATE telegram_bots SET polling = 0, updated_at = datetime('now') WHERE id = ?")
      .run(botId);
  }

  /**
   * Start every bot that is set up.
   *
   * Used when the server starts, so that the bots do not have to be
   * saved again after a restart.
   */
  async startAll(): Promise<void> {
    for (const bot of this.bots()) {
      await this.start(bot);
    }
  }

  /**
   * Stop every bot.
   */
  async stopAll(): Promise<void> {
    for (const botId of [...this.pollers.keys()]) {
      await this.stop(botId);
    }
  }

  /**
   * Check a token with Telegram, without saving it.
   *
   * The token is checked before it is saved, so that a mistyped token is
   * reported straight away rather than leaving a broken bot behind that
   * looks as though it is working.
   */
  async checkToken(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
    const client = new TelegramClient({ token, apiBase: this.options.apiBase });
    try {
      const me = await client.check();
      return { ok: true, username: me.username ?? undefined };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check a bot's token with Telegram, and remember what it says.
   *
   * A token that Telegram does not recognise is worth saying out loud,
   * because otherwise it looks as though the bot is working when it is
   * not.
   */
  async check(botId: number): Promise<{ ok: boolean; username?: string; error?: string }> {
    const bot = this.bots().find((b) => b.id === botId);
    if (!bot) return { ok: false, error: "unknown bot" };

    const client = new TelegramClient({ token: bot.token, apiBase: this.options.apiBase });
    try {
      const me = await client.check();
      this.options.db
        .prepare(
          "UPDATE telegram_bots SET username = ?, error = NULL, updated_at = datetime('now') WHERE id = ?",
        )
        .run(me.username ?? null, botId);
      return { ok: true, username: me.username ?? undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.db
        .prepare(
          "UPDATE telegram_bots SET error = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(message.slice(0, 500), botId);
      return { ok: false, error: message };
    }
  }

  /**
   * Ask Telegram for updates now, rather than waiting for the next tick.
   *
   * Used by the tests, which need the picture to have been collected
   * before they look at it.
   */
  async pollNow(): Promise<void> {
    await Promise.all([...this.pollers.values()].map((p) => p.poll()));
  }

  /**
   * Wait for the work in hand to finish.
   *
   * Used by the tests, which need the picture to have been filed before
   * they look at it.
   */
  async settled(): Promise<void> {
    await this.pollNow();
    await Promise.all([...this.pollers.values()].map((p) => p.settled()));
  }
}
