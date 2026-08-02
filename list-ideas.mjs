import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Load .env.local
for (const line of readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { data, error } = await db
  .from("items")
  .select("title,content,priority,status,tags,created_at")
  .eq("type", "idea")
  .order("created_at", { ascending: false });

if (error) { console.error("ERR", error.message); process.exit(1); }
console.log(`IDEAS: ${data.length}\n`);
for (const it of data) {
  console.log(`- [${it.status}] (p${it.priority}) ${it.title}`);
  if (it.content) console.log(`    ${it.content.replace(/\n/g, " ")}`);
  if (it.tags?.length) console.log(`    tags: ${it.tags.join(", ")}`);
  console.log(`    ${it.created_at}`);
}