#!/usr/bin/env node
// Generates plans/agent-loop.html — a diagram of the AGENT, not of the app.
//
// What it shows, which is what the app inventory could not:
//   1. one turn as a loop: context → model → tools → results → model, and how it
//      ENDS (a stop, or a question that hands control back to you);
//   2. the whole tool surface, grouped by what it does, with the ones that WRITE
//      marked, because "what can it change on its own" is the trust question;
//   3. the recursion that is NOT inside one turn: the memory write-back, the
//      nightly review, the feed, the coding sub-agent, and the agent that edits
//      this repository;
//   4. the guardrails, which are the load-bearing part of the design.
//
// The tool names and the loop bound are DERIVED from the code (a diagram listing
// tools that no longer exist is worse than none); the topology, the grouping and
// the guardrails are hand-written, because they are decisions, not facts in a file.
//
// Run: npm run diagram
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "plans", "agent-loop.html");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// --- derived: the tool surface ----------------------------------------------
const toolsSrc = read("src/lib/claude-tools.ts");
const TOOLS = [...toolsSrc.matchAll(/name: "([a-z0-9_]+)"/g)].map((m) => m[1]);
const LOOP_BOUND = Number(
  read("src/lib/chat.ts").match(/for \(let i = 0; i < (\d+); i\+\+\)/)?.[1] ?? 8
);
const CRON_COUNT = (JSON.parse(read("vercel.json")).crons ?? []).length;

// Hand-written grouping. Every tool must land in one, or the build fails loudly:
// a tool the diagram hides is a tool the reader will not know exists.
const GROUPS = [
  {
    key: "recall",
    label: "RECALL — read the world",
    writes: false,
    tools: [
      "search_items", "list_items", "search_web", "fetch_url", "list_goals",
      "list_milestones", "list_backlog", "list_memory", "list_loops",
      "list_commitments", "list_calendar_events", "view_list",
    ],
    note: "read-only: nothing here can change a row",
  },
  {
    key: "capture",
    label: "CAPTURE — change the world",
    writes: true,
    tools: [
      "create_item", "update_item", "delete_item", "add_day_task",
      "triage_day_task", "create_goal", "update_goal", "create_milestone",
      "complete_milestone", "add_to_list", "remove_from_list",
      "clear_checked_list", "create_calendar_event", "update_calendar_event",
      "delete_calendar_event", "save_reflection",
    ],
    note: "writes to your records — this is why the guardrails matter",
  },
  {
    key: "memory",
    label: "MEMORY — what Nova carries forward",
    writes: true,
    tools: ["remember_fact", "forget_fact", "log_commitment", "close_commitment", "open_loop", "update_loop"],
    note: "facts supersede, never delete; a pinned fact is never overwritten",
  },
  {
    key: "subagent",
    label: "SUB-AGENT — the coding agent",
    writes: true,
    tools: ["code_read_file", "code_write_file", "code_list_dir", "code_run_command", "code_git"],
    note: "runs on YOUR machine through a local worker; the only tools that touch code",
  },
  {
    key: "control",
    label: "CONTROL — how the turn ends",
    writes: false,
    tools: ["ask_choice"],
    note: "does no work: it STOPS the loop and hands you buttons",
  },
];

const placed = new Set(GROUPS.flatMap((g) => g.tools));
const unplaced = TOOLS.filter((t) => !placed.has(t));
if (unplaced.length) {
  console.error(`TOOLS NOT IN THE DIAGRAM: ${unplaced.join(", ")}`);
  console.error("Add them to GROUPS in scripts/agent-diagram.mjs.");
  process.exitCode = 1;
}

