// Apply supabase/migrations/*.sql in filename order against DATABASE_URL.
// Idempotent: each applied file is recorded in a _migrations table and skipped
// next time. Run with: npm run migrate
//
// DATABASE_URL must be the Postgres connection string from Supabase dashboard →
// Project Settings → Database → "Direct connection" or "Session pooler" (port
// 5432). Put it in .env.local (gitignored). NOT the transaction pooler (6543).

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL not set. Add it to .env.local, then run: npm run migrate"
  );
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "supabase", "migrations");

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// node-postgres ignores discrete config fields when `connectionString` is set,
// so parse the URL into pieces ourselves and pass the password raw via
// DB_PASSWORD. Avoids all percent/dollar encoding pitfalls in the URL.
const u = new URL(url);
const password = process.env.DB_PASSWORD ?? decodeURIComponent(u.password);

const client = new pg.Client({
  host: u.hostname,
  port: Number(u.port) || 5432,
  user: decodeURIComponent(u.username),
  password,
  database: u.pathname.replace(/^\//, "") || "postgres",
  ssl: { rejectUnauthorized: false },
});

await client.connect();

await client.query(`
  create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )
`);

const { rows } = await client.query("select name from _migrations");
const applied = new Set(rows.map((r) => r.name));

let ran = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip  ${file} (already applied)`);
    continue;
  }
  const sql = readFileSync(join(dir, file), "utf8");
  process.stdout.write(`apply ${file} ... `);
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into _migrations(name) values($1)", [file]);
    await client.query("commit");
    console.log("ok");
    ran += 1;
  } catch (err) {
    await client.query("rollback");
    console.log("FAILED");
    console.error(err.message);
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log(`\nDone. ${ran} migration(s) applied, ${files.length - ran} skipped.`);
