/**
 * The API client.
 *
 * A thin wrapper around fetch that handles the session cookie and turns
 * error responses into exceptions with a useful message.
 */

/** A gallery as the server returns it. */
export interface Gallery {
  id: number;
  name: string;
  quiet_start: number | null;
  quiet_end: number | null;
  enabled: number;
  /** How the pictures are prepared for the panel. */
  tone_preset: string;
  /** How the pictures from a chat arrive. */
  telegram_mode: "queue" | "latest";
  /** Whether the gallery changes its picture on its own. */
  schedule_enabled: number;
  photo_count: number;
  /** How many rules the gallery has. */
  rule_count: number;
  /** How many pictures are waiting to be shown. */
  waiting_count: number;
}

/**
 * A rule saying when a gallery changes its picture, and how.
 */
export interface GalleryScheduleRule {
  id: number;
  /** Bit mask of the days of the week the rule applies to. */
  days: number;
  /** Minutes from local midnight. */
  start_minute: number;
  /** Minutes from local midnight. */
  end_minute: number;
  /** The smallest gap between two pictures, in seconds. */
  min_interval: number | null;
  /** The largest gap between two pictures, in seconds. */
  max_interval: number | null;
  /** Lower numbers win when several rules cover the same moment. */
  priority: number;
  /** How the pictures of this rule are picked. */
  rotation_mode: "random" | "sequential";
}

/**
 * The ways a gallery's pictures can be prepared for the panel.
 *
 * These are the reference project's own, with the same names.
 */
export const TONE_PRESETS: ReadonlyArray<{
  value: string;
  title: string;
  description: string;
}> = [
  {
    value: "balanced",
    title: "Balanced",
    description: "Compresses the highlights so they do not blow out. Works well with most pictures.",
  },
  {
    value: "dynamic",
    title: "Dynamic",
    description: "Brighter and more colourful. Some parts may be overexposed.",
  },
  {
    value: "vivid",
    title: "Vivid",
    description: "Strong colours, for pictures that are colourful to begin with.",
  },
  {
    value: "soft",
    title: "Soft",
    description: "Softer, with better gradients.",
  },
  {
    value: "grayscale",
    title: "Grayscale",
    description: "For black and white pictures, matched to the panel in LAB space.",
  },
];

/** A photo as the server returns it. */
export interface Photo {
  id: number;
  filename: string;
  source_hash: string;
  content_hash: string | null;
  width: number | null;
  height: number | null;
  byte_size: number | null;
  taken_at: string | null;
  weight: number;
}

/** Somebody who has access to this server. */
export interface User {
  id: number;
  username: string;
  created_at: string;
}

/** An invitation that has not been taken up yet. */
export interface Invitation {
  id: number;
  username: string;
  invited_by: number;
  created_at: string;
  accepted_at: string | null;
}

/** A device as the server returns it. */
export interface DevicePolicy {
  sync_interval: number;
  lookahead: number;
  quiet_start: number | null;
  quiet_end: number | null;
}

export interface Device {
  id: number;
  name: string;
  device_id: string;
  state: "pending" | "claimed" | "revoked";
  panel_width: number;
  panel_height: number;
  timezone: string;
  rotation: number;
  battery_mv: number | null;
  firmware_version: string | null;
  displayed_asset: string | null;
  last_seen_at: string | null;
  created_at: string;
  /** The gallery this frame shows, if it has one. */
  gallery_id: number | null;
  /** The policy that decides how it checks in. */
  policy: DevicePolicy | null;
}

/** One scheduled display event. */
export interface ScheduleItem {
  at: string;
  asset: string;
  /** The name of the photo, where the server knows it. */
  filename?: string | null;
  /** The id of the photo, where the server knows it. */
  photo_id?: number | null;
}

/**
 * A time-based check-in rule.
 */
export interface SyncRule {
  id: number;
  /** Bit mask of the days the rule applies to. */
  days: number;
  /** Minutes from local midnight. */
  start_minute: number;
  /** Minutes from local midnight. */
  end_minute: number;
  /** How often the frame should check in during this time, in seconds. */
  sync_interval: number;
  /** Lower numbers win when several rules cover the same moment. */
  priority: number;
}

