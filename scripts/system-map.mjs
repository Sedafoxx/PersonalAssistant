#!/usr/bin/env node
// Generates plans/system-map.html — one page showing what Nova IS: the flows
// that run, the pieces that exist, and what is still missing.
//
// WHY A GENERATOR AND NOT A DRAWING: a hand-drawn diagram is correct on the day
// it is drawn and a lie a month later, and this system has changed its shape
// every single session (a tab removed, a store retired, a gate that turned out to
// have been dead for months). So the structure is DERIVED — routes from the
// filesystem, crons from vercel.json, tables from the migrations, row counts from
// the live database, tests from the scripts — and only the two things a machine
// cannot know are hand-written: what each flow MEANS, and what is still open.
//
// It lives in plans/ (gitignored) on purpose: it shows your own row counts.
//
// Run: npm run map
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createClient } from "@supabase/supabase-js";

const ROOT = process.cwd();
const OUT = join(ROOT, "plans", "system-map.html");

// --- small fs helpers -------------------------------------------------------
const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const walk = (dir, filter, out = []) => {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".next", ".git"].includes(e.name)) continue;
      walk(p, filter, out);
    } else if (filter(e.name)) {
      out.push(p);
    }
  }
  return out;
};
const rel = (p) => relative(ROOT, p).split(sep).join("/");
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");

/**
 * The file's own description: its leading comment block when it has one, else the
 * first comment line anywhere near the top.
 *
 * The first version of this only looked at the LEADING block and then dropped
 * every file that had none — which silently cut the library list from ~30 files
 * to 8, because most of them start with an `import`. A map that quietly omits two
 * thirds of the substance is worse than no map: it looks complete.
 */
