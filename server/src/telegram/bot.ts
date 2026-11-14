/**
 * The Telegram bot.
 *
 * It receives updates from Telegram, works out which chat a picture came
 * from, downloads it, and queues it for rendering.
 *
 * Each gallery has its own bot, so the gallery a picture belongs to is
 * known already: it is the gallery the bot belongs to. A chat has to be
 * known to the bot before its pictures are accepted, so that a chat
 * cannot file pictures into a gallery it has no business touching.
 */

import type { Db } from "../db/index.js";
import { GalleryPhotoService } from "../gallery/photos.js";
import { PhotoQueue } from "../queue/photos.js";
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
}

export class TelegramBot {
  constructor(private readonly options: TelegramBotOptions) {}

  /**
   * Whether a chat is known to the bot.
   */
  isKnownChat(chatId: string): boolean {
    const row = this.options.db
      .prepare("SELECT 1 FROM telegram_chats WHERE chat_id = ?")
      .get(chatId);
    return row !== undefined;
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

    const chatId = String(message.chat.id);

    /* A command is answered by the chat itself rather than by sending
     * it anything. */
    if (message.text?.startsWith("/")) {
      await this.handleCommand(message);
      return;
    }

    if (!this.isKnownChat(chatId)) {
      /* This chat has not been added to the bot. Saying so is better
       * than silently doing nothing, because otherwise the person
       * sending pictures has no way of telling a broken bot from an idle
       * one. */
      await this.options.client.sendMessage(
        message.chat.id,
        "This chat is not linked to the bot yet. Add it in the Paperloom settings to start sending pictures.",
      );
      return;
    }

    const picture = this.pictureFrom(message);
    if (!picture) {
      /* Only pictures are wanted here. Anything else is passed over
       * quietly rather than answered, so that the chat does not fill up
       * with notices. */
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
      const known = this.isKnownChat(String(message.chat.id));
      await this.options.client.sendMessage(
        message.chat.id,
        known
          ? "Send a picture and it will be queued for the frame."
          : "Send a picture and it will be queued for the frame, once this chat is added to the bot.",
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
