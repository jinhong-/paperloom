/**
 * The names of the days of the week.
 *
 * The server and the browser both use `Date.getDay()`: 0 is Sunday.
 */

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The short names, for a row of day buttons. */
export const DAY_SHORT = ["S", "M", "T", "W", "T", "F", "S"] as const;
