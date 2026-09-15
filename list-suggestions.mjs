import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

for (const line of readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { data, error } = await db
  .from("suggestions")
  .select("title,category,rationale,evidence,acceptance,effort,priority,area,status,created_at")
  .order("created_at", { ascending: false });

if (error) { console.error("ERR", error.message); process.exit(1); }

// Show open change requests first (most actionable for a coding agent).
const rank = (s) => (s.status === "new" ? 0 : s.status === "building" ? 1 : 2);
const open = data.filter((s) => s.status === "new" || s.status === "building").sort((a, b) => rank(a) - rank(b));
const rest = data.filter((s) => s.status !== "new" && s.status !== "building");

function print(s) {
  const bits = [s.area, s.effort, s.priority].filter(Boolean).join("/");
  console.log(`- [${s.status}] (${s.category}${bits ? ` · ${bits}` : ""}) ${s.title}`);
  if (s.rationale) console.log(`    why: ${s.rationale.replace(/\n/g, " ")}`);
  if (s.evidence) console.log(`    evidence: ${s.evidence.replace(/\n/g, " ")}`);
  if (s.acceptance) console.log(`    acceptance: ${s.acceptance.replace(/\n/g, " ")}`);
  console.log(`    ${s.created_at}`);
}

console.log(`CHANGE REQUESTS (open): ${open.length}`);
console.log(`\n=== OPEN — ready to implement ===`);
for (const s of open) print(s);

if (rest.length) {
  console.log(`\n=== RESOLVED / DISMISSED ===`);
  for (const s of rest) print(s);
}