# AGENTS.md

Guidance for AI agents working in this repository.

## The project

Paperloom is a self-hosted photo frame. A Node server owns the galleries,
the scheduling policy and the image processing; an ESP32-S3 device executes
precomputed display events using locally cached images.

```text
paperloom/
├── firmware/    # ESP32-S3 firmware (ESP-IDF, C)
├── server/      # Fastify + SQLite API, scheduling, and the Vue management UI
└── hassio/      # Home Assistant add-on packaging
```

The server lives in `server/`, and the management UI in `server/web/`. The
firmware is C for ESP-IDF, and is built with `firmware/build.py`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/). The format
is:

```text
<type>(optional scope): <description>
```

The type comes first and is required. The scope, in parentheses, is optional
and names the part of the codebase the commit touches. The description is
written in the imperative mood, in the lower case, with no trailing full
stop.

```text
feat(telegram): add a bot for each gallery
fix(schedule): discard the window when a gallery changes
docs: explain how the device sleeps
```

### Types

| Type | When to use it | Release |
|---|---|---|
| `feat` | A new feature that a user can see | minor |
| `fix` | A bug fix | patch |
| `docs` | Documentation only | none |
| `refactor` | Restructuring, with no behaviour change | none |
| `test` | Adding or changing tests only | none |
| `perf` | A change made for speed | none |
| `build` | Build system, dependencies, packaging | none |
| `ci` | Continuous integration configuration | none |
| `chore` | Maintenance that fits nowhere else | none |

Only `feat` and `fix` change the released version. A commit that breaks
something publicly is marked with `!` after the type, or with a
`BREAKING CHANGE:` footer, and cuts a major release.

### Scopes

Use the scope to say which part of the code changed, so that the history is
readable at a glance. These are the ones in use:

| Scope | Covers |
|---|---|
| `server` | The API, scheduling, storage and the database |
| `web` | The management UI in `server/web` |
| `firmware` | The ESP32-S3 firmware |
| `hassio` | The Home Assistant add-on |
| `telegram` | The Telegram bot, its queue and its bindings |
| `gallery` | Galleries, photos and their rendering |

A change that spans two parts picks the scope of the part that matters
most, and says the rest in the description:

```text
feat(web): show the frame's battery level in the server
```

A pull request title is checked against the Conventional Commits format by
`.github/scripts/check-conventional-title.mjs`, and it accepts a single
scope of letters, digits, dots, dashes and underscores. A title with a
comma in the scope, such as `feat(server, web): ...`, is rejected, so
commit titles may name two scopes but a pull request title may not.

Leave the scope off when a change is genuinely cross-cutting, rather than
inventing a scope for it.

### The released package

Release Please releases only `server/web`, the management UI. A commit that
changes the server or the firmware but not the UI will not cut a release on
its own, which is why the scope matters: `feat(web): ...` is the one that
moves the version.

### Examples from the history

```text
feat: add Home Assistant add-on packaging
fix: build the Home Assistant app from its own directory
feat(server, web): the first account owns the server, and the rest are invited
feat(telegram): add a bot for each gallery
```

### Committing

Before committing, check that the work builds and the tests pass:

```bash
cd server
npm run typecheck
npm test
npm --prefix web run build
```

Stage deliberately. Do not use `git add .` or `git commit -a` — they sweep
in build output, scratch files and other people's changes. Add the files the
change actually touched, and check `git status` afterwards to see what went
in.

Write the description for somebody reading the history in a year: say what
changed and why, not which files were edited. Keep the subject line under
about 70 characters, and use the body for the reasoning when the reason is
not obvious from the subject.

## Working on the code

### The server

TypeScript, strict mode, ES modules, Node 20 or newer. Fastify for HTTP,
`better-sqlite3` for the database and `sharp` for images. There is no ORM;
the queries are plain SQL written inline in the route modules.

The database schema is in `server/src/db/schema.ts`, as a list of migrations.
Each migration is plain SQL, applied in order and recorded in
`schema_migrations`. Adding a change to the schema means adding a migration
with the next number, never editing one that has already been applied.

The management API lives in `server/src/api/management.ts` and is
authenticated with a session cookie. The device API in
`server/src/api/device.ts` is authenticated with an ECDSA signature instead,
and the two must not be mixed.

### The management UI

Vue 3 with the composition API, TypeScript, Vite, and Pinia for state. The
API client is `server/web/src/api.ts`; the shared session state is in
`server/web/src/stores/session.ts`.

### The firmware

C for ESP-IDF. The server and the firmware must agree exactly on the wire
format for a display asset; `server/src/panel.ts` is the single source of
truth for it, and the firmware has to match it byte for byte.

Build it with:

```bash
cd firmware
python build.py build
```

### Tests

The server's tests use the Node test runner through `tsx`:

```bash
cd server
npm test
```

The test list in `server/package.json` is explicit, so a new test file has to
be added to it. There is no test suite for the firmware.

## Before finishing

- `npm run typecheck` and `npm test` pass in `server/`.
- `npm --prefix web run build` succeeds in `server/`.
- A schema change comes with a new migration.
- The commit message follows Conventional Commits.
