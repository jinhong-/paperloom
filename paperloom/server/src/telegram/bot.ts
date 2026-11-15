/**
 * The Telegram bot.
 *
 * It receives updates from Telegram, works out who sent a picture,
 * downloads it, and queues it for rendering.
 *
 * Each gallery has its own bot, so the gallery a picture belongs to is
 * known already: it is the gallery the bot belongs to.
 *
 * A person has to be allowed to send pictures to the bot before their
 * pictures are filed. Somebody who is not allowed yet has their picture
 * held and are shown to the owner as somebody to allow or to block.
 */

import type { Db } from "../db/index.js";
import { AssetStore } from "../assets/store.js";
import { GalleryPhotoService } from "../gallery/photos.js";
import { PhotoQueue } from "../queue/photos.js";
import { TelegramAccessService } from "./access.js";
import {
  largestPhoto,
  TelegramClient,
  type TelegramMessage,
  type TelegramUpdate,
} from "./client.js";

/**
 * A file that can be sent to a chat as a picture.
 *
 * Telegram sends a picture as a `photo` when it is an ordinary image,
 * and as a `document` when it arrives as a file with an image type.
 * Both are accepted.
 */
interface IncomingPicture {
  readonly fileId: string;
  readonly filename: string;
}

export interface TelegramBotOptions {
  readonly db: Db;
  readonly client: TelegramClient;
  readonly queue: PhotoQueue;
  readonly photos: GalleryPhotoService;
  /** Where the pictures are kept. */
  readonly assets: AssetStore;
  /** The bot this handler belongs to. */
  readonly botId: number;
  /** Who may send pictures to this bot. */
  readonly access: TelegramAccessService;
}

export class TelegramBot {
  constructor(private readonly options: TelegramBotOptions) {}

  /**
   * Whether a person may send pictures to this bot.
   *
   * The person has to be allowed for *this* bot, and not merely for any
   * bot. The same person may be allowed to one gallery and not another,
   * and allowing them to one says nothing about the other.
   */
  maySend(telegramId: string): boolean {
    return this.options.access.statusFor(this.options.botId, telegramId) === "allowed";
  }

  /**
   * Keep a picture that is waiting for the owner to allow somebody.
   *
   * The bytes are put in the asset store under their own hash, the same
   * as any other picture, and the picture waits in the holding place
   * until the owner decides.
   */
  private async holdPicture(
    galleryId: number,
    telegramId: string,
    filename: string,
    bytes: Buffer,
    chatId: string,
  ): Promise<void> {
    const sourceHash = AssetStore.hash(bytes);
    await this.options.assets.putSource(sourceHash, bytes);
    this.options.access.hold(galleryId, telegramId, sourceHash, filename, chatId);
  }

  /**
   * Handle one update from Telegram.
   *
   * The update has already been collected by the poller, so there is
   * nothing to acknowledge here: it is dealt with and the poller moves
   * on to the next one.
   *
   * @param galleryId the gallery the bot files its pictures into.
   */
  async handleUpdate(update: TelegramUpdate, galleryId: number): Promise<void> {
    const message = update.message;
    if (!message) return;

    /* Who sent it. Telegram always says, and the id identifies the
     * person on every bot. */
    const sender = message.from;
    if (!sender || sender.is_bot) {
      return;
    }

    const telegramId = String(sender.id);
    const displayName =
      [sender.first_name, sender.last_name].filter(Boolean).join(" ") || null;

    /* The person is recorded as soon as they write, whatever they wrote.
     *
     * They are recorded even if they are not allowed yet, so that the
     * owner can see somebody who has said hello and let them in before
     * they send a picture. A person who is only noticed when they send a
     * picture is noticed too late to be let in, and has to be turned
     * away in the meantime.
     */
    const status = this.options.access.statusFor(this.options.botId, telegramId);
    if (status === "pending") {
      this.options.access.record(
        this.options.botId,
        telegramId,
        sender.username ?? null,
        displayName,
      );
    }

    /* A command is answered by the chat itself rather than by sending
     * it anything. */
    if (message.text?.startsWith("/")) {
      await this.handleCommand(message);
      return;
    }

    const picture = this.pictureFrom(message);
    if (!picture) {
      /* Only pictures are wanted here. Anything else is passed over
       * quietly rather than answered, so that the chat does not fill up
       * with notices.
       *
       * A person who is not allowed is told anyway, because otherwise
       * they would send picture after picture and never learn why
       * nothing was happening. */
      if (status === "blocked") {
        await this.options.client.sendMessage(
          message.chat.id,
          "You are not allowed to send pictures to this frame. Ask the owner to allow you.",
        );
      } else if (status === "pending") {
        await this.options.client.sendMessage(
          message.chat.id,
          "Thanks. The owner of this frame has not allowed you yet, so your pictures will not be shown until they do.",
        );
      }
      return;
    }

    if (status === "blocked") {
      /* They are told, so that they know why nothing happened rather than
       * being left to wonder. */
      await this.options.client.sendMessage(
        message.chat.id,
        "You are not allowed to send pictures to this frame. Ask the owner to allow you.",
      );
      return;
    }

    if (status === "pending") {
      /* They are not turned away, but the picture is not filed either.
       * It is held, and the owner is shown somebody to allow or to block.
       * The person is told that it was received, so that they know it
       * arrived rather than being met with silence. */
      try {
        const bytes = await this.options.client.download(picture.fileId);
        await this.holdPicture(
          galleryId,
          telegramId,
          picture.filename,
          bytes,
          String(message.chat.id),
        );

        await this.options.client.sendMessage(
          message.chat.id,
          "Your picture has been received and is waiting for the owner to allow you. It will be shown once they do.",
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.options.client.sendMessage(
          message.chat.id,
          `Could not take that picture: ${reason}`,
        );
      }
      return;
    }

    try {
      const bytes = await this.options.client.download(picture.fileId);
      await this.options.queue.enqueue(
        galleryId,
        picture.filename,
        bytes,
        "telegram",
      );

      await this.options.client.sendMessage(
        message.chat.id,
        `Queued ${picture.filename} for the frame.`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.options.client.sendMessage(
        message.chat.id,
        `Could not take that picture: ${reason}`,
      );
    }
  }

  /**
   * Answer a command sent in a chat.
   */
  private async handleCommand(message: TelegramMessage): Promise<void> {
    const [command] = (message.text ?? "").split(/\s+/);
    const name = (command ?? "").split("@")[0] ?? "";

    if (name === "/start" || name === "/help") {
      const sender = message.from;
      const known =
        sender !== undefined &&
        !sender.is_bot &&
        this.maySend(String(sender.id));

      await this.options.client.sendMessage(
        message.chat.id,
        known
          ? "Send a picture and it will be queued for the frame."
          : "Send a picture and it will be queued for the frame, once the owner allows you.",
      );
    }
  }

  /**
   * The picture a message carries, if it carries one.
   */
  private pictureFrom(message: TelegramMessage): IncomingPicture | undefined {
    if (message.photo && message.photo.length > 0) {
      const photo = largestPhoto(message.photo);
      if (photo) {
        return {
          fileId: photo.file_id,
          filename: `telegram-${photo.file_unique_id ?? photo.file_id}.jpg`,
        };
      }
    }

    const document = message.document;
    if (document && document.mime_type?.startsWith("image/")) {
      return {
        fileId: document.file_id,
        filename: document.file_name ?? `telegram-${document.file_unique_id ?? document.file_id}.jpg`,
      };
    }

    return undefined;
  }
}