/**
 * A gallery's Telegram bot.
 */
export interface TelegramBot {
  id: number;
  gallery_id: number;
  gallery_name: string;
  username: string | null;
  error: string | null;
  polling: boolean;
  /** How many people may send pictures to this bot. */
  allowed_count: number;
  /** How many people are waiting to be let in. */
  pending_count: number;
  created_at: string;
}

/**
 * A person who talks to a gallery's bot.
 *
 * A Telegram person is not a Paperloom user. They have no account and no
 * password: Telegram's user id is their identity, and the bot's token is
 * what proves that a message came through the bot it was sent to.
 */
export interface TelegramPerson {
  id: number;
  telegramId: string;
  username: string | null;
  displayName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * What a person may do with a bot.
 */
export interface TelegramPersonAccess {
  person: TelegramPerson;
  botId: number;
  status: "allowed" | "pending" | "blocked";
  decidedAt: string | null;
  /** The picture that is waiting for a decision, if there is one. */
  heldFilename: string | null;
  /** How many pictures are waiting for a decision. */
  heldCount: number;
}

/**
 * A picture waiting to be rendered.
 */
export interface PhotoJob {
  id: number;
  filename: string;
  status: "pending" | "processing" | "done" | "failed";
  origin: string;
  attempts: number;
  error: string | null;
  created_at: string;
  gallery_name: string;
}

/**
 * An error carrying the server's message.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The address the API is at, relative to the page.
 *
 * The built UI refers to its assets relatively, so that it works behind
 * Home Assistant's path-prefixed ingress endpoint. The API has to be
 * reached the same way: an absolute path would leave the prefix and go
 * to Home Assistant itself, which answers with something that is not the
 * server's answer at all.
 *
 * The prefix is taken from the address the app's own script was loaded
 * from, which is exactly where the app is being served: the script sits
 * at <prefix>/assets/app.js, so the prefix is what comes before
 * /assets/.
 */
let cachedApiBase: string | null = null;

function apiBase(): string {
  if (cachedApiBase !== null) return cachedApiBase;

  const scripts = Array.from(
    document.querySelectorAll<HTMLScriptElement>("script[src]"),
  );
  const script = scripts.find((element) =>
    element.src.includes("/assets/"),
  );

  if (!script) {
    /* No script to learn the prefix from. The server is then at the root
     * of wherever the page is, which is the case when it is not behind a
     * path prefix. */
    cachedApiBase = "/";
    return cachedApiBase;
  }

  /* The script is at <prefix>/assets/app.js. The API is at <prefix>/api.
   * The prefix keeps its trailing slash, so that the address is put
   * together without a missing slash in the middle. */
  const index = script.src.indexOf("/assets/");
  cachedApiBase = index >= 0 ? script.src.slice(0, index + 1) : "/";
  return cachedApiBase;
}

/**
 * Perform an API request.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path.replace(/^\//, "")}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}

export const api = {
  /* Sessions */
  registrationOpen: () => request<{ open: boolean }>("/api/auth/registration"),

  register: (username: string, password: string) =>
    request<{ user_id: number }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  login: (username: string, password: string) =>
    request<{ status: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ status: string }>("/api/auth/logout", { method: "POST" }),

  me: () => request<{ id: number; username: string }>("/api/auth/me"),

  /* People */

  users: () =>
    request<{ users: User[]; invitations: Invitation[] }>("/api/users"),

  inviteUser: (username: string) =>
    request<{ id: number; username: string; invite_code: string }>(
      "/api/users/invitations",
      {
        method: "POST",
        body: JSON.stringify({ username }),
      },
    ),

  invitationInfo: (code: string) =>
    request<{ username: string; invited_by: string | null }>(`/api/invitations/${code}`),