function firstComment(file) {
  const lines = read(file).split("\n");
  const clean = (s) => s.replace(/^\/\/\s?/, "").replace(/^\/\*+\s?/, "").replace(/\*\/$/, "").trim();
  const block = (from, to) => {
    const out = [];
    for (let i = from; i < to; i++) {
      const t = lines[i].trim();
      if (!t) {
        if (out.length) break;
        continue;
      }
      if (t.startsWith("//") || (out.length && t.startsWith("*"))) {
        out.push(clean(t));
        if (out.join(" ").length > 160) break;
        continue;
      }
      if (t.startsWith("/*")) {
        out.push(clean(t));
        continue;
      }
      break;
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  };

  // 1. the leading block (only when the file actually opens with a comment)
  const head = block(0, Math.min(lines.length, 40));
  if (head) return head.length > 170 ? `${head.slice(0, 167)}…` : head;

  // 2. otherwise the first comment line in the top of the file
  for (const line of lines.slice(0, 60)) {
    const t = line.trim();
    if (t.startsWith("//") && !/^\/\/\s*[-=]+$/.test(t)) {
      const one = clean(t);
      if (one.length > 20) return one.length > 170 ? `${one.slice(0, 167)}…` : one;
    }
  }
  return "";
}

// --- hand-written: what each flow MEANS -------------------------------------
// These are the parts a machine cannot derive: the intent behind the wiring.
const FLOWS = [
  {
    name: "A chat turn",
    when: "you type or talk",
    steps: [
      "chat route reads the thread (+ the legacy coach thread)",
      "retrieval picks facts for THIS intent, pinned constraints always",
      "context assembled: day, goals, threads, promises, backlog, memory",
      "model + 44 tools (search, capture, calendar, code, memory…)",
      "reply streamed to you",
      "the turn is logged, then facts are extracted (constraints pinned)",
    ],
    why: "Everything Nova can do happens here. The context is the whole game: the 2026-09-20 kitchen failure was a fact that existed but was not in front of her.",
  },
  {
    name: "Feed refresh",
    when: "07:00, or the button",
    steps: [
      "derived interests (what fits you) → search phrases",
      "sources: Tavily articles + YouTube, Spotify/iTunes podcasts, HN, arXiv, Bluesky",
      "links validated, dead ones dropped, the rest stored",
      "the model scores each item against your goals (fit, not volume)",
      "page at 3+, mixed across kinds; top up when you reach the bottom",
    ],
    why: "Built for a 3+ bar: an empty day is an honest answer. Ingest does NOT word-filter (P5) — the ranker's judgement decides.",
  },
  {
    name: "Morning push",
    when: "08:00",
    steps: [
      "resolution sweep: yesterday's finished todos are put away",
      "due reminders fire",
      "journal nudge if nothing is logged",
      "ONE memory check: said-but-never-recorded, waiting on you, stale facts, last night's review",
      "suggestions pass (findings → change_requests)",
    ],
    why: "The morning is bounded to one memory buzz on purpose: two pushes saying different things is noise.",
  },
  {
    name: "Evening",
    when: "20:00, or when you reflect",
    steps: [
      "reflection nudge opens the chat with an opener pre-filled",
      "you talk; save_reflection writes the reflection, the mood, the habits",
      "the evening check-in row is written from the conversation",
      "wins computed for the day (now shown in Stats)",
    ],
    why: "Reflection is a conversation, never a form — the tabs that asked for it were deleted for that reason.",
  },
  {
    name: "Nightly review",
    when: "02:00",
    steps: [
      "read last night's window: memory + record",
      "look for contradictions and things gone stale",
      "write ONE review row: what it noticed",
      "reported in the morning push; changes nothing on its own",
    ],
    why: "It reports, it never edits. A reviewer that also acts is a reviewer you cannot audit.",
  },
  {
    name: "Weekly goal review",
    when: "Sun 17:00",
    steps: [
      "goals that have not moved",
      "push with the prompt, tap → chat opener pre-filled",
      "conversation does the work (plan, milestone, next action)",
    ],
    why: "The Coach tab that used to own this is gone; a goal review is a conversation, not a screen.",
  },
  {
    name: "Todo lifecycle",
    when: "continuous",
    steps: [
      "planned for a day (Today tab or via chat)",
      "done → crossed out, same day, still visible and un-tickable",
      "the next morning: resolved (resolved_at) and out of the list",
      "history survives: trends, milestone roll-up, stats",
    ],
    why: "The original bug: finished todos piled up forever. Resolution is a THIRD state, not archive — archiving would have erased the roll-up and the metrics.",
  },
];

// --- hand-written: what is still open ---------------------------------------
const OPEN = [
  ["Idea triage", "32 ideas, all `active`. No someday/dropped state, so 'suggest working on an idea' has nothing to work from. Needs a lifecycle, then the backlog path can offer one."],
  ["Tasks → goal automatically", "11 goals, 10 milestones on only 5 of them; 12 of 35 active todos carry a goal. Goal always (best-effort by meaning), milestone only where the goal has one. Also merge the duplicate reflection goals (EN + DE)."],
  ["Mood → task choice", "Mood reaches the TONE today, not the choice. Choosing by mood needs a size hint on items; the cheap version is a prompt rule (mood low → smallest step)."],
  ["Notification channel", "Push works. WhatsApp needs a Meta business portfolio and per-message templates for business-initiated messages; Telegram is free and instant. Your call, then a small adapter."],
  ["Chat review workflow", "Designed, not built: flag conversations by repeat corrections, review only those, write into change_requests, allowed to find nothing. See plans/chat-review-workflow.md."],
  ["Stale-fact re-confirmation", "staleFacts() is called only by a test. Facts are labelled 'ask, do not assert' but nothing ever asks you to re-confirm one."],
  ["Notebook usability", "63 topics / 631 facts render as one wall in Stats. No search, no collapse."],
  ["Feed learns from memory", "retrieveMemory is not wired into the interest derivation: the feed learns from goals, feedback and the journal, not from what Nova knows."],
  ["42 Apple-era podcast rows have no text", "The bulk episode endpoint 403s for a Development-mode app; descriptions are backfilled by search where possible."],
  ["Kindergarten-sized leftovers", "Nothing left over from the day's plan since the resolution sweep; keep an eye on the pass rate in the morning push report."],
];

// --- derive: routes ---------------------------------------------------------
function routes() {
  const files = walk(join(ROOT, "src", "app", "api"), (n) => n === "route.ts");
  return files
    .map((f) => {
      const dir = f.replace(/[\\/]route\.ts$/, "");
      const url = `/${rel(dir)}`.replace("src/app/", "");
      const text = read(f);
      const methods = [...text.matchAll(/export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE)/g)].map(
        (m) => m[1]
      );
      return {
        url: url.replace(/\[([^\]]+)\]/g, ":$1"),
        group: url.split("/")[2] ?? "root",
        methods: methods.length ? methods.join(" ") : "?",
      };
    })
    .sort((a, b) => a.url.localeCompare(b.url));
}

