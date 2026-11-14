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
 *
 * The sender is who the message is from. A picture is only filed if the
 * sender has been allowed to send pictures to the bot.
 */
function pictureUpdate(updateId: number, chatId: number, fromId = 555): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      chat: { id: chatId, type: "supergroup" },
      from: { id: fromId, username: `person${fromId}`, first_name: `Person ${fromId}` },
      photo: [
        { file_id: "small", file_unique_id: "u1", file_size: 100 },
        { file_id: "large", file_unique_id: "u2", file_size: 9000 },
      ],
    },
  };
}

/**
 * Let a person send pictures to a bot.
 */
async function allowPerson(
  server: BuiltServer,
  cookie: string,
  botId: number,
  telegramId: string,
): Promise<void> {
  const allowed = await server.app.inject({
    method: "POST",
    url: `/api/telegram/bots/${botId}/people/${telegramId}/allow`,
    headers: { cookie },
    payload: {},
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
}

/**
 * Give a gallery a bot.
 *
 * Each bot needs its own token, because a bot belongs to one gallery.
 * Returns the bot's id.
 */
async function setUpBot(
  server: BuiltServer,
  cookie: string,
  galleryId: number,
  _chatId?: string,
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
  const botId = await setUpBot(server, cookie, galleryId, "-1001234567890");
  await allowPerson(server, cookie, botId, "555");

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

  const firstBot = await setUpBot(server, cookie, first, "-100111", "123456:first-bot");
  const secondBot = await setUpBot(server, cookie, second, "-100222", "123456:second-bot");
  await allowPerson(server, cookie, secondBot, "555");

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

test("a guest can still allow a person on their own gallery", async (t) => {
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

  const botId = await setUpBot(server, guestCookie, galleryId);

  const allowed = await server.app.inject({
    method: "POST",
    url: `/api/telegram/bots/${botId}/people/555/allow`,
    headers: { cookie: guestCookie },
    payload: {},
  });
  assert.equal(allowed.statusCode, 200, allowed.body);

  const people = await server.app.inject({
    method: "GET",
    url: `/api/telegram/bots/${botId}/people`,
    headers: { cookie: guestCookie },
  });
  assert.equal(people.statusCode, 200);
  const listed = people.json() as { allowed: Array<{ person: { telegramId: string } }> };
  assert.equal(listed.allowed.length, 1);
  assert.equal(listed.allowed[0]!.person.telegramId, "555");
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

test("a picture from somebody who has not been allowed is held", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const galleryId = await createGallery(server, cookie);
  const botId = await setUpBot(server, cookie, galleryId, "-1001234567890");

  /* Nobody has been allowed yet, so the picture is held rather than
   * filed. */
  telegram.push("123456:test-token", pictureUpdate(1, -999));

  await server.settled();

  const jobs = server.db.prepare("SELECT COUNT(*) AS n FROM photo_jobs").get() as { n: number };
  assert.equal(jobs.n, 0, "the picture must not be filed before the owner allows them");

  const held = server.db
    .prepare("SELECT telegram_id, filename FROM held_photos")
    .all() as Array<{ telegram_id: string; filename: string }>;
  assert.equal(held.length, 1, "the picture must be held");
  assert.equal(held[0]!.telegram_id, "555", "the picture must be held against its sender");

  /* The person is told that it arrived, rather than being met with
   * silence. */
  assert.ok(
    telegram.sent.some((m) => m.includes("waiting for the owner")),
    `the person must be told it is waiting, got: ${JSON.stringify(telegram.sent)}`,
  );

  /* The owner is shown somebody to decide about. */
  const people = await server.app.inject({
    method: "GET",
    url: `/api/telegram/bots/${botId}/people`,
    headers: { cookie },
  });
  assert.equal(people.statusCode, 200, people.body);
  const listed = people.json() as {
    pending: Array<{ person: { telegramId: string; username: string | null } }>;
  };
  assert.equal(listed.pending.length, 1, "the owner must be shown the person");
  assert.equal(listed.pending[0]!.person.telegramId, "555");
  assert.equal(listed.pending[0]!.person.username, "person555");
});

test("a person who says hello shows up to be allowed", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const galleryId = await createGallery(server, cookie);
  const botId = await setUpBot(server, cookie, galleryId);

  /* A message that is not a picture still shows the owner that somebody
   * is there, so that they can be let in before they send a picture. */
  telegram.push("123456:test-token", {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: -1001234567890, type: "private" },
      from: { id: 555, username: "alice_photos", first_name: "Alice" },
      text: "hello",
    },
  });

  await server.settled();

  const people = server.db
    .prepare("SELECT telegram_id, username, display_name FROM telegram_users")
    .all() as Array<{ telegram_id: string; username: string; display_name: string }>;
  assert.equal(people.length, 1, "the person must be recorded");
  assert.equal(people[0]!.telegram_id, "555");
  assert.equal(people[0]!.username, "alice_photos");

  /* And the owner is shown them, waiting to be allowed. */
  const listed = await server.app.inject({
    method: "GET",
    url: `/api/telegram/bots/${botId}/people`,
    headers: { cookie },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  const shown = listed.json() as { pending: Array<{ person: { telegramId: string } }> };
  assert.equal(shown.pending.length, 1, "the owner must be shown the person");
  assert.equal(shown.pending[0]!.person.telegramId, "555");
});

test("a blocked person cannot file a picture", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const galleryId = await createGallery(server, cookie);
  const botId = await setUpBot(server, cookie, galleryId, "-1001234567890");

  /* The person is blocked. */
  const blocked = await server.app.inject({
    method: "POST",
    url: `/api/telegram/bots/${botId}/people/555/block`,
    headers: { cookie },
    payload: {},
  });
  assert.equal(blocked.statusCode, 200, blocked.body);

  telegram.push("123456:test-token", pictureUpdate(1, -999));

  await server.settled();

  const jobs = server.db.prepare("SELECT COUNT(*) AS n FROM photo_jobs").get() as { n: number };
  assert.equal(jobs.n, 0, "a blocked person must not file a picture");

  const held = server.db.prepare("SELECT COUNT(*) AS n FROM held_photos").get() as { n: number };
  assert.equal(held.n, 0, "a blocked person's picture must not be held either");

  assert.ok(
    telegram.sent.some((m) => m.includes("not allowed")),
    `the person must be told they are not allowed, got: ${JSON.stringify(telegram.sent)}`,
  );
});

test("a person allowed for one bot cannot file into another bot's gallery", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const first = await createGallery(server, cookie);
  const second = await createGallery(server, cookie);

  /* The person is allowed for the first gallery's bot only. */
  const firstBot = await setUpBot(server, cookie, first, "-100111", "123456:first-token");
  await setUpBot(server, cookie, second, "-1009999999999", "123456:second-token");
  await allowPerson(server, cookie, firstBot, "555");

  /* The second bot's token is used, but the person is only allowed for
   * the first. */
  telegram.push("123456:second-token", pictureUpdate(1, -100111));

  await server.settled();

  const jobs = server.db.prepare("SELECT COUNT(*) AS n FROM photo_jobs").get() as { n: number };
  assert.equal(jobs.n, 0, "a person allowed for another bot must not file a picture");

  const held = server.db.prepare("SELECT COUNT(*) AS n FROM held_photos").get() as { n: number };
  assert.equal(held.n, 1, "the picture must be held, waiting for a decision");
});

test("allowing a person files the pictures they sent while waiting", async (t) => {
  const telegram = await startFakeTelegram(await testImage());
  const server = await makeServer(telegram.url);

  t.after(async () => {
    await server.app.close();
    await telegram.close();
  });

  const cookie = await signIn(server);
  const galleryId = await createGallery(server, cookie);
  const botId = await setUpBot(server, cookie, galleryId, "-1001234567890");

  telegram.push("123456:test-token", pictureUpdate(1, -999));
  await server.settled();

  const before = server.db
    .prepare("SELECT COUNT(*) AS n FROM photo_jobs")
    .get() as { n: number };
  assert.equal(before.n, 0, "the picture is not filed while the person waits");

  const allowed = await server.app.inject({
    method: "POST",
    url: `/api/telegram/bots/${botId}/people/555/allow`,
    headers: { cookie },
    payload: {},
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal((allowed.json() as { filed: number }).filed, 1, "the held picture must be filed");

  const after = server.db
    .prepare("SELECT COUNT(*) AS n FROM photo_jobs")
    .get() as { n: number };
  assert.equal(after.n, 1, "the picture must be queued once the person is allowed");

  const held = server.db.prepare("SELECT COUNT(*) AS n FROM held_photos").get() as { n: number };
  assert.equal(held.n, 0, "the picture must not be held any more");
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

  const people = server.db
    .prepare("SELECT COUNT(*) AS n FROM telegram_user_access")
    .get() as { n: number };
  assert.equal(people.n, 0, "the people must be gone with the bot");
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

test("a picture left half done by a restart is picked up again", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const cookie = await signIn(server);
  const galleryId = await createGallery(server, cookie);

  /* A job that was being worked on when the server stopped is left marked
   * as such. Nothing would pick it up again, and the picture would be
   * lost without a word. */
  const job = server.db
    .prepare(
      `INSERT INTO photo_jobs (gallery_id, source_hash, filename, origin, status, attempts)
       VALUES (?, 'abc123', 'a.jpg', 'telegram', 'processing', 1)`,
    )
    .run(galleryId);

  const pending = server.db
    .prepare("SELECT COUNT(*) AS n FROM photo_jobs WHERE status = 'pending'")
    .get() as { n: number };
  assert.equal(pending.n, 0, "the job starts out marked as being worked on");

  /* The worker starts and puts it back in the queue. */
  server.worker.start();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const after = server.db
    .prepare("SELECT status, attempts FROM photo_jobs WHERE id = ?")
    .get(job.lastInsertRowid) as { status: string; attempts: number };

  assert.notEqual(
    after.status,
    "processing",
    "the job must not be left marked as being worked on",
  );
});
