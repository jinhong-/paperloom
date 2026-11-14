/**
 * Database schema.
 *
 * SQLite via better-sqlite3. The schema is small and mostly append-only:
 * galleries and their photos are authored content, devices are enrolled
 * hardware, and schedules are materialised server policy.
 *
 * Migrations are plain SQL files applied in order and recorded in
 * `schema_migrations`. Keeping them as files (rather than inline strings)
 * means the schema can be read and edited without touching code.
 */

export interface Migration {
  readonly id: string;
  readonly sql: string;
}

/**
 * The initial schema.
 *
 * Design notes:
 *
 * - `photos.content_hash` is the immutable asset identity. It is the SHA-256
 *   of the *rendered* asset bytes, not of the source file, so that a change
 *   to the dither settings produces a new asset and a change to the source
 *   file with identical rendering does not.
 *
 * - `devices.public_key` holds the ECDSA P-256 public key a device signs
 *   requests with, in uncompressed point format, base64 encoded.
 *
 * - `schedules` stores the materialised event window handed to a device.
 *   The `revision` is a content hash of the window itself, which is what
 *   the device echoes back to acknowledge "I have this schedule".
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_initial",
    sql: `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE galleries (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- Scheduling policy for this gallery.
  rotation_mode TEXT NOT NULL DEFAULT 'random',  -- random | sequential
  -- Minimum seconds between two displays of this gallery.
  min_interval  INTEGER NOT NULL DEFAULT 900,
  -- Maximum seconds between two displays of this gallery.
  max_interval  INTEGER NOT NULL DEFAULT 21600,
  -- Per-photo weight for weighted random selection; NULL means uniform.
  -- Photos carry their own weight in photos.weight.
  -- Quiet hours in minutes-from-midnight; NULL means no quiet hours.
  quiet_start   INTEGER,
  quiet_end     INTEGER,
  -- Whether this gallery is currently eligible for scheduling.
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_galleries_user ON galleries(user_id);

CREATE TABLE photos (
  id            INTEGER PRIMARY KEY,
  gallery_id    INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  -- SHA-256 of the source bytes, hex. Identifies the original upload.
  source_hash   TEXT NOT NULL,
  -- SHA-256 of the rendered asset bytes, hex. Identifies the display-ready
  -- asset the device will download.
  content_hash  TEXT,
  width         INTEGER,
  height        INTEGER,
  byte_size     INTEGER,
  taken_at      TEXT,
  -- Relative weight for weighted random selection.
  weight        REAL NOT NULL DEFAULT 1.0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_photos_gallery ON photos(gallery_id);

CREATE TABLE devices (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Human-readable label; unique per owner.
  name          TEXT NOT NULL,
  -- Stable public identifier transmitted on the wire.
  device_id     TEXT NOT NULL UNIQUE,
  -- Base64 uncompressed P-256 public key, or NULL while unclaimed.
  public_key    TEXT,
  -- Enrollment state: pending | claimed | revoked
  state         TEXT NOT NULL DEFAULT 'pending',
  -- Short-lived claim code shown on the panel as a QR code.
  claim_code    TEXT,
  claim_expires_at TEXT,
  -- Panel description, e.g. width/height/colour count.
  panel_width   INTEGER NOT NULL DEFAULT 1200,
  panel_height  INTEGER NOT NULL DEFAULT 1600,
  -- Device-side timezone for interpreting local policies.
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  -- Battery voltage in millivolts, from the last check-in.
  battery_mv    INTEGER,
  firmware_version TEXT,
  -- Last asset the device confirmed it applied to the panel.
  displayed_asset TEXT,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_devices_user ON devices(user_id);

-- The gallery a device rotates through.
CREATE TABLE device_galleries (
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  gallery_id  INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, gallery_id)
);

-- A materialised display schedule handed to a device.
-- revision is the content hash of (device, window_start, events); it is the
-- identity of the schedule, not a counter.
CREATE TABLE schedules (
  id            INTEGER PRIMARY KEY,
  device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  revision      TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  window_end    TEXT NOT NULL,
  -- JSON array of { "at": ISO8601, "asset": "<content hash>" }.
  events_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_schedules_device ON schedules(device_id, window_start);

-- Rendered assets, content-addressed by their hash.
CREATE TABLE assets (
  content_hash  TEXT PRIMARY KEY,
  byte_size     INTEGER NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Short-lived, single-use nonces for request replay defence.
-- seen_at uses ISO-8601 UTC so it sorts consistently with the timestamps
-- written by the application.
CREATE TABLE request_nonces (
  device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  nonce      TEXT NOT NULL,
  seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX idx_nonces_seen ON request_nonces(seen_at);

-- Refresh tokens for the management UI.
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-device sync policy.
CREATE TABLE device_policies (
  device_id        INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  -- How often the server wants the device to check in.
  sync_interval    INTEGER NOT NULL DEFAULT 3600,
  -- How far ahead of now the server materialises display events.
  lookahead        INTEGER NOT NULL DEFAULT 10800,
  -- Quiet hours for the device: minutes from midnight, local time.
  quiet_start      INTEGER,
  quiet_end        INTEGER,
  timezone         TEXT NOT NULL DEFAULT 'UTC'
);
`,
  },
  {
    id: "0002_nonce_timestamp_format",
    sql: `
-- The replay-defence nonces were originally stored with SQLite's
-- datetime('now') format ("YYYY-MM-DD HH:MM:SS"), which does not sort
-- correctly against the ISO-8601 timestamps the application writes. That
-- made the cleanup query delete every nonce, silently disabling replay
-- protection.
--
-- Rebuild the table with an ISO-8601 default and migrate the existing rows.
CREATE TABLE request_nonces_new (
  device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  nonce      TEXT NOT NULL,
  seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (device_id, nonce)
);

INSERT INTO request_nonces_new (device_id, nonce, seen_at)
  SELECT device_id, nonce,
         strftime('%Y-%m-%dT%H:%M:%fZ', seen_at)
  FROM request_nonces;

DROP TABLE request_nonces;
ALTER TABLE request_nonces_new RENAME TO request_nonces;

CREATE INDEX idx_nonces_seen ON request_nonces(seen_at);
`,
  },
  {
    id: "0003_device_clock_and_power",
    sql: `
-- What the device's own clock read at its last check-in, and whether it
-- was anchored to real time. A frame whose clock has been lost, or that
-- is drifting, is visible here rather than silently showing the wrong
-- photo at the wrong time.
ALTER TABLE devices ADD COLUMN clock_ms INTEGER;

-- Whether the device's clock was anchored to real time when it reported.
ALTER TABLE devices ADD COLUMN clock_anchored INTEGER;

-- Whether the frame is running on battery rather than mains power. A frame
-- on battery spends more of its time asleep and less of it on the radio.
ALTER TABLE devices ADD COLUMN on_battery INTEGER;
`,
  },
  {
    id: "0005_device_rotation",
    sql: `
-- How far the picture is turned on the frame.
--
-- The panel is always driven in portrait, so this is a change to the
-- picture rather than to the panel: the photo is rendered at the turned
-- dimensions and then turned back so that it lands the right way up.
ALTER TABLE devices ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: "0004_sync_rules",
    sql: `
-- Time-based check-in rules.
--
-- A frame does not need to check in at the same rate all day. During the
-- hours when somebody is around, it can be responsive; overnight it can
-- save power by checking in rarely. Each rule says which days of the week
-- it applies to, the time of day it covers, and how often the frame should
-- check in during that time.
CREATE TABLE device_sync_rules (
  id            INTEGER PRIMARY KEY,
  device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- Bit mask of days: bit 0 is Sunday, bit 6 is Saturday.
  days          INTEGER NOT NULL DEFAULT 127,
  -- Minutes from local midnight.
  start_minute  INTEGER NOT NULL DEFAULT 0,
  end_minute    INTEGER NOT NULL DEFAULT 1440,
  -- How often the frame should check in during this time.
  sync_interval INTEGER NOT NULL DEFAULT 3600,
  -- Lower numbers win when several rules cover the same moment.
  priority      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_sync_rules_device ON device_sync_rules(device_id);
`,
  },
  {
    id: "0006_photo_assets",
    sql: `
-- The rendered asset for a photo at a given rotation.
--
-- A frame can be mounted with the picture turned, so the same photo
-- needs a different rendering for each rotation. The asset's hash is the
-- hash of its bytes, so each rendering is its own asset, and the frame is
-- told which one it wants.
CREATE TABLE photo_assets (
  photo_id     INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  rotation     INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (photo_id, rotation)
);

CREATE INDEX idx_photo_assets_hash ON photo_assets(content_hash);
`,
  },
  {
    id: "0007_invitations",
    sql: `
-- An invitation for somebody to join.
--
-- The first account is the owner's, and is made through the registration
-- page. Everybody after that is invited by the owner, so that nobody can
-- simply make themselves an account and start looking at the owner's
-- photos.
--
-- The invitation holds the name the person will use and the code they
-- follow to choose their password. The code is what makes the invitation
-- usable, so it is stored and checked rather than sent.
CREATE TABLE invitations (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT,
  invite_code   TEXT NOT NULL UNIQUE,
  invited_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at   TEXT
);

CREATE INDEX idx_invitations_code ON invitations(invite_code);
`,
  },
{
    id: "0008_telegram",
    sql: `
-- The Telegram bot for a gallery.
--
-- Each gallery has its own bot, with its own token. A picture sent to
-- that bot is filed into that gallery, so the server does not have to be
-- told which chat a picture belongs in: the bot it arrived through says
-- so by itself.
--
-- The token is the bot's identity as far as Telegram is concerned, and
-- it is a secret, so it is stored here rather than in the environment.
-- A gallery without a bot has no row here.
CREATE TABLE telegram_bots (
  id            INTEGER PRIMARY KEY,
  -- The gallery the bot files its pictures into.
  gallery_id    INTEGER NOT NULL UNIQUE REFERENCES galleries(id) ON DELETE CASCADE,
  -- The bot's token, as given by BotFather.
  token         TEXT NOT NULL,
  -- The bot's own name, once it has been checked with Telegram.
  username      TEXT,
  -- The last error seen when talking to Telegram, if there was one.
  error         TEXT,
  -- Whether the server is currently asking Telegram for this bot's
  -- updates.
  polling       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The chats that talk to a gallery's bot.
--
-- A chat is not bound to a gallery directly, but to the bot that files
-- into one. The gallery is worked out from the bot.
CREATE TABLE telegram_chats (
  id            INTEGER PRIMARY KEY,
  -- The bot the chat talks to.
  bot_id        INTEGER NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
  -- The Telegram chat id. Negative for group chats, which Telegram
  -- makes unique per group.
  chat_id       TEXT NOT NULL,
  -- A human name for the chat, so it can be told apart in the UI.
  label         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (bot_id, chat_id)
);

CREATE INDEX idx_telegram_chats_bot ON telegram_chats(bot_id);

-- Pictures waiting to be rendered.
--
-- Rendering a photo takes a moment, and a chat can send several at once,
-- so a picture is queued and rendered in the background rather than in
-- the request that received it. The queue is a table rather than an
-- in-memory list so that a picture survives a restart of the server.
CREATE TABLE photo_jobs (
  id            INTEGER PRIMARY KEY,
  -- The gallery the picture belongs in.
  gallery_id    INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  -- The hash of the uploaded bytes, which is where the original is kept.
  source_hash   TEXT NOT NULL,
  -- The name the picture is known by.
  filename      TEXT NOT NULL,
  -- Where the picture came from, e.g. "telegram".
  origin        TEXT NOT NULL DEFAULT 'unknown',
  -- pending | processing | done | failed
  status        TEXT NOT NULL DEFAULT 'pending',
  -- Why the job failed, when it did.
  error         TEXT,
  -- The row id of the photo once it has been rendered.
  photo_id      INTEGER REFERENCES photos(id) ON DELETE SET NULL,
  -- How many times the job has been tried.
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_photo_jobs_status ON photo_jobs(status, id);
`,
  },
];
