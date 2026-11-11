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
import { openDatabase, type Db } from "./db/index.js";
import { ScheduleService } from "./schedule/service.js";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /** Directory holding the SQLite database and the asset store. */
  readonly dataDir: string;
  readonly logLevel: string;
}

export function loadConfig(): ServerConfig {
  return {
    host: process.env.PAPERLOOM_HOST ?? "0.0.0.0",
    port: Number(process.env.PAPERLOOM_PORT ?? 8080),
    dataDir: process.env.PAPERLOOM_DATA_DIR ?? join(process.cwd(), "data"),
    logLevel: process.env.PAPERLOOM_LOG_LEVEL ?? "info",
  };
}

export interface BuiltServer {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly assets: AssetStore;
  readonly schedules: ScheduleService;
}

/**
 * Build the server without starting it. Used by the tests.
 */
export async function buildServer(config: ServerConfig): Promise<BuiltServer> {
  const db = openDatabase({ path: join(config.dataDir, "paperloom.db") });

  const assetRoot = join(config.dataDir, "assets");
  mkdirSync(assetRoot, { recursive: true });

  const assets = new AssetStore(db, assetRoot);
  const schedules = new ScheduleService(db, assets);

  const app = fastify({
    logger: { level: config.logLevel },
    // The signed-request scheme digests the raw body, so the raw bytes must
    // be preserved for the device API.
    bodyLimit: 32 * 1024 * 1024,
  });

  app.register(cookie, { secret: process.env.PAPERLOOM_COOKIE_SECRET ?? "paperloom-dev-secret" });

  const deviceBasePath = "/api/device";
  const managementBasePath = "/api";

  registerDeviceApi(app, { db, assets, schedules, basePath: deviceBasePath });
  registerEnrollmentApi(app, { db, basePath: deviceBasePath });
  registerManagementApi(app, { db, assets, schedules, basePath: managementBasePath });

  app.get("/healthz", async () => ({ status: "ok" }));

  // Serve the management UI if it has been built. The UI is a static
  // bundle produced by `npm run build` in server/web.
  const webRoot = join(process.cwd(), "web", "dist");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });

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

  return { app, db, assets, schedules };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = await buildServer(config);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Paperloom server listening on ${config.host}:${config.port}`);
  app.log.info(`Data directory: ${config.dataDir}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
