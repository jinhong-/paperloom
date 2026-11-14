/**
 * Paperloom server entry point.
 *
 * Wires the database, asset store, schedule service and API routes together
 * and starts listening.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import cookie from "@fastify/cookie";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

import { AssetStore } from "./assets/store.js";
import { registerDeviceApi } from "./api/device.js";
import { registerEnrollmentApi } from "./api/enrollment.js";
import { registerManagementApi } from "./api/management.js";
import { registerTelegramApi } from "./api/telegram.js";
import { openDatabase, type Db } from "./db/index.js";
import { GalleryPhotoService } from "./gallery/photos.js";
import { PinnedPhotoService } from "./gallery/pinned.js";
import { PhotoQueue, PhotoWorker } from "./queue/photos.js";
import { ScheduleService } from "./schedule/service.js";
import { TelegramBotManager } from "./telegram/manager.js";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /** Directory holding the SQLite database and the asset store. */
  readonly dataDir: string;
  readonly logLevel: string;
  /** Where to reach the Telegram Bot API. */
  readonly telegramApiBase?: string;
  /** How often to ask Telegram for updates, in seconds. */
  readonly telegramPollInterval?: number;
}

export function loadConfig(): ServerConfig {
  return {
    host: process.env.PAPERLOOM_HOST ?? "0.0.0.0",
    port: Number(process.env.PAPERLOOM_PORT ?? 8080),
    dataDir: process.env.PAPERLOOM_DATA_DIR ?? join(process.cwd(), "data"),
    logLevel: process.env.PAPERLOOM_LOG_LEVEL ?? "info",
    telegramApiBase: process.env.PAPERLOOM_TELEGRAM_API_BASE,
    telegramPollInterval: Number(process.env.PAPERLOOM_TELEGRAM_POLL_INTERVAL ?? 3),
  };
}

export interface BuiltServer {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly assets: AssetStore;
  readonly schedules: ScheduleService;
  /** The worker that renders the queued pictures. Not started. */
  readonly worker: PhotoWorker;
  /** The bots, and the pollers that go with them. */
  readonly manager: TelegramBotManager;
  /**
   * Wait for the background work started by the bots.
   *
   * A bot deals with a picture after it has been collected, so a caller
   * that needs the picture to have been filed waits here first.
   */
  settled(): Promise<void>;
}

/**
 * Build the server without starting it. Used by the tests.
 */
export async function buildServer(config: ServerConfig): Promise<BuiltServer> {
  const db = openDatabase({ path: join(config.dataDir, "paperloom.db") });

  const assetRoot = join(config.dataDir, "assets");
  mkdirSync(assetRoot, { recursive: true });

  // The original uploads are kept alongside the rendered assets. The frame
  // only ever sees the rendered form, but the owner recognises the
  // original, and the gallery preview shows it.
  const sourceRoot = join(config.dataDir, "sources");
  mkdirSync(sourceRoot, { recursive: true });

  const assets = new AssetStore(db, assetRoot, sourceRoot);
  const schedules = new ScheduleService(db, assets);

  /* Pictures sent to the Telegram bot are rendered in the background, so
   * that the chat is answered straight away rather than after the
   * rendering. */
  /* A picture that arrives from a chat is pinned to the next check-in of
   * each frame showing its gallery, so that it is shown on the next wake
   * rather than waiting for its turn in the rotation. */
  const pins = new PinnedPhotoService({ db, schedules });
  const photos = new GalleryPhotoService({ db, assets, schedules, pins });
  const queue = new PhotoQueue({ db, assets, photos });
  const worker = new PhotoWorker({
    queue,
    assets,
    photos,
    onError: (job, error) => {
      app.log.error({ err: error, job: job.id }, "could not render a queued photo");
    },
    onRecovered: (count) => {
      app.log.warn({ count }, "photo jobs interrupted by a restart were put back in the queue");
    },
  });

  /* The work in hand is tracked, so that a caller can wait for it to
   * finish rather than racing it. */
  const pendingWork = new Set<Promise<void>>();

  const app = fastify({
    logger: { level: config.logLevel },
    // The signed-request scheme digests the raw body, so the raw bytes must
    // be preserved for the device API.
    bodyLimit: 32 * 1024 * 1024,
    // Home Assistant and other reverse proxies terminate TLS in front of
    // the server. Trust their forwarding headers so cookies and logs use
    // the original request scheme.
    trustProxy: true,
  });

  app.register(cookie, { secret: process.env.PAPERLOOM_COOKIE_SECRET ?? "paperloom-dev-secret" });

  const deviceBasePath = "/api/device";
  const managementBasePath = "/api";

  registerDeviceApi(app, { db, assets, schedules, basePath: deviceBasePath });
  registerEnrollmentApi(app, { db, basePath: deviceBasePath });
  registerManagementApi(app, { db, assets, schedules, basePath: managementBasePath });

  /* Each gallery has its own bot, and the manager holds a poller for
   * each one. The bots ask Telegram for their updates themselves, so
   * the server does not have to be reachable from the public internet. */
  const manager = new TelegramBotManager({
    db,
    assets,
    photos,
    apiBase: config.telegramApiBase,
    intervalMs: Math.max(1, config.telegramPollInterval ?? 3) * 1000,
    onError: (error, botId) => {
      app.log.error({ err: error, botId }, "could not poll a Telegram bot");
    },
  });

  registerTelegramApi(app, {
    db,
    assets,
    schedules,
    basePath: managementBasePath,
    manager,
  });

  /* The bots stop asking Telegram when the server does, so that nothing
   * is left running in the background after the server has closed. */
  app.addHook("onClose", async () => {
    await manager.stopAll();
    await worker.stop();
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  // Basic browser security headers for the management UI and API. The UI
  // needs to be framed by Home Assistant's ingress UI, so same-origin
  // framing is allowed rather than denied outright.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    return payload;
  });

  // Serve the management UI if it has been built. The UI is a static
  // bundle produced by `npm run build` in server/web.
  const webRoot = join(process.cwd(), "web", "dist");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });

    /* The built UI refers to its assets relatively, so that it works
     * behind Home Assistant's path-prefixed ingress endpoint.
     *
     * That means the browser asks for the assets relative to the page
     * it is on: the page at /invitation/CODE asks for
     * /invitation/assets/app.js, not /assets/app.js. The assets only
     * exist in one place, so they are served from the root of the bundle
     * however deep the page that wants them is. */
    app.get("/:any/assets/:file", async (request, reply) => {
      const { file } = request.params as { any: string; file: string };
      await reply.sendFile(join("assets", file), webRoot);
    });

    // The client-side router handles everything that is not an API call,
    // so any unknown path falls back to the app shell.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        await reply.code(404).send({ error: "not found" });
        return;
      }
      await reply.sendFile("index.html");
    });
  } else {
    app.log.warn(
      `The management UI is not built. Run "npm run build" in server/web to enable it.`,
    );
  }

  return {
    app,
    db,
    assets,
    schedules,
    worker,
    manager,
    settled: async () => {
      await manager.settled();
      while (pendingWork.size > 0) {
        await Promise.allSettled([...pendingWork]);
      }
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, worker, manager } = await buildServer(config);

  /* Pictures sent to the Telegram bot are rendered in the background. */
  worker.start();

  /* The bots ask Telegram for their updates. */
  await manager.startAll();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    /* Closing the app stops the bots and the worker. */
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Paperloom server listening on ${config.host}:${config.port}`);
  app.log.info(`Data directory: ${config.dataDir}`);

  const bots = manager.bots();
  if (bots.length > 0) {
    app.log.info(`${bots.length} Telegram bot(s) are running.`);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