// --- derive: migrations, and the tables they create -------------------------
function migrations() {
  const dir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const tables = new Set();
  const list = files.map((f) => {
    const text = read(join(dir, f));
    for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_]+)/gi)) {
      tables.add(m[1]);
    }
    const comment = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("--"))
      .map((l) => l.replace(/^--\s?/, ""))
      .filter((l) => l && !/^[=-]+$/.test(l))[0];
    const [num, ...slug] = f.replace(/\.sql$/, "").split("_");
    return { n: Number(num), name: slug.join(" "), what: comment ?? "" };
  });
  return { list, tables: [...tables].sort() };
}

// --- derive: crons ----------------------------------------------------------
const CRON_LABEL = {
  "/api/notifications/send": "morning push",
  "/api/notifications/send/evening": "evening nudge",
  "/api/notifications/send/goal-review": "weekly goal review",
  "/api/feed/refresh": "feed refresh",
  "/api/review": "nightly review",
};
function crons() {
  try {
    const cfg = JSON.parse(read(join(ROOT, "vercel.json")));
    return (cfg.crons ?? []).map((c) => ({
      path: c.path,
      schedule: c.schedule,
      label: CRON_LABEL[c.path] ?? "",
    }));
  } catch {
    return [];
  }
}

// --- derive: libs, components, tabs ----------------------------------------
function libs() {
  const dir = join(ROOT, "src", "lib");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => ({ name: f, what: firstComment(join(dir, f)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function panels() {
  return walk(join(ROOT, "src", "components"), (n) => n.endsWith(".tsx")).map((f) => ({
    name: rel(f).replace("src/components/", ""),
    what: firstComment(f),
  }));
}
function tabs() {
  const text = read(join(ROOT, "src", "app", "page.tsx"));
  const m = text.match(/const TABS:\s*Tab\[\]\s*=\s*\[([^\]]+)\]/);
  return m ? m[1].split(",").map((t) => t.trim().replace(/"/g, "")).filter(Boolean) : [];
}

// --- derive: tests, and their tier -----------------------------------------
// Mirrors scripts/test-all.mjs. Cheap = no model call.
const CHEAP = new Set(["todo-lifecycle-test.ts", "search-rank-test.ts", "memory-retrieval-test.ts"]);
function tests() {
  const files = readdirSync(join(ROOT, "scripts"))
    .filter((f) => f.endsWith("-test.ts") || f === "alexa-smoke.ts")
    .sort();
  let last = {};
  try {
    last = JSON.parse(read(join(ROOT, "plans", "test-status.json")));
  } catch {
    last = {};
  }
  return files.map((f) => ({
    name: f,
    tier: CHEAP.has(f) ? "cheap" : "llm",
    what: firstComment(join(ROOT, "scripts", f)),
    status: last[f] ?? null,
  }));
}

// --- derive: row counts ----------------------------------------------------
async function counts(tables) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return {};
  const db = createClient(url, key);
  const out = {};
  for (const t of tables) {
    try {
      const { count, error } = await db.from(t).select("*", { count: "exact", head: true });
      out[t] = error ? "?" : count;
    } catch {
      out[t] = "?";
    }
  }
  return out;
}

// --- render -----------------------------------------------------------------
function card(title, sub, body, cls = "") {
  return `<section class="card ${cls}">
  <h2>${esc(title)}${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</h2>
  ${body}
</section>`;
}

async function main() {
  const r = routes();
  const { list: migs, tables } = migrations();
  const cronList = crons();
  const libList = libs();
  const panelList = panels();
  const tabList = tabs();
  const testList = tests();
  const rows = await counts(tables);

  const byGroup = new Map();
  for (const route of r) {
    const g = byGroup.get(route.group) ?? [];
    g.push(route);
    byGroup.set(route.group, g);
  }

  const flowsHtml = FLOWS.map(
    (f) => `<div class="flow">
      <div class="flowhead"><strong>${esc(f.name)}</strong><span class="when">${esc(f.when)}</span></div>
      <ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      <p class="why">${esc(f.why)}</p>
    </div>`
  ).join("");

  const routesHtml = [...byGroup.entries()]
    .map(
      ([g, list]) =>
        `<div class="grp"><h3>${esc(g)}</h3>` +
        list.map((x) => `<div class="row"><code>${esc(x.url)}</code><span>${esc(x.methods)}</span></div>`).join("") +
        `</div>`
    )
    .join("");

  const tablesHtml = tables
    .map((t) => `<div class="row"><code>${esc(t)}</code><span>${rows[t] ?? "?"}</span></div>`)
    .join("");

  const migsHtml = migs
    .map(
      (m) =>
        `<div class="row wide"><code>${String(m.n).padStart(4, "0")}</code><span>${esc(m.what || m.name)}</span></div>`
    )
    .join("");

  const testsHtml = testList
    .map(
      (t) =>
        `<div class="row wide"><code class="${t.tier === "cheap" ? "cheap" : "llm"}">${t.tier}</code>` +
        `<span><strong>${esc(t.name)}</strong>${t.status ? ` <em>${esc(t.status)}</em>` : ""}<br>${esc(t.what)}</span></div>`
    )
    .join("");

  const openHtml = OPEN.map(
    ([name, why]) => `<div class="open"><strong>${esc(name)}</strong><span>${esc(why)}</span></div>`
  ).join("");

  const cheapCount = testList.filter((t) => t.tier === "cheap").length;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Nova — system map</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0d0d0d; color:#e5e7eb;
    font: 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  header { padding:14px 18px 10px; border-bottom:1px solid rgba(255,255,255,.08); }
  h1 { font-size:15px; margin:0; }
  h1 span { color:#9ca3af; font-weight:400; }
  .legend { color:#8b8f98; font-size:11px; margin-top:4px; }
  .kpis { display:flex; gap:14px; flex-wrap:wrap; margin-top:8px; font-size:11px; color:#a1a1aa; }
  .kpis b { color:#c7d2fe; }
  main { padding:14px 18px 40px; display:grid; gap:12px;
    grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); }
  .card { background:#161616; border:1px solid rgba(255,255,255,.08); border-radius:10px; padding:12px; }
  .card h2 { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#9ca3af;
    margin:0 0 8px; display:flex; justify-content:space-between; }
  .sub { text-transform:none; letter-spacing:0; color:#6b7280; }
  .wide { grid-column: span 2; }
  .flow { border-top:1px solid rgba(255,255,255,.06); padding-top:8px; margin-top:8px; }
  .flow:first-child { border-top:0; margin-top:0; padding-top:0 }
  .flowhead { display:flex; justify-content:space-between; gap:8px; }
  .when { color:#6b7280; font-size:11px; }
  ol { margin:4px 0 4px 16px; padding:0; }
  li { margin:1px 0; }
  .why { color:#8b8f98; margin:4px 0 0; font-size:11px; }
  .grp { margin-bottom:8px; }
  h3 { font-size:11px; color:#a5b4fc; margin:6px 0 2px; }
  .row { display:flex; justify-content:space-between; gap:8px; padding:1px 0; }
  .row span { color:#a1a1aa; text-align:right; }
  .row.wide span { text-align:left; }
  .row.wide { align-items:flex-start; }
  code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; color:#d1d5db; }
  code.cheap { color:#86efac; } code.llm { color:#fcd34d; }
  em { color:#6b7280; font-style:normal; }
  .open { border-top:1px solid rgba(255,255,255,.06); padding-top:6px; margin-top:6px; display:block; }
  .open:first-child { border-top:0; margin-top:0; padding-top:0 }
  .open span { color:#a1a1aa; display:block; }
  footer { padding:0 18px 24px; color:#6b7280; font-size:11px; }
</style></head>
<body>
<header>
  <h1>Nova <span>— what exists, how it flows, what is missing</span></h1>
  <div class="legend">Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from the repository and the live database. Regenerate with <code>npm run map</code>.</div>
  <div class="kpis">
    <span><b>${tabList.length}</b> tabs</span>
    <span><b>${r.length}</b> API routes</span>
    <span><b>${FLOWS.length}</b> flows</span>
    <span><b>${cronList.length}</b> crons</span>
    <span><b>${tables.length}</b> tables</span>
    <span><b>${migs.length}</b> migrations</span>
    <span><b>${testList.length}</b> test scripts (${cheapCount} cheap, ${testList.length - cheapCount} model-touching)</span>
    <span><b>${Object.values(rows).filter((v) => typeof v === "number").reduce((a, b) => a + b, 0)}</b> rows across tables</span>
  </div>
</header>
<main>
  ${card("How it runs", "the flows, in order of how often they happen", flowsHtml, "wide")}
  ${card("Tabs", "what you can open", `<div class="row wide"><span>${tabList.map(esc).join(" · ") || "?"}</span></div>`)}
  ${card("Crons", "scheduled in vercel.json", cronList.map((c) => `<div class="row wide"><code>${esc(c.schedule)}</code><span>${esc(c.label)} — ${esc(c.path)}</span></div>`).join(""))}
  ${card("Data stores", "tables from the migrations, with live row counts", tablesHtml, "wide")}
  ${card("API routes", "grouped by area, with HTTP methods", routesHtml, "wide")}
  ${card("Migrations", "the capability timeline — each one is a thing added", migsHtml, "wide")}
  ${card("Tests", "cheap = no model call, llm = real calls; status from the last run", testsHtml, "wide")}
  ${card("Libraries", "src/lib — the substance", libList.map((l) => `<div class="row wide"><code>${esc(l.name)}</code><span>${esc(l.what)}</span></div>`).join(""), "wide")}
  ${card("Screens", "src/components", panelList.map((p) => `<div class="row wide"><code>${esc(p.name)}</code><span>${esc(p.what)}</span></div>`).join(""), "wide")}
  ${card("What is open", "known gaps, newest thinking first", openHtml, "wide")}
</main>
<footer>
  Structure is derived (routes, crons, tables, counts, tests); the flow explanations and the open list are hand-written in scripts/system-map.mjs — those are the parts a machine cannot know.<br>
  Test status appears here after a run: <code>npm run test:fast</code> or <code>npm run test:all</code>.
</footer>
</body></html>`;

  writeFileSync(OUT, html, "utf8");
  console.log(`wrote ${rel(OUT)}`);
  console.log(
    `${r.length} routes · ${FLOWS.length} flows · ${cronList.length} crons · ${tables.length} tables · ` +
      `${migs.length} migrations · ${libList.length} libs · ${panelList.length} components · ${testList.length} tests`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
