/**
 * Telegram bot integration test.
 *
 * Drives the bot the way Telegram would: the server polls for updates,
 * the picture is downloaded, queued, and then rendered by the worker.
 * The Telegram API itself is stood in for by a small local server, so
 * the test exercises the real HTTP calls the bot makes.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

import { buildServer, type BuiltServer } from "../index.js";
import type { TelegramUpdate } from "../telegram/client.js";

/**
 * A stand-in for the Telegram Bot API.
 *
 * It serves the calls the bot makes: asking for updates, downloading a
 * file, and sending a message. The messages sent back are recorded.
 *
 * Each bot has its own queue of updates, as it does in Telegram: the
 * updates a bot is given are only seen by that bot.
 */
interface FakeTelegram {
  readonly url: string;
  readonly sent: string[];
  /** The offsets the bot asked for, so a test can check that it moves on. */
  readonly offsets: number[];
  /** Make an update available for one bot to collect. */
  push(token: string, update: TelegramUpdate): void;
  close(): Promise<void>;
}

async function startFakeTelegram(pictureBytes: Buffer): Promise<FakeTelegram> {
  const sent: string[] = [];
  const offsets: number[] = [];
  const pending = new Map<string, TelegramUpdate[]>();

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");

      /* The token is in the path, so the stand-in knows which bot is
       * asking, as Telegram does. */
      const token = /\/bot([^/]+)\//.exec(request.url ?? "")?.[1] ?? "";

      if (request.url?.endsWith("/getMe")) {
        /* A token that says it is bad is refused, so that a mistyped
         * token can be tested. Every other token is accepted. */
        if (token.includes("bad")) {
          const payload = JSON.stringify({ ok: false, description: "Unauthorized" });
          response.writeHead(401, { "Content-Type": "application/json" });
          response.end(payload);
          return;
        }
        const payload = JSON.stringify({ ok: true, result: { username: "paperloom_test_bot" } });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(payload);
        return;
      }

      if (request.url?.endsWith("/getUpdates")) {
        let parsed: { offset?: number } = {};
        try {
          parsed = JSON.parse(body) as { offset?: number };
        } catch {
          parsed = {};
        }
        offsets.push(parsed.offset ?? 0);

        /* Only the updates after the offset are returned, which is how
         * Telegram keeps the queue from growing for ever. */
        const ready = pending.get(token) ?? [];
        pending.set(token, []);

        const payload = JSON.stringify({ ok: true, result: ready });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(payload);
        return;
      }

      if (request.url?.endsWith("/getFile")) {
        const payload = JSON.stringify({ ok: true, result: { file_path: "photos/pic.jpg" } });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(payload);
        return;
      }

      if (request.url?.includes("/file/bot")) {
        response.writeHead(200, { "Content-Type": "image/jpeg" });
        response.end(pictureBytes);
        return;
      }

      if (request.url?.endsWith("/sendMessage")) {
        try {
          const parsed = JSON.parse(body) as { text?: string };
          sent.push(parsed.text ?? "");
        } catch {
          sent.push(body);
        }
        const payload = JSON.stringify({ ok: true, result: { message_id: 1 } });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(payload);
        return;
      }

      response.writeHead(404);
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    sent,
    offsets,
    push: (token, update) => {
      const queue = pending.get(token) ?? [];
      queue.push(update);
      pending.set(token, queue);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function makeServer(apiBase?: string): Promise<BuiltServer> {
  const dir = mkdtempSync(join(tmpdir(), "paperloom-telegram-"));
  return buildServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    logLevel: "silent",
    telegramApiBase: apiBase,
  });
}

async function signIn(server: BuiltServer): Promise<string> {
  const username = `u-${randomUUID()}`;
  await server.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "a-long-enough-password" },
  });

  const login = await server.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "a-long-enough-password" },
  });
  assert.equal(login.statusCode, 200);

  const setCookie = login.headers["set-cookie"];
  assert.ok(setCookie, "the login must set a session cookie");
  return String(setCookie).split(";")[0]!;
}

