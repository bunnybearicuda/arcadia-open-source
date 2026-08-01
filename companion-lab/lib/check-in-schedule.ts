// Pure scheduling rules for companion check-ins, kept free of platform
// imports so they can be unit tested directly.

// Sunday-indexed. Defaults follow a 4am shift: early starts on work days,
// later mornings on days off, and later nights before them.
export const DEFAULT_WINDOWS: Array<{ open: number; close: number }> = [
  { open: 8, close: 21 }, // Sunday — day off
  { open: 4, close: 21 }, // Monday
  { open: 4, close: 21 }, // Tuesday
  { open: 4, close: 22 }, // Wednesday — Thursday off, later night
  { open: 8, close: 21 }, // Thursday — day off
  { open: 4, close: 21 }, // Friday
  { open: 4, close: 22 }, // Saturday — Sunday off, later night
];

export type CheckInWindow = { open: number; close: number };

// Local wall-clock day and hour in the configured timezone, without pulling in
// a date library.
export function localDayAndHour(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value || "Sun";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const index = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  return { day: index < 0 ? 0 : index, hour: hour === 24 ? 0 : hour };
}

export function insideWindow(
  now: Date,
  settings: { windows: CheckInWindow[]; timezone: string },
) {
  const { day, hour } = localDayAndHour(now, settings.timezone);
  const window = settings.windows[day] || { open: 9, close: 21 };
  return hour >= window.open && hour < window.close;
}

