// Pure, client-safe date helpers for the "Until When" countdown.
//
// This module must never import anything from the server (no Supabase), since
// it is imported by client components. It only does calendar-day arithmetic.

// Builds a local-midnight Date from a `YYYY-MM-DD` string, or null when the
// input isn't a plain calendar day. Parsing the parts by hand (rather than
// `new Date("YYYY-MM-DD")`, which is UTC) keeps the day in the user's zone.
function parseLocalDay(value: string | null | undefined): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  // Reject rollovers like 2026-02-31 → Mar 3, which would silently lie.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

// The local calendar day of an arbitrary Date, as local midnight.
function startOfLocalDay(from: Date): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate());
}

// Whole calendar days between two local-midnight Dates. DST-safe because both
// operands are anchored to local midnight; round() absorbs the off-by-hour that
// a 23- or 25-hour day introduces.
function calendarDiffDays(from: Date, to: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

// Days until `due`, in LOCAL calendar days: 0 today, positive future, negative
// overdue, null for a missing or invalid date. A task due tomorrow reads 1 even
// at 23:30 because the comparison is on calendar days, not raw milliseconds.
export function daysUntil(due: string | null, from?: Date): number | null {
  const target = parseLocalDay(due);
  if (!target) return null;
  const base = startOfLocalDay(from ?? new Date());
  return calendarDiffDays(base, target);
}

// Human countdown for a due date. Returns null when there is no valid date.
export function countdownLabel(due: string | null, from?: Date): string | null {
  const days = daysUntil(due, from);
  if (days === null) return null;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days > 1) return `Due in ${days} days`;
  if (days === -1) return "1 day overdue";
  return `${Math.abs(days)} days overdue`;
}

// True when a deadline is overdue, today, or within `withinDays` (default 2).
// An invalid/absent date is never "due soon".
export function isDueSoon(
  due: string | null,
  withinDays = 2,
  from?: Date
): boolean {
  const days = daysUntil(due, from);
  if (days === null) return false;
  return days <= withinDays;
}

// The user's LOCAL calendar day as YYYY-MM-DD (Europe/Vienna).
//
// This is the SINGLE definition of "today" for the whole app. It used to exist
// three times with three different answers: day.ts anchored to Vienna, coach.ts
// used getTimezoneOffset() (which is UTC on a Vercel server), and reflection.ts
// sliced a UTC ISO string. Between 22:00 and 24:00 UTC that is 00:00-02:00 in
// Vienna, so the coach's "today" and the Today window's "today" were different
// days and a late-evening check-in was filed under yesterday. Formatting in the
// target zone is what makes the day boundary correct regardless of where the
// server runs or how the browser's clock is set.
export function todayLocal(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** The zone every day boundary in this app is anchored to. */
const TZ = "Europe/Vienna";

/**
 * The hour at which a new day starts, locally.
 *
 * Someone who is up at 1am reflecting on "today" means the day that just ended,
 * not the one the calendar has already flipped to. Treating the small hours as
 * the previous day is what stops a late reflection from being filed against
 * tomorrow and leaving today's streak empty. Four is late enough for a real night
 * owl and early enough that it never touches a normal morning.
 */
export const DAY_START_HOUR = 4;

/** The user's LOCAL hour (0-23) in {@link TZ}. */
function localHour(date: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(date)
  );
}

/**
 * The day the user is LIVING, as YYYY-MM-DD — the one day function the whole app
 * should use.
 *
 * Before {@link DAY_START_HOUR} this is the PREVIOUS calendar day: at 01:00 on
 * the 16th the user is still finishing the 15th, so their reflection, their mood
 * and their "today" all belong to the 15th. Use this wherever a day is recorded.
 * `todayLocal()` remains for the rare place a true calendar date is meant (a due
 * date, for instance).
 *
 * It exists because the app used to have several different answers to "what day
 * is it": a UTC slice, the server's own zone, and the browser's. That is how a
 * reflection written at 00:30 got filed on the wrong day and why a late evening
 * reflection "would not let me reflect for the day before".
 */
export function logicalDay(date: Date = new Date()): string {
  const calendar = todayLocal(date);
  if (localHour(date) >= DAY_START_HOUR) return calendar;

  const [y, m, d] = calendar.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d));
  prev.setUTCDate(prev.getUTCDate() - 1);
  return prev.toISOString().slice(0, 10);
}
