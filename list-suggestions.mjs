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
  .select("title,category,rationale,evidence,status,created_at")
  .order("created_at", { ascending: false });

if (error) { console.error("ERR", error.message); process.exit(1); }
console.log(`SUGGESTIONS: ${data.length}\n`);
for (const s of data) {
  console.log(`- [${s.status}] (${s.category}) ${s.title}`);
  if (s.rationale) console.log(`    why: ${s.rationale.replace(/\n/g, " ")}`);
  if (s.evidence) console.log(`    evidence: ${s.evidence.replace(/\n/g, " ")}`);
  console.log(`    ${s.created_at}`);
}