  acceptInvitation: (code: string, password: string) =>
    request<{ user_id: number; username: string }>(`/api/invitations/${code}`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  /* Galleries */
  galleries: () => request<Gallery[]>("/api/galleries"),

  createGallery: (body: {
    name: string;
    schedule_enabled?: boolean;
    rules?: Array<{
      days?: number;
      start_minute?: number;
      end_minute?: number;
      min_interval?: number | null;
      max_interval?: number | null;
      priority?: number;
      rotation_mode?: "random" | "sequential";
    }>;
  }) =>
    request<{ id: number }>("/api/galleries", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateGallery: (id: number, body: Partial<Gallery>) =>
    request<{ status: string }>(`/api/galleries/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteGallery: (id: number) =>
    request<{ status: string }>(`/api/galleries/${id}`, { method: "DELETE" }),

  /* When a gallery changes its picture */

  galleryScheduleRules: (galleryId: number) =>
    request<GalleryScheduleRule[]>(`/api/galleries/${galleryId}/schedule-rules`),

  addGalleryScheduleRule: (
    galleryId: number,
    body: {
      days?: number;
      start_minute?: number;
      end_minute?: number;
      min_interval?: number | null;
      max_interval?: number | null;
      priority?: number;
      rotation_mode?: "random" | "sequential";
    },
  ) =>
    request<{ status: string; id: number }>(
      `/api/galleries/${galleryId}/schedule-rules`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  updateGalleryScheduleRule: (
    galleryId: number,
    ruleId: number,
    body: Partial<GalleryScheduleRule>,
  ) =>
    request<{ status: string }>(
      `/api/galleries/${galleryId}/schedule-rules/${ruleId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  removeGalleryScheduleRule: (galleryId: number, ruleId: number) =>
    request<{ status: string }>(
      `/api/galleries/${galleryId}/schedule-rules/${ruleId}`,
      { method: "DELETE" },
    ),

  /* The pictures a gallery is going to show next */

  showNext: (galleryId: number) =>
    request<{ pictures: Array<{ photo_id: number; at: string; filename: string }> }>(
      `/api/galleries/${galleryId}/show-next`,
    ),

  showNextPicture: (galleryId: number, photoId: number) =>
    request<{ status: string; shown_at: string | null }>(
      `/api/galleries/${galleryId}/show-next`,
      { method: "POST", body: JSON.stringify({ photo_id: photoId }) },
    ),

  clearShowNext: (galleryId: number) =>
    request<{ status: string }>(`/api/galleries/${galleryId}/show-next`, {
      method: "DELETE",
    }),

  /* Photos */
  photos: (galleryId: number) => request<Photo[]>(`/api/galleries/${galleryId}/photos`),

  uploadPhoto: (galleryId: number, filename: string, data: ArrayBuffer) =>
    request<{ id: number; filename: string; content_hash: string; byte_size: number }>(
      `/api/galleries/${galleryId}/photos`,
      {
        method: "POST",
        body: JSON.stringify({
          filename,
          data: bytesToBase64(new Uint8Array(data)),
        }),
      },
    ),

  deletePhoto: (id: number) =>
    request<{ status: string }>(`/api/photos/${id}`, { method: "DELETE" }),

  /**
   * The URL of a photo's original upload, for the gallery preview.
   *
   * It is built from the same base as the API calls, so that it is found
   * behind Home Assistant's path prefix as well as at the server's root.
   */
  photoPreviewUrl: (id: number) => `${apiBase()}/api/photos/${id}/preview`,

  /* Devices */
  devices: () => request<Device[]>("/api/devices"),

  assignGallery: (deviceId: number, galleryId: number) =>
    request<{ status: string }>(`/api/devices/${deviceId}/galleries`, {
      method: "POST",
      body: JSON.stringify({ gallery_id: galleryId }),
    }),

  unassignGallery: (deviceId: number, galleryId: number) =>
    request<{ status: string }>(`/api/devices/${deviceId}/galleries/${galleryId}`, {
      method: "DELETE",
    }),

  updatePolicy: (
    deviceId: number,
    body: Partial<{
      sync_interval: number;
      lookahead: number;
      quiet_start: number | null;
      quiet_end: number | null;
      timezone: string;
      rotation: number;
    }>,
  ) =>
    request<{ status: string }>(`/api/devices/${deviceId}/policy`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  schedule: (deviceId: number) =>
    request<{
      revision: string;
      /** The plan the frame is following now. */
      items: ScheduleItem[];
      /** When the plan is to change, if it is waiting to. */
      handover_at: string | null;
      /** What the plan will become when it changes. */
      projected: ScheduleItem[];
    }>(`/api/devices/${deviceId}/schedule`),

  /* Check-in rules */
  syncRules: (deviceId: number) => request<SyncRule[]>(`/api/devices/${deviceId}/sync-rules`),

  createSyncRule: (
    deviceId: number,
    body: {
      days: number;
      start_minute: number;
      end_minute: number;
      sync_interval: number;
      priority?: number;
    },
  ) =>
    request<{ id: number }>(`/api/devices/${deviceId}/sync-rules`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateSyncRule: (
    deviceId: number,
    ruleId: number,
    body: Partial<{
      days: number;
      start_minute: number;
      end_minute: number;
      sync_interval: number;
      priority: number;
    }>,
  ) =>
    request<{ status: string }>(`/api/devices/${deviceId}/sync-rules/${ruleId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteSyncRule: (deviceId: number, ruleId: number) =>
    request<{ status: string }>(`/api/devices/${deviceId}/sync-rules/${ruleId}`, {
      method: "DELETE",
    }),

  timezones: () => request<{ timezones: string[] }>("/api/timezones"),

  deleteDevice: (id: number) =>
    request<{ status: string }>(`/api/devices/${id}`, { method: "DELETE" }),

  /* Enrollment */
  claimInfo: (code: string) =>
    request<{
      device_id: string;
      name: string;
      panel_width: number;
      panel_height: number;
      expires_at: string;
    }>(`/api/device/claim/${code}`),

  claim: (code: string) =>
    request<{ status: string; device_id: number }>(`/api/device/claim/${code}`, {
      method: "POST",
    }),

  /**
   * Claim a frame with the code it shows.
   *
   * The code is printed on the frame, so it is the owner's proof that the
   * frame is theirs.
   */
  claimDevice: (code: string) =>
    request<{ status: string; device_id: number }>(`/api/devices/claim`, {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  /* Telegram */

  telegramBots: () => request<{ bots: TelegramBot[] }>("/api/telegram/bots"),

  /**
   * Give a gallery its own bot.
   */
  setTelegramBot: (galleryId: number, token: string) =>
    request<{ status: string; gallery_id: number; username: string | null }>(
      `/api/telegram/galleries/${galleryId}/bot`,
      {
        method: "POST",
        body: JSON.stringify({ token }),
      },
    ),

  removeTelegramBot: (galleryId: number) =>
    request<{ status: string }>(`/api/telegram/galleries/${galleryId}/bot`, {
      method: "DELETE",
    }),

  telegramQueue: () =>
    request<{ pending: number; jobs: PhotoJob[] }>("/api/telegram/queue"),

  /**
   * The people who talk to a bot, and what they may do with it.
   */
  telegramPeople: (botId: number) =>
    request<{ pending: TelegramPersonAccess[]; allowed: TelegramPersonAccess[] }>(
      `/api/telegram/bots/${botId}/people`,
    ),

  /**
   * Let a person send pictures to a bot.
   */
  allowTelegramPerson: (botId: number, telegramId: string) =>
    request<{ status: string; filed: number }>(
      `/api/telegram/bots/${botId}/people/${encodeURIComponent(telegramId)}/allow`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  /**
   * Stop a person sending pictures to a bot.
   */
  blockTelegramPerson: (botId: number, telegramId: string) =>
    request<{ status: string; discarded: number }>(
      `/api/telegram/bots/${botId}/people/${encodeURIComponent(telegramId)}/block`,
      { method: "POST", body: JSON.stringify({}) },
    ),
};

/**
 * Encode bytes as base64.
 *
 * We build the string in chunks so that a large photo does not blow the
 * argument limit of `String.fromCharCode`.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