/**
 * Sign in as somebody the owner has invited.
 *
 * Only the first account can be made through the registration page, so
 * everybody else is invited.
 */
async function signInAsGuest(server: BuiltServer, ownerCookie: string): Promise<string> {
  const username = `guest-${randomUUID()}`;

  const invite = await server.app.inject({
    method: "POST",
    url: "/api/users/invitations",
    headers: { cookie: ownerCookie },
    payload: { username },
  });
  assert.equal(invite.statusCode, 200);
  const code = (invite.json() as { invite_code: string }).invite_code;

  const accept = await server.app.inject({
    method: "POST",
    url: `/api/invitations/${code}`,
    payload: { password: "another-long-enough-password" },
  });
  assert.equal(accept.statusCode, 200);

  const login = await server.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "another-long-enough-password" },
  });
  assert.equal(login.statusCode, 200);

  const setCookie = login.headers["set-cookie"];
  assert.ok(setCookie, "the login must set a session cookie");
  return String(setCookie).split(";")[0]!;
}

async function createGallery(server: BuiltServer, cookie: string): Promise<number> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/galleries",
    headers: { cookie },
    payload: { name: "Telegram gallery" },
  });
  assert.equal(created.statusCode, 200);
  return (created.json() as { id: number }).id;
}

/**
 * A small red PNG, so the dither has something to work with.
 */
async function testImage(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

/**
 * An update with a picture in it.
 */
function pictureUpdate(updateId: number, chatId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      chat: { id: chatId, type: "supergroup" },
      photo: [
        { file_id: "small", file_unique_id: "u1", file_size: 100 },
        { file_id: "large", file_unique_id: "u2", file_size: 9000 },
      ],
    },
  };
}

/**
 * Give a gallery a bot, and a chat to talk to it through.
 *
 * Each bot needs its own token, because a bot belongs to one gallery.
 * Returns the bot's id.
 */
async function setUpBot(
  server: BuiltServer,
  cookie: string,
  galleryId: number,
  chatId: string,
  token = "123456:test-token",
): Promise<number> {
  const bot = await server.app.inject({
    method: "POST",
    url: `/api/telegram/galleries/${galleryId}/bot`,
    headers: { cookie },
    payload: { token },
  });
  assert.equal(bot.statusCode, 200, bot.body);

  const bots = await server.app.inject({
    method: "GET",
    url: "/api/telegram/bots",
    headers: { cookie },
  });
  const botId = (bots.json() as { bots: Array<{ id: number; gallery_id: number }> }).bots.find(
    (b) => b.gallery_id === galleryId,
  )!.id;

  const chat = await server.app.inject({
    method: "POST",
    url: `/api/telegram/bots/${botId}/chats`,
    headers: { cookie },
    payload: { chat_id: chatId, label: "Family chat" },
  });
  assert.equal(chat.statusCode, 200, chat.body);

  return botId;
}

