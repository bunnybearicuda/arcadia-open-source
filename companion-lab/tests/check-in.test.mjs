import assert from "node:assert/strict";
import test from "node:test";
import { insideWindow, localDayAndHour } from "../lib/check-in-schedule.ts";

const TZ = "America/Chicago";
// Sunday-indexed windows matching a 4am shift: early on work days, later
// mornings on days off, later nights before them.
const WINDOWS = [
  { open: 8, close: 21 },
  { open: 4, close: 21 },
  { open: 4, close: 21 },
  { open: 4, close: 22 },
  { open: 8, close: 21 },
  { open: 4, close: 21 },
  { open: 4, close: 22 },
];
const settings = { windows: WINDOWS, timezone: TZ };

// Chicago is UTC-5 in August, so 10:00 UTC is 05:00 local.
function chicago(dateIso) {
  return new Date(dateIso);
}

test("reads the local weekday and hour in the configured timezone", () => {
  // 2026-08-03 is a Monday. 10:00Z = 05:00 Chicago.
  const { day, hour } = localDayAndHour(chicago("2026-08-03T10:00:00Z"), TZ);
  assert.equal(day, 1);
  assert.equal(hour, 5);
});

test("allows an early work-day check-in once the window opens", () => {
  // Monday 05:00 local — she is up and at work.
  assert.equal(insideWindow(chicago("2026-08-03T10:00:00Z"), settings), true);
});

test("never fires in the middle of the night", () => {
  // Monday 02:00 local.
  assert.equal(insideWindow(chicago("2026-08-03T07:00:00Z"), settings), false);
});

test("holds back on a day off until the later morning window", () => {
  // Thursday 2026-08-06 at 05:00 local — day off, still asleep.
  assert.equal(insideWindow(chicago("2026-08-06T10:00:00Z"), settings), false);
  // Thursday 09:00 local — awake.
  assert.equal(insideWindow(chicago("2026-08-06T14:00:00Z"), settings), true);
});

test("allows the later night before a day off but not on a work night", () => {
  // Wednesday 2026-08-05 at 21:30 local — Thursday is off.
  assert.equal(insideWindow(chicago("2026-08-06T02:30:00Z"), settings), true);
  // Monday 2026-08-03 at 21:30 local — work in the morning.
  assert.equal(insideWindow(chicago("2026-08-04T02:30:00Z"), settings), false);
});

test("Saturday night stays open late because Sunday is off", () => {
  // Saturday 2026-08-08 at 21:30 local.
  assert.equal(insideWindow(chicago("2026-08-09T02:30:00Z"), settings), true);
});
