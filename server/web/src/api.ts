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
  rotation_mode: "random" | "sequential";
  min_interval: number;
  max_interval: number;
  quiet_start: number | null;
  quiet_end: number | null;
  enabled: number;
  photo_count: number;
}

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
  /** The galleries this frame shows. */
  galleries: number[];
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
 * Perform an API request.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
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
    rotation_mode?: "random" | "sequential";
    min_interval?: number;
    max_interval?: number;
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
   */
  photoPreviewUrl: (id: number) => `/api/photos/${id}/preview`,

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
    }>,
  ) =>
    request<{ status: string }>(`/api/devices/${deviceId}/policy`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  schedule: (deviceId: number) =>
    request<{ revision: string; items: ScheduleItem[] }>(`/api/devices/${deviceId}/schedule`),

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
