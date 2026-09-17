import { listLoops, staleLoops, type OpenLoop } from "./loops";
import { listCommitments } from "./commitments";
import { latestReview, type ReviewObservation } from "./review";
import { daysUntil } from "./dates";

// --- the opening brief ------------------------------------------------------
//
// The state of the world, assembled for the first turn of a NEW chat. Not a
// model call: every line is a fact read straight from the database, so it is
// instant, free, and cannot invent anything.
//
// Two rules shape everything here.
//
// 1. Every read is best-effort. A section whose query fails is OMITTED, never
//    faked and never thrown — a broken loops table must not cost the user his
//    promises as well.
//
// 2. It reports; it does not advise. Each line is a fact with an AGE
//    ("waiting on you: leadership case (2 days)"), never a suggestion, never an
//    exhortation, never an emoji. The user acts in words — "close the visa
//    loop" — which the coach tools already support.
//
// The budget is deliberately small: at most ~12 lines and well under 700
// characters, however much data there is. A brief that has to be read is worse
// than no brief.

/** One thread waiting on the user, with how long it has been waiting. */
export interface BriefLoop {
  subject: string;
  thread: string;
  ageDays: number;
}

/** One open promise, with its due date and how far away it is (null when undated). */
export interface BriefPromise {
  text: string;
  due_date: string | null;
  days: number | null;
}

