/**
 * Test of the gallery's own settings.
 *
 * A gallery says when it changes and how its pictures look, and it has to
 * say something the server will accept: the intervals have to be sensible,
 * and the way of preparing the pictures has to be one we know.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

import { buildServer, type BuiltServer } from "../index.js";

/**
 * A server on a throwaway database.
 */
async function makeServer(): Promise<BuiltServer> {
  const dir = mkdtempSync(join(tmpdir(), "paperloom-gallery-"));
  return buildServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    logLevel: "silent",
  });
}

/**
 * Register an account and return a session cookie.
 */
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

test("a gallery can be created and its settings read back", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const cookie = await signIn(server);

  const created = await server.app.inject({
    method: "POST",
    url: "/api/galleries",
    headers: { cookie },
    payload: { name: "Gallery" },
  });
  assert.equal(created.statusCode, 200);
  const galleryId = (created.json() as { id: number }).id;

  const listed = await server.app.inject({
    method: "GET",
    url: "/api/galleries",
    headers: { cookie },
  });
  const galleries = listed.json() as Array<{ id: number; tone_preset: string }>;
  const gallery = galleries.find((g) => g.id === galleryId);
  assert.ok(gallery, "the gallery must be listed");
  assert.equal(gallery.tone_preset, "balanced", "the default way of preparing");
});

test("the way of preparing the pictures has to be one we know", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const cookie = await signIn(server);

  const created = await server.app.inject({
    method: "POST",
    url: "/api/galleries",
    headers: { cookie },
    payload: { name: "Gallery" },
  });
  const galleryId = (created.json() as { id: number }).id;

  const unknown = await server.app.inject({
    method: "PATCH",
    url: `/api/galleries/${galleryId}`,
    headers: { cookie },
    payload: { tone_preset: "not-a-way" },
  });
  assert.equal(unknown.statusCode, 400);

  const known = await server.app.inject({
    method: "PATCH",
    url: `/api/galleries/${galleryId}`,
    headers: { cookie },
    payload: { tone_preset: "grayscale" },
  });
  assert.equal(known.statusCode, 200);
});

test("the intervals have to be sensible", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const cookie = await signIn(server);

  const created = await server.app.inject({
    method: "POST",
    url: "/api/galleries",
    headers: { cookie },
    payload: { name: "Gallery" },
  });
  const galleryId = (created.json() as { id: number }).id;

  /* A gallery that changes every second would fill a plan with tens of
   * thousands of events. */
  const tooShort = await server.app.inject({
    method: "POST",
    url: `/api/galleries/${galleryId}/schedule-rules`,
    headers: { cookie },
    payload: { min_interval: 1, max_interval: 1 },
  });
  assert.equal(tooShort.statusCode, 400);

  const tooLong = await server.app.inject({
    method: "POST",
    url: `/api/galleries/${galleryId}/schedule-rules`,
    headers: { cookie },
    payload: { min_interval: 10_000_000, max_interval: 10_000_000 },
  });
  assert.equal(tooLong.statusCode, 400);

  const sensible = await server.app.inject({
    method: "POST",
    url: `/api/galleries/${galleryId}/schedule-rules`,
    headers: { cookie },
    payload: { min_interval: 120, max_interval: 300 },
  });
  assert.equal(sensible.statusCode, 200, sensible.body);
});

test("a rule says how the pictures are picked", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const cookie = await signIn(server);

  const created = await server.app.inject({
    method: "POST",
    url: "/api/galleries",
    headers: { cookie },
    payload: { name: "Gallery" },
  });
  const galleryId = (created.json() as { id: number }).id;

  const unknown = await server.app.inject({
    method: "POST",
    url: `/api/galleries/${galleryId}/schedule-rules`,
    headers: { cookie },
    payload: { rotation_mode: "sideways" },
  });
  assert.equal(unknown.statusCode, 400);

  const added = await server.app.inject({
    method: "POST",
    url: `/api/galleries/${galleryId}/schedule-rules`,
    headers: { cookie },
    payload: { min_interval: 3600, max_interval: 3600, rotation_mode: "sequential" },
  });
  assert.equal(added.statusCode, 200, added.body);

  const rules = await server.app.inject({
    method: "GET",
    url: `/api/galleries/${galleryId}/schedule-rules`,
    headers: { cookie },
  });
  const listed = rules.json() as Array<{ rotation_mode: string }>;
  assert.equal(listed[0]!.rotation_mode, "sequential");
});

test("a rule has to make sense", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const cookie = await signIn(server);

  const created = await server.app.inject({
    method: "POST",
    url: "/api/galleries",
    headers: { cookie },
    payload: { name: "Gallery" },
  });
  const galleryId = (created.json() as { id: number }).id;

  /* A time of day outside the day. */
  const badTime = await server.app.inject({
    method: "POST",
    url: `/api/galleries/${galleryId}/schedule-rules`,
    headers: { cookie },
    payload: { start_minute: 1500 },
  });
  assert.equal(badTime.statusCode, 400);

  /* An interval that is too short. */
  const badInterval = await server.app.inject({
    method: "POST",
    url: `/api/galleries/${galleryId}/schedule-rules`,
    headers: { cookie },
    payload: { min_interval: 5, max_interval: 10 },
  });
  assert.equal(badInterval.statusCode, 400);

  /* A rule with no interval at all is the gallery being still, which is
   * allowed. */
  const still = await server.app.inject({
    method: "POST",
    url: `/api/galleries/${galleryId}/schedule-rules`,
    headers: { cookie },
    payload: { start_minute: 0, end_minute: 1440, min_interval: null, max_interval: null },
  });
  assert.equal(still.statusCode, 200);
});

test("the rules of a gallery are read back in the same shape", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const cookie = await signIn(server);

  const created = await server.app.inject({
    method: "POST",
    url: "/api/galleries",
    headers: { cookie },
    payload: { name: "Gallery" },
  });
  const galleryId = (created.json() as { id: number }).id;

  await server.app.inject({
    method: "POST",
    url: `/api/galleries/${galleryId}/schedule-rules`,
    headers: { cookie },
    payload: {
      days: 127,
      start_minute: 1320,
      end_minute: 420,
      min_interval: 3600,
      max_interval: 3600,
      priority: 0,
    },
  });

  const listed = await server.app.inject({
    method: "GET",
    url: `/api/galleries/${galleryId}/schedule-rules`,
    headers: { cookie },
  });
  assert.equal(listed.statusCode, 200);

  const rules = listed.json() as Array<{
    id: number;
    days: number;
    start_minute: number;
    end_minute: number;
    min_interval: number | null;
    max_interval: number | null;
  }>;
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.start_minute, 1320);
  assert.equal(rules[0]!.end_minute, 420);
  assert.equal(rules[0]!.min_interval, 3600);
});
