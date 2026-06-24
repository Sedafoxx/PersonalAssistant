// Surface AI-generated improvement suggestions so you can decide what to build.
// The daily cron (/api/notifications/send) analyzes your journal, items, goals,
// and chat history and stores suggestions in Supabase. This prints them.
//
//   npm run suggestions              list new suggestions
//   npm run suggestions all          list everything except dismissed
//   npm run suggestions build  <id>  mark as being built
//   npm run suggestions done   <id>  mark as built
//   npm run suggestions dismiss <id> hide it
//   npm run suggestions generate     trigger a fresh analysis now (calls prod)
//
// <id> may be the full UUID or a unique prefix (first few chars shown in list).

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
  );
  process.exit(1);
}
const db = createClient(url, key);

const COLS = "id,title,category,rationale,evidence,status,created_at";
const [cmd = "list", arg] = process.argv.slice(2);

const CAT_TAG = {
  feature: "feat",
  ux: "ux",
  workflow: "flow",
  automation: "auto",
  content: "text",
};

function fmt(s, i) {
  const tag = CAT_TAG[s.category] ?? s.category;
  const lines = [
    `${String(i + 1).padStart(2)}. [${tag}] ${s.title}`,
    `    id: ${s.id.slice(0, 8)}   status: ${s.status}`,
  ];
  if (s.rationale) lines.push(`    why: ${s.rationale}`);
  if (s.evidence) lines.push(`    seen: ${s.evidence}`);
  return lines.join("\n");
}

async function list(all) {
  let q = db.from("suggestions").select(COLS).order("created_at", { ascending: false });
  q = all ? q.neq("status", "dismissed") : q.eq("status", "new");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  if (!data.length) {
    console.log(
      all
        ? "No suggestions yet. Run `npm run suggestions generate` or wait for the daily pass."
        : "No new suggestions. Try `npm run suggestions all` to see in-progress/built ones."
    );
    return;
  }
  console.log(`\n${data.length} suggestion(s)${all ? "" : " (new)"}:\n`);
  console.log(data.map(fmt).join("\n\n"));
  console.log("");
}

async function resolveId(prefix) {
  if (!prefix) throw new Error("Provide a suggestion id (or prefix).");
  const { data, error } = await db.from("suggestions").select("id,title");
  if (error) throw new Error(error.message);
  const hits = data.filter((s) => s.id.startsWith(prefix));
  if (hits.length === 0) throw new Error(`No suggestion id starts with "${prefix}".`);
  if (hits.length > 1)
    throw new Error(`Ambiguous prefix "${prefix}" matches ${hits.length} suggestions.`);
  return hits[0];
}

async function setStatus(prefix, status) {
  const hit = await resolveId(prefix);
  const { error } = await db
    .from("suggestions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", hit.id);
  if (error) throw new Error(error.message);
  console.log(`Marked "${hit.title}" as ${status}.`);
}

async function generate() {
  const base =
    process.env.APP_URL ?? "https://personal-assistant-two-pi.vercel.app";
  console.log(`Triggering analysis at ${base}/api/suggestions/generate ...`);
  const res = await fetch(`${base}/api/suggestions/generate`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  console.log(`Added ${body.added} new suggestion(s).`);
  if (body.added > 0) await list(false);
}

try {
  if (cmd === "list") await list(false);
  else if (cmd === "all") await list(true);
  else if (cmd === "build") await setStatus(arg, "building");
  else if (cmd === "done") await setStatus(arg, "done");
  else if (cmd === "dismiss") await setStatus(arg, "dismissed");
  else if (cmd === "generate") await generate();
  else {
    console.error(`Unknown command "${cmd}". Use: list | all | build | done | dismiss | generate`);
    process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
