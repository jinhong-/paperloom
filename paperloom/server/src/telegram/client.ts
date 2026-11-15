/**
 * A small client for the Telegram Bot API.
 *
 * Only the parts Paperloom needs are here: sending a message, and
 * downloading the file behind a picture. The Bot API is a plain HTTPS
 * API, so this is a thin wrapper rather than a dependency.
 *
 * Telegram identifies a picture by an opaque `file_id` rather than by its
 * contents, so a picture has to be fetched before it can be stored. That
 * fetch is done here, and the bytes are handed back to the caller.
 */

export interface TelegramClientOptions {
  /** The bot's token, as given by BotFather. */
  readonly token: string;
  /** Where to send API calls. Overridable so the tests can point elsewhere. */
  readonly apiBase?: string;
}

export interface TelegramPhoto {
  readonly file_id: string;
  readonly file_unique_id?: string;
  readonly file_size?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * A person on Telegram.
 *
 * The id is unique across Telegram, so it identifies the person on every
 * bot. The username can change and two people can share one, so it is only
 * ever shown and never used to tell people apart.
 */
export interface TelegramUser {
  readonly id: number;
  readonly is_bot?: boolean;
  readonly username?: string;
  readonly first_name?: string;
  readonly last_name?: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly date?: number;
  readonly chat: { readonly id: number; readonly type?: string };
  /**
   * Who sent the message.
   *
   * It is empty for messages sent to channels, which the bot cannot send
   * pictures to anyway.
   */
  readonly from?: TelegramUser;
  readonly text?: string;
  readonly caption?: string;
  readonly photo?: readonly TelegramPhoto[];
  readonly document?: {
    readonly file_id: string;
    readonly file_unique_id?: string;
    readonly file_name?: string;
    readonly mime_type?: string;
    readonly file_size?: number;
  };
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export class TelegramClient {
  private readonly token: string;
  private readonly apiBase: string;

  constructor(options: TelegramClientOptions) {
    this.token = options.token;
    this.apiBase = options.apiBase ?? "https://api.telegram.org";
  }

  /**
   * Call a Bot API method.
   */
  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.apiBase}/bot${this.token}/${method}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

    const text = await response.text();
    let parsed: { ok?: boolean; result?: T; description?: string };
    try {
      parsed = JSON.parse(text) as { ok?: boolean; result?: T; description?: string };
    } catch {
      throw new TelegramError(`unexpected reply from Telegram: ${text.slice(0, 200)}`, response.status);
    }

    if (!response.ok || !parsed.ok) {
      throw new TelegramError(
        parsed.description ?? `Telegram returned ${response.status}`,
        response.status,
      );
    }

    return parsed.result as T;
  }

  /**
   * Ask for the updates that have arrived since the last time.
   *
   * Telegram holds the updates until they are collected, and each one is
   * given an id that increases. Passing the last id collected tells
   * Telegram which updates to return, so nothing is missed and nothing
   * is seen twice.
   *
   * The request is a long poll: it waits for an update to arrive rather
   * than returning straight away, so the server is not asking Telegram
   * for nothing over and over.
   *
   * The offset is the id of the last update collected, plus one. Telegram
   * then forgets the updates before it, which is what keeps the queue
   * from growing for ever.
   */
  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const updates = await this.call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      // Ask for both kinds of update, so that a picture sent as a file
      // and one sent as a photo are both seen.
      allowed_updates: ["message"],
    });
    return Array.isArray(updates) ? updates : [];
  }

  /**
   * Send a text message to a chat.
   *
   * Used to acknowledge a picture and to report what went wrong, so the
   * person who sent it is not left guessing.
   */
  async sendMessage(chatId: number | string, text: string): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  }

  /**
   * The path of a file, relative to the Bot API's file host.
   */
  async filePath(fileId: string): Promise<string> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) {
      throw new TelegramError(`Telegram did not give a path for file ${fileId}`, 404);
    }
    return file.file_path;
  }

  /**
   * Download the bytes of a file.
   */
  async download(fileId: string): Promise<Buffer> {
    const path = await this.filePath(fileId);
    const url = `${this.apiBase}/file/bot${this.token}/${path}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new TelegramError(`could not download file ${fileId}: ${response.status}`, response.status);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new TelegramError(`Telegram returned an empty file for ${fileId}`, 502);
    }
    return buffer;
  }

  /**
   * Whether the token is one Telegram recognises.
   *
   * Used at startup so that a mistyped token is reported plainly rather
   * than showing up later as every picture failing.
   */
  async check(): Promise<{ username?: string }> {
    return this.call<{ username?: string }>("getMe");
  }
}

/**
 * The largest of a message's pictures.
 *
 * Telegram sends the same picture at several sizes. The biggest one is
 * the best source for the frame, since the panel's rendering is
 * downscaled from it.
 */
export function largestPhoto(photos: readonly TelegramPhoto[]): TelegramPhoto | undefined {
  let best: TelegramPhoto | undefined;
  for (const photo of photos) {
    if (!best) {
      best = photo;
      continue;
    }
    const bestSize = best.file_size ?? 0;
    const size = photo.file_size ?? 0;
    if (size > bestSize) best = photo;
  }
  return best;
}
