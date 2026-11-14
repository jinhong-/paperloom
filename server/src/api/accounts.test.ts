/**
 * Test of accounts and invitations.
 *
 * The first account is the owner's, and is the only one that can be made
 * through the registration page. Everybody else is invited by the owner,
 * so that nobody can simply make themselves an account and start looking
 * at the owner's photos.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildServer, type BuiltServer } from "../index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function makeServer(): Promise<BuiltServer> {
  const dir = mkdtempSync(join(tmpdir(), "paperloom-test-"));
  return buildServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    logLevel: "silent",
  });
}

/**
 * Make the first account and give it a session.
 */
async function makeOwner(server: BuiltServer): Promise<string> {
  const register = await server.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "owner", password: "a-long-enough-password" },
  });
  assert.equal(register.statusCode, 200);

  const login = await server.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "owner", password: "a-long-enough-password" },
  });
  assert.equal(login.statusCode, 200);

  const cookie = login.cookies.find((c) => c.name === "paperloom_session");
  assert.ok(cookie, "the login must set a session cookie");
  return `paperloom_session=${cookie.value}`;
}

test("the first account can be registered", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const status = await server.app.inject({
    method: "GET",
    url: "/api/auth/registration",
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().open, true, "registration must be open with no users");

  const register = await server.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "owner", password: "a-long-enough-password" },
  });
  assert.equal(register.statusCode, 200);
});

test("a second account cannot be registered", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  await makeOwner(server);

  const status = await server.app.inject({
    method: "GET",
    url: "/api/auth/registration",
  });
  assert.equal(status.json().open, false, "registration must be closed once there is an owner");

  const register = await server.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "intruder", password: "a-long-enough-password" },
  });
  assert.equal(register.statusCode, 403, "a second account must be refused");
});

test("the owner can invite somebody, and they choose their own password", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const cookie = await makeOwner(server);

  const invite = await server.app.inject({
    method: "POST",
    url: "/api/users/invitations",
    headers: { cookie },
    payload: { username: "guest" },
  });
  assert.equal(invite.statusCode, 200);
  const code = invite.json().invite_code as string;
  assert.ok(code, "the invitation must have a code");

  /* The invitation can be looked at, so that the person can see who
   * invited them. */
  const info = await server.app.inject({
    method: "GET",
    url: `/api/invitations/${code}`,
  });
  assert.equal(info.statusCode, 200);
  assert.equal(info.json().username, "guest");
  assert.equal(info.json().invited_by, "owner");

  /* The password is chosen by the person who was invited. */
  const accept = await server.app.inject({
    method: "POST",
    url: `/api/invitations/${code}`,
    payload: { password: "another-long-password" },
  });
  assert.equal(accept.statusCode, 200);

  /* And they can sign in with it. */
  const login = await server.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "guest", password: "another-long-password" },
  });
  assert.equal(login.statusCode, 200);

  /* The invitation cannot be used twice. */
  const again = await server.app.inject({
    method: "POST",
    url: `/api/invitations/${code}`,
    payload: { password: "a-third-long-password" },
  });
  assert.equal(again.statusCode, 410, "an invitation must not work twice");
});

test("an invitation needs a signed-in owner", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const invite = await server.app.inject({
    method: "POST",
    url: "/api/users/invitations",
    payload: { username: "guest" },
  });
  assert.equal(invite.statusCode, 401, "an invitation must need a signed-in owner");
});

test("the owner can see who has access", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const cookie = await makeOwner(server);

  await server.app.inject({
    method: "POST",
    url: "/api/users/invitations",
    headers: { cookie },
    payload: { username: "guest" },
  });

  const people = await server.app.inject({
    method: "GET",
    url: "/api/users",
    headers: { cookie },
  });
  assert.equal(people.statusCode, 200);

  const body = people.json();
  assert.equal(body.users.length, 1, "only the owner has joined so far");
  assert.equal(body.users[0].username, "owner");
  assert.equal(body.invitations.length, 1, "the invitation is waiting");
  assert.equal(body.invitations[0].username, "guest");
  assert.equal(body.invitations[0].accepted_at, null);

  /* The code is not handed out again: it is shown once, when the
   * invitation is made. */
  assert.equal(body.invitations[0].invite_code, undefined);
});
