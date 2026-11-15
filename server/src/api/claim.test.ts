import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { buildServer, type BuiltServer } from "../index.js";
import { generateKeyPair, publicKeyToBase64 } from "../auth/signing.js";

/**
 * A server on a throwaway database.
 */
async function makeServer(): Promise<BuiltServer> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "paperloom-claim-"));
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

  const setCookie = login.headers["set-cookie"];
  assert.ok(setCookie, "the login must set a session cookie");
  return String(setCookie).split(";")[0]!;
}

/**
 * Enrol a frame, and return its code.
 */
async function enrolFrame(
  server: BuiltServer,
): Promise<{ deviceId: string; code: string }> {
  const keys = generateKeyPair();
  const deviceId = `frame-${randomUUID()}`;

  const enrolled = await server.app.inject({
    method: "POST",
    url: "/api/device/enroll",
    payload: {
      device_id: deviceId,
      public_key: publicKeyToBase64(keys.publicKeyPem),
      name: "Living room",
      panel_width: 1200,
      panel_height: 1600,
    },
  });
  assert.equal(enrolled.statusCode, 200, enrolled.body);

  const body = enrolled.json() as { claim_code: string; claim_url: string };
  return { deviceId, code: body.claim_code };
}

describe("a frame that is waiting to be claimed", () => {
  it("gives the owner a code, and the code claims it", async (t) => {
    const server = await makeServer();
    t.after(async () => {
      await server.app.close();
    });

    const cookie = await signIn(server);
    const { deviceId, code } = await enrolFrame(server);

    assert.ok(code.length > 0, "the frame must be given a code");

    /* The owner types the code and the frame is theirs. */
    const claimed = await server.app.inject({
      method: "POST",
      url: "/api/devices/claim",
      headers: { cookie },
      payload: { code },
    });
    assert.equal(claimed.statusCode, 200, claimed.body);

    /* And it is in the list of frames now. */
    const listed = await server.app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { cookie },
    });
    const devices = listed.json() as Array<{ device_id: string; state: string }>;
    const frame = devices.find((d) => d.device_id === deviceId);
    assert.ok(frame, "the frame must be in the list once it is claimed");
    assert.equal(frame!.state, "claimed");
  });

  it("is not shown to anybody until it is claimed", async (t) => {
    const server = await makeServer();
    t.after(async () => {
      await server.app.close();
    });

    const cookie = await signIn(server);
    const { deviceId } = await enrolFrame(server);

    /* A frame that belongs to nobody is not in anybody's list. */
    const listed = await server.app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { cookie },
    });
    const devices = listed.json() as Array<{ device_id: string }>;
    assert.equal(
      devices.find((d) => d.device_id === deviceId),
      undefined,
      "a frame waiting to be claimed must not be in the list",
    );
  });

  it("refuses a code that is not right", async (t) => {
    const server = await makeServer();
    t.after(async () => {
      await server.app.close();
    });

    const cookie = await signIn(server);

    const wrong = await server.app.inject({
      method: "POST",
      url: "/api/devices/claim",
      headers: { cookie },
      payload: { code: "NOPE-NOPE-NOPE" },
    });
    assert.equal(wrong.statusCode, 404);

    const empty = await server.app.inject({
      method: "POST",
      url: "/api/devices/claim",
      headers: { cookie },
      payload: {},
    });
    assert.equal(empty.statusCode, 400);
  });

  it("cannot be claimed twice", async (t) => {
    const server = await makeServer();
    t.after(async () => {
      await server.app.close();
    });

    const cookie = await signIn(server);
    const { code } = await enrolFrame(server);

    const first = await server.app.inject({
      method: "POST",
      url: "/api/devices/claim",
      headers: { cookie },
      payload: { code },
    });
    assert.equal(first.statusCode, 200, first.body);

    const second = await server.app.inject({
      method: "POST",
      url: "/api/devices/claim",
      headers: { cookie },
      payload: { code },
    });
    assert.equal(second.statusCode, 404, "the code is gone once it is used");
  });

  it("needs a signed-in owner", async (t) => {
    const server = await makeServer();
    t.after(async () => {
      await server.app.close();
    });

    const { code } = await enrolFrame(server);

    const anonymous = await server.app.inject({
      method: "POST",
      url: "/api/devices/claim",
      payload: { code },
    });
    assert.equal(anonymous.statusCode, 401);
  });
});