test("a picture collected by the poller is queued and rendered into the gallery", async (t) => {
  const image = await testImage();
  const telegram = await startFakeTelegram(image);
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const galleryId = await createGallery(server, cookie);
  await setUpBot(server, cookie, galleryId, "-1001234567890");

  /* Telegram has a picture waiting for the bot to collect. */
  telegram.push("123456:test-token", pictureUpdate(1, -1001234567890));

  await server.settled();

  /* The picture is queued, rather than rendered straight away. */
  const queued = server.db
    .prepare("SELECT id, gallery_id, filename, status, origin FROM photo_jobs")
    .all() as Array<{
    id: number;
    gallery_id: number;
    filename: string;
    status: string;
    origin: string;
  }>;
  assert.equal(queued.length, 1, "the picture must be queued");
  assert.equal(queued[0]!.gallery_id, galleryId, "the picture must go to the bot's gallery");
  assert.equal(queued[0]!.status, "pending");
  assert.equal(queued[0]!.origin, "telegram");

  /* Nothing is in the gallery until the worker runs. */
  const before = server.db
    .prepare("SELECT COUNT(*) AS n FROM photos WHERE gallery_id = ?")
    .get(galleryId) as { n: number };
  assert.equal(before.n, 0, "the picture must not be rendered by the poll");

  await server.worker.drain();

  /* Now the photo is in the gallery, with its renderings. */
  const photos = server.db
    .prepare("SELECT id, filename, content_hash FROM photos WHERE gallery_id = ?")
    .all(galleryId) as Array<{ id: number; filename: string; content_hash: string }>;
  assert.equal(photos.length, 1, "the picture must be rendered into the gallery");
  assert.ok(photos[0]!.content_hash, "the photo must have an asset hash");

  const renderings = server.db
    .prepare("SELECT rotation FROM photo_assets WHERE photo_id = ?")
    .all(photos[0]!.id) as Array<{ rotation: number }>;
  assert.equal(renderings.length, 4, "the photo must be rendered for every rotation");

  /* The job is marked done and points at the photo. */
  const job = server.db
    .prepare("SELECT status, photo_id FROM photo_jobs WHERE id = ?")
    .get(queued[0]!.id) as { status: string; photo_id: number };
  assert.equal(job.status, "done");
  assert.equal(job.photo_id, photos[0]!.id);

  /* The chat was told what happened. */
  assert.ok(
    telegram.sent.some((m) => m.includes("Queued")),
    `the chat must be told the picture was queued, got: ${JSON.stringify(telegram.sent)}`,
  );
});

test("each gallery's bot files into its own gallery", async (t) => {
  const image = await testImage();
  const telegram = await startFakeTelegram(image);
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const first = await createGallery(server, cookie);
  const second = await createGallery(server, cookie);

  await setUpBot(server, cookie, first, "-100111", "123456:first-bot");
  await setUpBot(server, cookie, second, "-100222", "123456:second-bot");

  /* A picture for the second gallery's chat. */
  telegram.push("123456:second-bot", pictureUpdate(1, -100222));

  await server.settled();

  const jobs = server.db
    .prepare("SELECT gallery_id FROM photo_jobs")
    .all() as Array<{ gallery_id: number }>;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.gallery_id, second, "the picture must go to the bot's own gallery");
});

test("the token can be set from the management API and the bot starts at once", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const galleryId = await createGallery(server, cookie);

  const bot = await server.app.inject({
    method: "POST",
    url: `/api/telegram/galleries/${galleryId}/bot`,
    headers: { cookie },
    payload: { token: "123456:test-token" },
  });
  assert.equal(bot.statusCode, 200, bot.body);
  assert.equal((bot.json() as { username: string }).username, "paperloom_test_bot");

  /* The bot is polling without the server being restarted. */
  const bots = await server.app.inject({
    method: "GET",
    url: "/api/telegram/bots",
    headers: { cookie },
  });
  const listed = (bots.json() as { bots: Array<{ gallery_id: number; polling: boolean }> }).bots;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.gallery_id, galleryId);
  assert.equal(listed[0]!.polling, true, "the bot must be polling");
});

test("a token Telegram does not recognise is refused", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const galleryId = await createGallery(server, cookie);

  /* The stand-in refuses a token it does not know. */
  const bad = await server.app.inject({
    method: "POST",
    url: `/api/telegram/galleries/${galleryId}/bot`,
    headers: { cookie },
    payload: { token: "123456:a-bad-token" },
  });

  assert.ok(bad.statusCode >= 400, "a bad token must be refused");

  /* The refused token must not be left behind, or the gallery would
   * look as though it had a bot that does not work. */
  const bots = server.db.prepare("SELECT COUNT(*) AS n FROM telegram_bots").get() as { n: number };
  assert.equal(bots.n, 0, "a refused token must not be saved");
});

test("a bad token does not stop a good one from being saved afterwards", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const galleryId = await createGallery(server, cookie);

  const bad = await server.app.inject({
    method: "POST",
    url: `/api/telegram/galleries/${galleryId}/bot`,
    headers: { cookie },
    payload: { token: "123456:a-bad-token" },
  });
  assert.ok(bad.statusCode >= 400);

  const good = await server.app.inject({
    method: "POST",
    url: `/api/telegram/galleries/${galleryId}/bot`,
    headers: { cookie },
    payload: { token: "123456:a-good-token" },
  });
  assert.equal(good.statusCode, 200, good.body);
});

