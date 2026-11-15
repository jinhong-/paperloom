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
  {
    id: "0009_pinned_photos",
    sql: `
-- A picture waiting to be shown at a particular moment.
--
-- A picture sent from Telegram is pinned to the next check-in of each
-- frame that shows its gallery, so that it appears on the next wake
-- rather than at some random point in the rotation.
--
-- The pin is one row per frame. It holds the moment the picture is to be
-- shown and the picture itself.
CREATE TABLE pinned_photos (
  id            INTEGER PRIMARY KEY,
  -- The frame the picture is pinned to.
  device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- The picture to show.
  photo_id      INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  -- The moment the picture is to be shown, in epoch milliseconds.
  at            INTEGER NOT NULL,
  -- Whether the picture has been shown yet.
  shown         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- A frame holds at most one pinned picture at a time, and a picture is
  -- pinned to one frame at a time.
  UNIQUE (device_id),
  UNIQUE (photo_id, device_id)
);

CREATE INDEX idx_pinned_photos_device ON pinned_photos(device_id);
CREATE INDEX idx_pinned_photos_at ON pinned_photos(at);
`,
  },
  {
    id: "0010_telegram_users",
    sql: `
-- The people who talk to the bots.
--
-- A Telegram user is not a Paperloom user. They have no account and no
-- password: their identity is the id Telegram gives them, and the bot's
-- token is what proves that a message came through the bot it was sent
-- to. They are kept in their own table rather than in the users table,
-- because the two are not the same thing and have nothing to do with each
-- other.
CREATE TABLE telegram_users (
  id            INTEGER PRIMARY KEY,
  -- The id Telegram gives the user. It is unique across Telegram, so it
  -- identifies the person on every bot.
  telegram_id   TEXT NOT NULL UNIQUE,
  -- The name the person has on Telegram, if they have one. It can change,
  -- and two people can have the same one, so it is only ever shown.
  username     TEXT,
  -- The name the person goes by, if they have given one.
  display_name TEXT,
  -- The first time a picture from this person was seen.
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- The last time a picture from this person was seen.
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What a person may do with a gallery's bot.
--
-- The access is per bot, and therefore per gallery: a person allowed to
-- send pictures to one gallery's bot is not thereby allowed to send
-- pictures to another's.
--
-- A person who has never been seen has no row here at all. When they send
-- a picture they are given one with the state "pending", which is what
-- makes them show up in the management interface to be allowed or
-- blocked.
--
-- allowed | pending | blocked
CREATE TABLE telegram_user_access (
  id            INTEGER PRIMARY KEY,
  -- The person.
  user_id       INTEGER NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
  -- The bot they are talking to.
  bot_id        INTEGER NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
  -- Whether they may send pictures to this bot.
  status        TEXT NOT NULL DEFAULT 'pending',
  -- Who decided, and when.
  decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, bot_id)
);

CREATE INDEX idx_telegram_user_access_bot ON telegram_user_access(bot_id, status);
CREATE INDEX idx_telegram_user_access_user ON telegram_user_access(user_id);
`,
  },
  {
    id: "0011_held_photos",
    sql: `
-- The pictures that are waiting for somebody to be allowed.
--
-- A picture from a person who has not been allowed yet is held rather
-- than filed. It is kept here with the picture itself, so that it can be
-- filed once the owner allows them, and so that the owner can see what
-- they are being asked about.
--
-- The picture is held in the asset store under its own hash, the same as
-- any other picture, so nothing about it is special.
CREATE TABLE held_photos (
  id            INTEGER PRIMARY KEY,
  -- The gallery the picture was sent to.
  gallery_id    INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  -- The person who sent it.
  telegram_id   TEXT NOT NULL,
  -- The hash of the picture, which is where the bytes are kept.
  source_hash   TEXT NOT NULL,
  -- The name the picture is known by.
  filename      TEXT NOT NULL,
  -- The chat it was sent in, so that the person can be told.
  chat_id       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_held_photos_gallery ON held_photos(gallery_id);
CREATE INDEX idx_held_photos_telegram ON held_photos(telegram_id);
`,
  },
  {
    id: "0012_drop_telegram_chats",
    sql: `
-- The chats are gone.
--
-- A chat was authorised as a whole, which meant that everybody in a group
-- could file pictures into a gallery. The people who talk to a bot are
-- now authorised one by one, which is finer grained and says who is
-- actually sending the pictures.
--
-- The table is dropped rather than left empty, so that there is only one
-- way of deciding who may send a picture.
DROP TABLE IF EXISTS telegram_chats;
`,
  },
  {
    id: "0013_pinned_queue",
    sql: `
-- The pins become a queue.
--
-- A frame held at most one pinned picture, so a second picture sent
-- replaced the first and only the last was ever shown. The pictures you
-- send are meant to be seen, in the order you sent them, so each one now
-- takes the place after the last in the queue.
--
-- The row that is first in the queue is the one the frame shows next.
CREATE TABLE pinned_photos_new (
  id            INTEGER PRIMARY KEY,
  -- The frame the picture is pinned to.
  device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- The picture to show.
  photo_id      INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  -- The moment the picture is to be shown, in epoch milliseconds.
  at            INTEGER NOT NULL,
  -- Whether the picture has been shown yet.
  shown         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- A picture is pinned to one frame at a time.
  UNIQUE (photo_id, device_id)
);

INSERT INTO pinned_photos_new (id, device_id, photo_id, at, shown, created_at, updated_at)
  SELECT id, device_id, photo_id, at, shown, created_at, updated_at
  FROM pinned_photos;

DROP TABLE pinned_photos;
ALTER TABLE pinned_photos_new RENAME TO pinned_photos;

CREATE INDEX idx_pinned_photos_device ON pinned_photos(device_id);
CREATE INDEX idx_pinned_photos_at ON pinned_photos(at);
`,
  },
  {
    id: "0014_plan_handover",
    sql: `
-- The plan a frame is following, and when it changes.
--
-- A plan is not thrown away when the gallery it shows changes. The frame
-- is following a plan, and it must be given the same plan until it is
-- ready to take a new one, or the two fall out of step: the frame shows a
-- picture at a time the server does not have, and the times in the
-- management page are not the times the frame is working to.
--
-- The plan is changed at the frame's next check-in, which is the moment
-- the frame is certain to be in touch. Until then the frame is given the
-- plan it is already following.
--
-- The column says when the plan is to change. It is null while the plan
-- is current, and holds the moment the change is to take effect once the
-- gallery has changed.
ALTER TABLE schedules ADD COLUMN handover_at INTEGER;
`,
  },
  {
    id: "0015_gallery_schedule",
    sql: `
-- How a gallery's pictures are prepared for the panel.
--
-- The reference project has five ways of preparing a picture, and the
-- difference between them is what the picture looks like. The gallery
-- chooses one, and every picture in it is prepared that way.
ALTER TABLE galleries ADD COLUMN tone_preset TEXT NOT NULL DEFAULT 'balanced';

-- When a gallery changes, and how often.
--
-- A gallery does not have to change its pictures at the same rate all
-- day. The rule says which days it applies to, the time of day it covers,
-- and how often the picture changes during that time. A rule with no
-- interval at all makes the gallery still for that time.
--
-- The rules are per gallery, because they are about the pictures. The
-- check-in rules are per frame, because they are about the radio.
CREATE TABLE gallery_schedule_rules (
  id            INTEGER PRIMARY KEY,
  -- The gallery the rule is for.
  gallery_id    INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  -- Bit mask of the days of the week the rule applies to.
  days          INTEGER NOT NULL DEFAULT 127,
  -- Minutes from local midnight.
  start_minute  INTEGER NOT NULL DEFAULT 0,
  end_minute    INTEGER NOT NULL DEFAULT 1440,
  -- The smallest gap between two pictures during this time, in seconds.
  --
  -- The gallery's own interval is used when this is null.
  min_interval  INTEGER,
  -- The largest gap between two pictures during this time, in seconds.
  max_interval  INTEGER,
  -- Lower numbers win when several rules cover the same moment.
  priority      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_gallery_schedule_rules_gallery ON gallery_schedule_rules(gallery_id);
`,
  },
  {
    id: "0016_one_gallery_per_device",
    sql: `
-- A frame shows one gallery.
--
-- A frame used to have as many galleries as it liked, and rotated through
-- them. A frame shows one thing, and the gallery is that thing, so the
-- gallery is a property of the frame rather than a list beside it.
--
-- The frames that had more than one gallery keep the first they were
-- given, which is the one they were showing when the change was made.
ALTER TABLE devices ADD COLUMN gallery_id INTEGER REFERENCES galleries(id) ON DELETE SET NULL;

-- The frames that had more than one gallery keep the first they were
-- given, which is the one they were showing when the change was made.
UPDATE devices
   SET gallery_id = (
     SELECT MIN(dg.gallery_id) FROM device_galleries dg WHERE dg.device_id = devices.id
   )
 WHERE gallery_id IS NULL;

DROP TABLE device_galleries;
CREATE INDEX idx_devices_gallery ON devices(gallery_id);

-- How often a rule changes the picture, in a unit the owner chose.
--
-- The interval is kept in seconds, and the unit is kept beside it so
-- that the page can say "every 5 days" rather than "every 432000
-- seconds". The unit is only for showing: the schedule itself is worked
-- out in seconds.
ALTER TABLE gallery_schedule_rules ADD COLUMN interval_unit TEXT NOT NULL DEFAULT 'minutes';
ALTER TABLE gallery_schedule_rules ADD COLUMN min_unit TEXT;
ALTER TABLE gallery_schedule_rules ADD COLUMN max_unit TEXT;
`,
  },
  {
    id: "0017_gallery_telegram_mode",
    sql: `
-- How pictures from a chat arrive at a gallery.
--
-- In the queue mode each picture is shown after the one before it, so
-- that the pictures arrive in the order they were sent. In the latest
-- mode a new picture replaces the one that is waiting, because a gallery
-- that changes once a day has no use for a queue of pictures: only the
-- last one sent is of any interest.
--
-- The mode belongs to the gallery, because it is about the pictures.
ALTER TABLE galleries ADD COLUMN telegram_mode TEXT NOT NULL DEFAULT 'queue';

-- Whether the gallery changes its picture on its own.
--
-- A gallery that is on changes at the pace its rules and its own
-- interval say. A gallery that is off changes only when the owner sets
-- the picture by hand, which is what a gallery of one particular picture
-- wants.
--
-- The setting is here rather than being worked out from the rules,
-- because a gallery that has just been made has no rules yet, and that
-- is not the same as a gallery that has been turned off.
ALTER TABLE galleries ADD COLUMN schedule_enabled INTEGER NOT NULL DEFAULT 1;

-- The picture a frame shows when its gallery has no schedule.
--
-- A gallery with no rules changes on its own schedule: nothing is
-- scheduled, and the picture shown is the one the owner has set. The
-- frame is told about it, and the picture is kept on the server for as
-- long as the frame might want it.
CREATE TABLE gallery_manual_pictures (
  gallery_id    INTEGER PRIMARY KEY REFERENCES galleries(id) ON DELETE CASCADE,
  -- The photo the picture is made from.
  photo_id      INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  -- The asset that is sent to the frame.
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  },
  {
    id: "0018_rule_rotation",
    sql: `
-- How a rule picks its pictures, and how often it changes.
--
-- The gap between two pictures is said by the rules now, in the unit the
-- owner chose, so the gallery's own gap goes.
--
-- The way the pictures are picked is said by the rules as well. A
-- gallery can show its pictures in order by day and pick them at random
-- at night, which is not something a single setting on the gallery can
-- say.
--
-- The rules that already existed become rules that cover every day, so
-- that a gallery that was set up before this change keeps working the
-- way it did.
INSERT INTO gallery_schedule_rules
  (gallery_id, days, start_minute, end_minute, min_interval, max_interval, priority)
SELECT id, 127, 0, 1440, min_interval, max_interval, 0
  FROM galleries
 WHERE min_interval IS NOT NULL;

ALTER TABLE gallery_schedule_rules ADD COLUMN rotation_mode TEXT NOT NULL DEFAULT 'random';

UPDATE gallery_schedule_rules
   SET rotation_mode = (
     SELECT g.rotation_mode FROM galleries g WHERE g.id = gallery_schedule_rules.gallery_id
   );

ALTER TABLE galleries DROP COLUMN min_interval;
ALTER TABLE galleries DROP COLUMN max_interval;
ALTER TABLE galleries DROP COLUMN rotation_mode;
`,
  },
  {
    id: "0019_show_next",
    sql: `
-- The picture a gallery shows next.
--
-- The owner can say "show this one next", and the picture is shown at the
-- frame's next change. The schedule then carries on as it was, so the
-- picture is shown once rather than taking the gallery's place.
--
-- This is the same thing a picture sent from a chat does, and it is kept
-- in the same place, so that the frame is given both in one list.
--
-- The gallery's own manual picture goes: it was shown for as long as it
-- was set, which is a different thing, and the schedule could not be
-- used at the same time.
DROP TABLE IF EXISTS gallery_manual_pictures;
`,
  },
];