export interface DailyBrief {
  waitingOnYou: BriefLoop[];
  staleLoops: BriefLoop[];
  openLoops: number;
  promises: BriefPromise[];
  overdue: number;
  review: { ranAt: string; observations: ReviewObservation[] } | null;
  text: string;
  hasContent: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The read side of the brief: everything formatBriefText needs, and nothing else. */
export type BriefParts = Omit<DailyBrief, "text" | "hasContent">;

// --- arithmetic -------------------------------------------------------------

/**
 * Whole ELAPSED days since `from`, floored, and NEVER negative — a timestamp in
 * the future (a clock skew, a hand-written row) reads 0 rather than
 * "-1 days ago", because "in -1 days" is not a fact, it is a bug on screen.
 *
 * Measured against the real instant, not the calendar day: something touched two
 * hours ago is 0 days old, and the same call an hour later does not jump to 1.
 * Anchoring to local midnight instead would make every loop touched today read
 * 0 whichever way the day boundary runs, and — because the day here is the
 * LOGICAL day, which before 04:00 is yesterday — would read a timestamp from
 * this morning as a day old.
 *
 * `today` is the optional clock override: a YYYY-MM-DD name makes the age as of
 * local midnight that day, which is what a deterministic caller passing a
 * "today" wants.
 *
 * Returns 0 when `from` is missing or unparseable: an unknown age is not an
 * error worth losing a line over.
 */
export function briefAgeDays(from: string | null, today?: string): number {
  if (!from) return 0;
  const start = Date.parse(from);
  if (Number.isNaN(start)) return 0;

  let base = Date.now();
  if (today) {
    const [y, m, d] = today.split("-").map(Number);
    const named = new Date(y, (m ?? 1) - 1, d ?? 1).getTime();
    if (Number.isNaN(named)) return 0;
    base = named;
  }

  return Math.max(0, Math.floor((base - start) / MS_PER_DAY));
}

// --- assembly ---------------------------------------------------------------

/**
 * Build the brief. Never throws, and never writes: every section is read
 * independently so one failure costs only its own lines.
 */
export async function buildDailyBrief(): Promise<DailyBrief> {
  const loops: OpenLoop[] = await listLoops({ limit: 200 }).catch(() => []);

  // Waiting-on-you is a read of its own rather than a filter over the list
  // above, so a truncated `listLoops` cannot silently hide a thread the user
  // owes a reply to. The two are merged and de-duplicated by id.
  const waitingRead: OpenLoop[] = await listLoops({
    state: "waiting",
    limit: 50,
  }).catch(() => []);

  const byId = new Map<string, OpenLoop>();
  for (const loop of [...loops, ...waitingRead]) byId.set(loop.id, loop);
  const all = [...byId.values()];
  const live = all.filter((loop) => loop.state !== "done");
  const waitingOnYou = live
    .filter((loop) => loop.state === "waiting" && loop.waiting_on === "you")
    .map((loop) => ({
      subject: loop.subject,
      thread: loop.thread,
      ageDays: briefAgeDays(loop.last_touched_at),
    }))
    .sort((a, b) => b.ageDays - a.ageDays);

  const stale: OpenLoop[] = await staleLoops().catch(() => []);
  const staleLoopsOut = stale
    .filter((loop) => loop.waiting_on !== "you")
    .map((loop) => ({
      subject: loop.subject,
      thread: loop.thread,
      ageDays: briefAgeDays(loop.last_touched_at),
    }))
    .sort((a, b) => b.ageDays - a.ageDays);

  const openCommitments = await listCommitments({ status: "open", limit: 100 }).catch(
    () => []
  );
  const promises: BriefPromise[] = openCommitments
    .map((c) => ({
      text: c.text,
      due_date: c.due_date,
      days: c.due_date ? daysUntil(c.due_date) : null,
    }))
    .sort((a, b) => (a.days ?? Number.MAX_SAFE_INTEGER) - (b.days ?? Number.MAX_SAFE_INTEGER));

  const review = await latestReview().catch(() => null);

  const parts: BriefParts = {
    waitingOnYou,
    staleLoops: staleLoopsOut,
    openLoops: live.length,
    promises,
    overdue: promises.filter((p) => p.days !== null && p.days < 0).length,
    review: review
      ? { ranAt: review.ranAt, observations: review.observations }
      : null,
  };

  // The text is rendered HERE, not left blank for the caller to fill in.
  //
  // Returning `text: ""` with `hasContent: false` was a trap: reading
  // `brief.text` is the obvious thing for a caller to do, and it produced an
  // empty greeting. Worse, the test that read it that way "passed" its length
  // budget check vacuously, with zero characters and zero lines — a green light
  // that proved nothing. A function that returns "a brief" returns a brief;
  // formatBriefText stays exported for callers that want pure rendering over
  // parts they built themselves.
  const text = formatBriefText(parts);
  return { ...parts, text, hasContent: text.length > 0 };
}

// --- formatting -------------------------------------------------------------

/** About twelve lines is the budget; past that the brief is a report, not a brief. */
const MAX_LINES = 12;
/** Hard ceiling on the rendered block, whatever the data. */
const MAX_CHARS = 700;
const MAX_PROMISES = 6;
const MAX_PER_SECTION = 4;
/** One line carries a few names, not a list of twenty. */
const MAX_NAMES_PER_LINE = 3;

// A line's own sentence, with any newline flattened: one brief line must never
// become two lines of screen.
function oneLine(value: string): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// "2 days" / "1 day" / "today" — an age, never advice.
function ageLabel(days: number): string {
  if (days <= 0) return "today";
  return `${days} day${days === 1 ? "" : "s"}`;
}

// A review observation is authoritative prose; keep the topic, cap the rest.
function observationLine(o: ReviewObservation): string {
  const text = `${o.topic ? `${o.topic} — ` : ""}${o.text}`;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

// Compress a group of facts sharing a shape into as few lines as possible, so
// the twelve-line budget is spent on KINDS of fact first and overflow second.
function groupedLines(
  entries: { label: string; age: number }[],
  prefix: string
): string[] {
  const out: string[] = [];
  for (let i = 0; i < entries.length && out.length < MAX_PER_SECTION; i += MAX_NAMES_PER_LINE) {
    const group = entries.slice(i, i + MAX_NAMES_PER_LINE);
    // The group's age is its oldest member: a line is at least as old as the
    // oldest thread named on it.
    const age = group.reduce((max, e) => Math.max(max, e.age), 0);
    const more = entries.length > MAX_NAMES_PER_LINE ? "+" : "";
    out.push(
      `${prefix}: ${group.map((e) => e.label).join(", ")} (${ageLabel(age)})${more}`
    );
  }
  return out;
}

/**
 * Render the brief as a SHORT plain block, ordered by urgency: overdue promises
 * first, then threads waiting on the user, then stale loops, then last night's
 * review findings. "" when there is nothing to report — a quiet day must not be
 * greeted with an empty checklist.
 *
 * Pure: same parts in, same text out, no clock and no I/O.
 */
export function formatBriefText(parts: BriefParts): string {
  const lines: string[] = [];

  // 1. Overdue promises. The one category where a date has already passed, so
  //    it goes first; undated promises follow on the same numbered line.
  const overdue = parts.promises.filter((p) => p.days !== null && p.days < 0);
  for (const p of overdue.slice(0, MAX_PER_SECTION)) {
    const days = Math.abs(p.days ?? 0);
    lines.push(`- overdue promise: ${oneLine(p.text)} (${ageLabel(days)})`);
  }

  const dated = parts.promises.filter((p) => p.days !== null && p.days >= 0);
  for (const p of dated.slice(0, MAX_PROMISES - overdue.length)) {
    const due = (p.days ?? 0) === 0 ? "due today" : `due in ${ageLabel(p.days ?? 0)}`;
    lines.push(`- promise: ${oneLine(p.text)} (${due})`);
  }

  // 2. Threads waiting on the user.
  lines.push(
    ...groupedLines(
      parts.waitingOnYou.map((l) => ({ label: oneLine(l.thread), age: l.ageDays })),
      "waiting on you"
    )
  );

  // 3. Loops gone quiet.
  lines.push(
    ...groupedLines(
      parts.staleLoops.map((l) => ({ label: oneLine(l.thread), age: l.ageDays })),
      "quiet loop"
    )
  );

  // 4. Last night's findings, last because they are the least actionable.
  if (parts.review && parts.review.observations.length > 0) {
    for (const o of parts.review.observations.slice(0, 2)) {
      lines.push(`- last night: ${observationLine(o)}`);
    }
  }

  // The budget holds whatever the data: trim to the line cap, then to the
  // character cap on a line boundary so a line is never cut mid-fact.
  const capped = lines.slice(0, MAX_LINES);
  const kept: string[] = [];
  let used = 0;
  for (const line of capped) {
    if (kept.length > 0 && used + line.length + 1 > MAX_CHARS) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join("\n");
}