test("a bot belongs to a gallery, so only its owner can set the token", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const ownerCookie = await signIn(server);
  const galleryId = await createGallery(server, ownerCookie);
  const guestCookie = await signInAsGuest(server, ownerCookie);

  const response = await server.app.inject({
    method: "POST",
    url: `/api/telegram/galleries/${galleryId}/bot`,
    headers: { cookie: guestCookie },
    payload: { token: "123456:test-token" },
  });

  assert.equal(response.statusCode, 404, "a guest must not be able to set another gallery's bot");

  const bots = server.db.prepare("SELECT COUNT(*) AS n FROM telegram_bots").get() as { n: number };
  assert.equal(bots.n, 0, "the bot must not be saved");
});

test("a guest can still add a chat to a bot on their own gallery", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const ownerCookie = await signIn(server);
  const guestCookie = await signInAsGuest(server, ownerCookie);

  const gallery = await server.app.inject({
    method: "POST",
    url: "/api/galleries",
    headers: { cookie: guestCookie },
    payload: { name: "Guest gallery" },
  });
  const galleryId = (gallery.json() as { id: number }).id;

  await setUpBot(server, guestCookie, galleryId, "-100999");

  const chats = await server.app.inject({
    method: "GET",
    url: `/api/telegram/bots/1/chats`,
    headers: { cookie: guestCookie },
  });
  assert.equal(chats.statusCode, 200);
  assert.equal((chats.json() as unknown[]).length, 1);
});

test("the same bot cannot be used by two galleries", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const first = await createGallery(server, cookie);
  const second = await createGallery(server, cookie);

  await setUpBot(server, cookie, first, "-100111");

  const response = await server.app.inject({
    method: "POST",
    url: `/api/telegram/galleries/${second}/bot`,
    headers: { cookie },
    payload: { token: "123456:test-token" },
  });

  assert.equal(response.statusCode, 409, "a bot must not be shared by two galleries");
});

test("a picture from a chat that is not linked is refused", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const galleryId = await createGallery(server, cookie);
  await setUpBot(server, cookie, galleryId, "-1001234567890");

  telegram.push("123456:test-token", pictureUpdate(1, -999));

  await server.settled();

  const jobs = server.db.prepare("SELECT COUNT(*) AS n FROM photo_jobs").get() as { n: number };
  assert.equal(jobs.n, 0);

  assert.ok(
    telegram.sent.some((m) => m.includes("not linked")),
    `the chat must be told it is not linked, got: ${JSON.stringify(telegram.sent)}`,
  );
});

test("a gallery's bot can be taken away again", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const galleryId = await createGallery(server, cookie);
  await setUpBot(server, cookie, galleryId, "-100111");

  const removed = await server.app.inject({
    method: "DELETE",
    url: `/api/telegram/galleries/${galleryId}/bot`,
    headers: { cookie },
  });
  assert.equal(removed.statusCode, 200, removed.body);

  const bots = server.db.prepare("SELECT COUNT(*) AS n FROM telegram_bots").get() as { n: number };
  assert.equal(bots.n, 0, "the bot must be gone");

  const chats = server.db.prepare("SELECT COUNT(*) AS n FROM telegram_chats").get() as { n: number };
  assert.equal(chats.n, 0, "the chats must be gone with the bot");
});

test("the queue can be read from the management API", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const cookie = await signIn(server);
  await createGallery(server, cookie);

  const queue = await server.app.inject({
    method: "GET",
    url: "/api/telegram/queue",
    headers: { cookie },
  });
  assert.equal(queue.statusCode, 200);
  assert.equal((queue.json() as { pending: number }).pending, 0);
});

test("the management API refuses to show the bots to nobody", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const response = await server.app.inject({
    method: "GET",
    url: "/api/telegram/bots",
  });

  assert.equal(response.statusCode, 401);
});
