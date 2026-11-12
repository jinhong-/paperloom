/**
 * Time zone helpers.
 *
 * The list of zones comes from the browser's own runtime, which uses the
 * same IANA database as the server. That means the list is always
 * current, and it is the list the browser can actually use, which is not
 * quite the same thing: the browser knows its own zone for certain, but
 * it may not know every zone the server does.
 */

/**
 * Every time zone the browser knows about.
 */
export function availableTimeZones(): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;

  if (typeof supported === "function") {
    try {
      const zones = supported("timeZone");
      if (zones.length > 0) return [...zones].sort();
    } catch {
      // Fall through to the smaller list below.
    }
  }

  // A short list of the common zones, for a browser that does not offer
  // the full set.
  return [
    "UTC",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/New_York",
    "America/Sao_Paulo",
    "Asia/Dubai",
    "Asia/Kolkata",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
    "Europe/Amsterdam",
    "Europe/Berlin",
    "Europe/London",
    "Europe/Madrid",
    "Europe/Paris",
  ];
}

/**
 * The browser's own time zone.
 *
 * This is the zone the owner is actually in, so it is the sensible
 * default for a frame on their wall.
 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * A readable name for a time zone, such as "Berlin (Europe/Berlin)".
 */
export function timeZoneLabel(zone: string): string {
  const city = zone.split("/").pop()?.replace(/_/g, " ") ?? zone;
  return `${city} (${zone})`;
}
