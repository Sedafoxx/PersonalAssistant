import { createServiceClient } from "./supabase";
import { getTopics, getActiveFacts } from "./memory";

// --- open loops -------------------------------------------------------------
//
// One thread per person or project, with a state we can MOVE (open → waiting →
// done) instead of a memory fact that only ever holds a single value. A memory
// topic called "Open Loops" already holds four facts as prose; this module
// turns them into real rows so a thread can be listed, aged and closed.

const COLS =
  "id,subject,thread,state,waiting_on,detail,due_date,kind,next_step,last_touched_at,created_at,updated_at";

export type LoopState = "open" | "waiting" | "done";
export type WaitingOn = "you" | "them" | null;
/**
 * What the thread is ABOUT. A coach plans against people and projects; `topic` is
 * the honest default for a thread that is neither (and for the rows that existed
 * before this was recorded).
 */
export type LoopKind = "person" | "project" | "topic";

export interface OpenLoop {
  id: string;
  subject: string;
  thread: string;
  state: LoopState;
  waiting_on: WaitingOn;
  detail: string | null;
  due_date: string | null;
  kind: LoopKind;
  /** The ONE next concrete move. A thread with a state but no next step is a note. */
  next_step: string | null;
  last_touched_at: string;
  created_at: string;
  updated_at: string;
}

function isDayString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

export async function listLoops(opts?: {
  subject?: string;
  state?: string;
  limit?: number;
}): Promise<OpenLoop[]> {
  try {
    const db = createServiceClient();
    let q = db.from("open_loops").select(COLS);
    if (opts?.state) q = q.eq("state", opts.state);
    if (opts?.subject) q = q.ilike("subject", `%${opts.subject.trim()}%`);
    q = q
      .order("last_touched_at", { ascending: false })
      .limit(opts?.limit ?? 50);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []) as OpenLoop[];
  } catch {
    return [];
  }
}

export async function getLoop(id: string): Promise<OpenLoop | null> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("open_loops")
    .select(COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as OpenLoop) ?? null;
}

// Create or update the thread identified by (subject, thread). The unique
// partial index on the normalized pair is what makes this an upsert rather than
// a way to pile up duplicate threads: writing the same subject+thread again
// UPDATES the live row.
export async function upsertLoop(input: {
  subject: string;
  thread: string;
  state?: LoopState;
  waiting_on?: WaitingOn;
  detail?: string;
  due_date?: string | null;
  kind?: LoopKind;
  next_step?: string | null;
}): Promise<OpenLoop> {
  const subject = input.subject.trim();
  const thread = input.thread.trim();
  if (!subject || !thread) {
    throw new Error("An open loop needs a subject and a thread.");
  }

  const db = createServiceClient();
  const now = new Date().toISOString();

  const { data: existing, error: readErr } = await db
    .from("open_loops")
    .select(COLS)
    .eq("subject_norm", subject.toLowerCase())
    .eq("thread_norm", thread.toLowerCase())
    .neq("state", "done")
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);

  if (existing) {
    const patch: Record<string, unknown> = {
      last_touched_at: now,
      updated_at: now,
    };
    if (input.state !== undefined) patch.state = input.state;
    if (input.waiting_on !== undefined) patch.waiting_on = input.waiting_on;
    if (input.detail !== undefined) patch.detail = input.detail.trim() || null;
    if (input.due_date !== undefined)
      patch.due_date = isDayString(input.due_date) ? input.due_date : null;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.next_step !== undefined)
      patch.next_step = input.next_step?.trim() || null;

    const { data, error } = await db
      .from("open_loops")
      .update(patch)
      .eq("id", (existing as OpenLoop).id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as OpenLoop;
  }

  const { data, error } = await db
    .from("open_loops")
    .insert({
      subject,
      thread,
      state: input.state ?? "open",
      waiting_on: input.waiting_on ?? null,
      detail: input.detail?.trim() || null,
      due_date: isDayString(input.due_date) ? input.due_date : null,
      kind: input.kind ?? "topic",
      next_step: input.next_step?.trim() || null,
      last_touched_at: now,
    })
    .select(COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as OpenLoop;
}

// Move a thread's state. Used by the coach and by the loop card's one action.
export async function setLoopState(
  id: string,
  state: LoopState,
  waiting_on?: WaitingOn
): Promise<void> {
  const db = createServiceClient();
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    state,
    last_touched_at: now,
    updated_at: now,
  };
  // Waiting only makes sense while the loop is waiting; leaving it set on a
  // done row would misrepresent who owes the next move.
  if (waiting_on !== undefined) patch.waiting_on = waiting_on;
  else if (state === "done") patch.waiting_on = null;

  const { error } = await db.from("open_loops").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

// Loops that have not been touched in `days` (default 14) and are not done —
// the ones quietly going stale.
export async function staleLoops(days = 14): Promise<OpenLoop[]> {
  try {
    const db = createServiceClient();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("open_loops")
      .select(COLS)
      .neq("state", "done")
      .lt("last_touched_at", cutoff)
      .order("last_touched_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as OpenLoop[];
  } catch {
    return [];
  }
}

// Turn the "Open Loops" memory topic's active facts into real rows. Seeds ONLY
// when the table is empty, so it is a no-op on every later run and can never
// overwrite a thread the user has since moved by hand. Returns how many loops
// were created (0 when it was a no-op).
export async function seedLoopsFromMemory(): Promise<number> {
  try {
    const db = createServiceClient();
    const { count, error: countErr } = await db
      .from("open_loops")
      .select("id", { count: "exact", head: true });
    if (countErr) throw new Error(countErr.message);
    if ((count ?? 0) > 0) return 0;

    const topics = await getTopics();
    const needle = "open loops";
    const topic =
      topics.find((t) => t.title.toLowerCase().trim() === needle) ??
      topics.find((t) => t.slug === "open-loops") ??
      topics.find((t) => t.title.toLowerCase().includes("loop"));
    if (!topic) return 0;

    const facts = await getActiveFacts(topic.id);
    if (!facts.length) return 0;

    let created = 0;
    // One loop per fact. The fact's key is the subject (a person or project)
    // and its value is the thread — the same shape the four existing facts use.
    for (const fact of facts) {
      try {
        const { data: exists } = await db
          .from("open_loops")
          .select("id")
          .eq("subject_norm", fact.key.toLowerCase())
          .eq("thread_norm", fact.value.toLowerCase())
          .neq("state", "done")
          .maybeSingle();
        if (exists) continue;
        await upsertLoop({
          subject: fact.key,
          thread: fact.value,
          state: "open",
          detail: fact.value,
        });
        created++;
      } catch {
        // non-fatal: one bad fact must not stop the seed
      }
    }
    return created;
  } catch {
    return 0;
  }
}