// --- svg helpers ------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
const box = (x, y, w, h, title, sub, opts = {}) => {
  const t = `<text x="${x + 12}" y="${y + 22}" class="bt"${opts.titleFill ? ` fill="${opts.titleFill}"` : ""}>${esc(title)}</text>`;
  const s = sub
    ? sub
        .split("\n")
        .map((line, i) => `<text x="${x + 12}" y="${y + 40 + i * 13}" class="bs">${esc(line)}</text>`)
        .join("")
    : "";
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${opts.fill ?? "#161616"}" ` +
    `stroke="${opts.stroke ?? "rgba(255,255,255,.14)"}"${opts.dashed ? ' stroke-dasharray="5 4"' : ""}/>` +
    t +
    s
  );
};
const arrow = (x1, y1, x2, y2, label, opts = {}) => {
  const color = opts.color ?? "#6b7280";
  const lx = x1 + (x2 - x1) * (opts.at ?? 0.5) + (opts.dx ?? 0);
  const ly = y1 + (y2 - y1) * (opts.at ?? 0.5) + (opts.dy ?? -6);
  const text = label
    ? `<text x="${lx}" y="${ly}" class="al"${opts.fill ? ` fill="${opts.fill}"` : ""}>${esc(label)}</text>`
    : "";
  return (
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" marker-end="url(#a)"` +
    `${opts.dashed ? ' stroke-dasharray="5 4"' : ""}/>` +
    text
  );
};
const path = (d, opts = {}) =>
  `<path d="${d}" fill="none" stroke="${opts.color ?? "#6b7280"}" marker-end="url(#a)"` +
  `${opts.dashed ? ' stroke-dasharray="5 4"' : ""}/>`;
const label = (x, y, text, opts = {}) =>
  `<text x="${x}" y="${y}" class="al"${opts.fill ? ` fill="${opts.fill}"` : ""}${
    opts.rotate ? ` transform="rotate(${opts.rotate} ${x} ${y})"` : ""
  }>${esc(text)}</text>`;
const chip = (x, y, w, text, write) =>
  `<rect x="${x}" y="${y}" width="${w}" height="21" rx="5" fill="${write ? "#251a12" : "#151718"}" stroke="${write ? "#7c4a1e" : "rgba(255,255,255,.10)"}"/>` +
  `<text x="${x + 8}" y="${y + 14}" class="chip">${esc(text)}</text>`;

// --- panel 1: one turn ------------------------------------------------------
// Layout rules, learned by drawing it wrong first: the vertical lanes are
// x≈45 (human in the loop, left) and x≈1205 (memory write-back, right), and
// nothing else may cross y≈205 (the loop-back rail) or y≈450 (the post-turn lane).
function turnPanel() {
  const s = [
    `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
      `<path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280"/></marker></defs>`,
  ];

  // 1. you → route → context
  s.push(box(30, 20, 210, 52, "You", "web tab · phone · Alexa\nnotification tap"));
  s.push(arrow(240, 46, 318, 46));
  s.push(box(322, 20, 300, 52, "POST /api/chat", "streams the reply as it forms"));
  s.push(arrow(472, 72, 472, 104));
  s.push(box(300, 108, 640, 116, "Context assembly  (every single turn)", null, { fill: "#141414" }));
  [
    "brief", "the day + leftovers", "goals & milestones", "threads (people, projects)",
    "promises owed", "backlog", "retrieved memory: pinned → match → recency",
  ].forEach((c, i) => s.push(chip(316 + (i % 4) * 156, 134 + Math.floor(i / 4) * 27, 150, c, false)));
  s.push(arrow(620, 224, 620, 258));

  // 2. the model + the in-turn loop
  s.push(
    box(360, 262, 460, 62, `The model — DeepSeek, ${TOOLS.length} tools`,
      "returns EITHER tool calls OR a final answer\n(extraction runs at temperature 0)")
  );
  s.push(arrow(820, 278, 936, 278, "tool_calls", { at: 0.5, dy: -8 }));
  s.push(
    box(940, 246, 240, 100, "executeTool(name, args)",
      "runs inside the same request;\nseveral calls in one step all run,\nresults appended as role:\"tool\"",
      { fill: "#1a1414", stroke: "#7f1d1d" })
  );
  s.push(path("M 1060 246 C 1060 196, 590 196, 590 256"));
  s.push(label(660, 190, `result fed back → the model decides again  (loop, max ${LOOP_BOUND} steps)`));

  // 3. how the turn ends: a stop
  s.push(arrow(590, 324, 590, 360, "stop", { dx: 8, dy: 4 }));
  s.push(box(430, 364, 320, 46, "Answer streamed to you", "no tool call: the turn is over"));

  // 4. or it ends by asking you — the human-in-the-loop edge
  s.push(arrow(400, 324, 250, 448, "ask_choice", { dashed: true, color: "#4f46e5", at: 0.15, dx: -66, dy: 0, fill: "#818cf8" }));
  s.push(
    box(48, 452, 360, 62, "ask_choice ends the turn",
      "the question renders as tappable buttons, and the\nreasoning in the SAME message is kept",
      { fill: "#141821", stroke: "#3730a3", dashed: true })
  );
  s.push(path("M 48 483 C 14 483, 14 100, 126 74", { color: "#4f46e5", dashed: true }));
  s.push(label(20, 300, "human in the loop", { fill: "#818cf8", rotate: -90 }));

  // 5. after the turn: it is recorded, and it teaches the next turn
  s.push(arrow(590, 410, 590, 444));
  s.push(box(430, 448, 210, 58, "the turn is logged", "chat_messages — what the\nbrief and the review read"));
  s.push(arrow(640, 477, 686, 477));
  s.push(box(690, 448, 226, 58, "facts are extracted", "supersede by key, constraints\npinned, temperature 0"));
  s.push(path("M 916 477 C 1100 477, 1205 420, 1205 240 L 946 196", { color: "#f59e0b", dashed: true }));
  s.push(label(1075, 300, "what this turn wrote is what the next turn reads", { fill: "#fbbf24", rotate: 90 }));

  return `<svg viewBox="0 0 1240 540" class="panel">${s.join("")}</svg>`;
}

// --- panel 2: the tool surface ---------------------------------------------
function toolsPanel() {
  const perRow = 4;
  let y = 0;
  const parts = [];
  for (const g of GROUPS) {
    const rows = Math.ceil(g.tools.length / perRow);
    const h = 40 + rows * 27;
    parts.push(
      `<rect x="0" y="${y}" width="1200" height="${h}" rx="8" fill="${g.writes ? "#1a1210" : "#151718"}" ` +
        `stroke="${g.writes ? "#7c4a1e" : "rgba(255,255,255,.10)"}"/>`
    );
    parts.push(
      `<text x="14" y="${y + 25}" class="bt" fill="${g.writes ? "#fdba74" : "#c7d2fe"}">${esc(g.label)}` +
        `<tspan class="bs">   ${g.tools.length} tool(s) — ${esc(g.note)}</tspan></text>`
    );
    g.tools.forEach((t, i) => {
      const cx = 14 + (i % perRow) * 296;
      const cy = y + 36 + Math.floor(i / perRow) * 27;
      parts.push(chip(cx, cy, 280, t, g.writes));
    });
    y += h + 12;
  }
  return `<svg viewBox="0 0 1200 ${y}" class="panel">${parts.join("")}</svg>`;
}

// --- panel 3: the recursion that is not one turn ---------------------------
const CYCLES = [
  {
    title: "Memory write-back",
    when: "every turn",
    steps: ["a turn happens", "facts extracted, constraints pinned", "the next turn retrieves them"],
    why: "The only reason Nova appears to remember anything between chats. It is a cycle, not a lookup.",
  },
  {
    title: "Nightly review",
    when: "02:00 daily",
    steps: ["read the record + the memory", "look for contradictions and staleness", "write one review row → the morning push"],
    why: "Reports, never edits. An auditor that also rewrites is an auditor you cannot audit.",
  },
  {
    title: "Feed",
    when: "07:00 daily",
    steps: ["interests → searches", "store + validate", "the model scores against your goals", "your feedback reshapes the interests"],
    why: "The one genuinely closed feedback loop in the app: a thumb today changes what it looks for tomorrow.",
  },
  {
    title: "Coding sub-agent",
    when: "when you ask for code",
    steps: ["the model calls code_*", "a local worker runs it in YOUR repo", "files and git change for real", "the result returns to the model"],
    why: "A second loop with real side effects in a different trust domain — hence its own worker and token.",
  },
  {
    title: "The agent that edits this app",
    when: "right now",
    steps: ["you describe a change", "it reads the repo and plans", "it edits, runs the tests, commits", "it deploys"],
    why: "A third agent, outside the app, working ON the app. Being explicit about it is what makes this diagram honest about who acts where.",
  },
];

const GUARDRAILS = [
  ["Bounded recursion", `the loop stops after ${LOOP_BOUND} steps, and a turn that runs out still returns something`],
  ["No deletes, ever, by the model", "forget_fact only proposes; a human confirms in Stats ▸ What I remember"],
  ["A pinned fact is frozen", "upsertFact refuses to overwrite it — a constraint cannot be silently 'improved' away"],
  ["Buttons cannot delete reasoning", "ask_choice ends the turn, but the prose in that same message survives"],
  ["Best-effort reads", "no single failing source can blank the day, the brief or the shell"],
  ["Retrieval has a floor", "pinned facts and the newest 10 are always present, whatever the intent"],
  ["The reviewer does not act", "the nightly review writes observations; it never edits a fact"],
  ["Extraction is temperature 0", "the same sentence must produce the same fact, or the store churns"],
];

function main() {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Nova — the agent loop</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0b0b0c; color:#e5e7eb;
    font: 13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  header { padding:18px 22px 12px; border-bottom:1px solid rgba(255,255,255,.08); }
  h1 { font-size:16px; margin:0; }
  h1 span { color:#9ca3af; font-weight:400; }
  .legend { color:#8b8f98; font-size:12px; margin-top:5px; max-width:940px; }
  main { padding:16px 22px 48px; max-width:1260px; }
  h2 { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#9ca3af; margin:26px 0 10px; }
  svg.panel { width:100%; height:auto; display:block; background:#121214;
    border:1px solid rgba(255,255,255,.08); border-radius:10px; padding:6px; }
  .bt { font: 600 12px ui-monospace,SFMono-Regular,Menlo,monospace; fill:#e5e7eb; }
  .bs { font: 11px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; fill:#9ca3af; }
  .chip { font: 11px ui-monospace,SFMono-Regular,Menlo,monospace; fill:#d1d5db; }
  .al { font: 11px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; fill:#8b8f98; }
  .cycles { display:grid; grid-template-columns: repeat(auto-fit,minmax(310px,1fr)); gap:12px; }
  .cycle { background:#141416; border:1px solid rgba(255,255,255,.08); border-radius:10px; padding:12px; }
  .cycle h3 { font-size:12px; margin:0 0 6px; display:flex; justify-content:space-between; }
  .cycle h3 span { color:#6b7280; font-weight:400; }
  .cycle ol { margin:0 0 6px 16px; padding:0; }
  .cycle p { margin:0; color:#8b8f98; font-size:11.5px; }
  .rails { display:grid; grid-template-columns: repeat(auto-fit,minmax(300px,1fr)); gap:10px; }
  .rail { background:#141416; border:1px solid rgba(255,255,255,.08); border-left:2px solid #4f46e5; border-radius:8px; padding:9px 11px; }
  .rail b { display:block; font-size:12px; }
  .rail span { color:#8b8f98; font-size:11.5px; }
  footer { padding:0 22px 30px; color:#6b7280; font-size:11.5px; max-width:1000px; }
  code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; color:#d1d5db; }
</style></head>
<body>
<header>
  <h1>Nova <span>— the agent, its loop, its tools, and where it recurses</span></h1>
  <div class="legend">
    A turn is a bounded loop: assemble context → ask the model → run whatever tools it asked for →
    feed the results back → ask again, up to ${LOOP_BOUND} steps. Everything else in this app either
    fills that context or feeds on what comes out of it.
  </div>
</header>
<main>
  <h2>1 — one turn</h2>
  ${turnPanel()}

  <h2>2 — the tool surface (${TOOLS.length} tools, derived from the code)</h2>
  ${toolsPanel()}

  <h2>3 — recursion beyond one turn</h2>
  <div class="cycles">
    ${CYCLES.map(
      (c) => `<div class="cycle">
      <h3>${esc(c.title)}<span>${esc(c.when)}</span></h3>
      <ol>${c.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      <p>${esc(c.why)}</p>
    </div>`
    ).join("")}
  </div>

  <h2>4 — the guardrails are the design</h2>
  <div class="rails">
    ${GUARDRAILS.map(([t, d]) => `<div class="rail"><b>${esc(t)}</b><span>${esc(d)}</span></div>`).join("")}
  </div>
</main>
<footer>
  Derived from the code: the ${TOOLS.length} tool names (every one is placed in a group — the build fails
  if one is missing), the loop bound (${LOOP_BOUND}), the ${CRON_COUNT} crons. Hand-written, because they
  are decisions rather than facts in a file: the topology, the grouping, the guardrails.
  Regenerate with <code>npm run diagram</code>; the app inventory is <code>plans/system-map.html</code>
  (<code>npm run map</code>).
</footer>
</body></html>`;

  mkdirSync(join(ROOT, "plans"), { recursive: true });
  writeFileSync(OUT, html, "utf8");
  console.log("wrote plans/agent-loop.html");
  console.log(`${TOOLS.length} tools in ${GROUPS.length} groups · loop bound ${LOOP_BOUND} · ${CRON_COUNT} crons`);
  for (const g of GROUPS) console.log(`  ${g.key}: ${g.tools.length}`);
}

main();
