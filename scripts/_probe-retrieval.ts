// Debug probe for the retrieval window: seeds a backdated fact exactly the way
// memory-retrieval-test does, then measures WHERE it is lost — by the embedding
// search, by the per-topic cap, by maxFacts, or by the character budget.
//
// This exists because the test says only "NOT FOUND", and four different
// mechanisms produce that string. Read-only apart from its own seed, which it
// deletes.
//
// Run: node --env-file=.env.local --import tsx scripts/_probe-retrieval.ts
import { createServiceClient } from "../src/lib/supabase";
import { embed } from "../src/lib/embeddings";
import { retrieveMemory, upsertFact } from "../src/lib/memory";

const unique = String(Date.now());

async function main(): Promise<void> {
  const db = createServiceClient();
  const intent = "what does the user bake with unusual flour on the weekend";
  const topic = `MemProbe Sourdough ${unique}`;

  await upsertFact({
    topic,
    key: `pinecone flour ${unique}`,
    value: `${unique}: the user bakes sourdough with pinecone flour every Sunday`,
    source: "probe",
  });
  await db
    .from("memory_facts")
    .update({ updated_at: new Date(Date.now() - 400 * 864e5).toISOString() })
    .ilike("key", `%${unique}%`);

  try {
    // 1. Does the embedding search reach it, and where does it rank?
    const q = await embed(intent);
    const rpc = await db.rpc("match_memory_facts", {
      query_embedding: q,
      match_count: 40,
      match_threshold: 0.15,
    });
    const hits = (rpc.data ?? []) as { key: string; similarity: number }[];
    const at = hits.findIndex((h) => h.key.includes(unique));
    console.log(`1. embedding search: ${hits.length} candidate(s) returned`);
    console.log(`   probe fact: ${at === -1 ? "NOT in the candidate set" : `index ${at} (similarity ${hits[at].similarity.toFixed(3)})`}`);
    if (hits.length) {
      const sims = hits.map((h) => h.similarity).sort((a, b) => b - a);
      console.log(`   similarity range: ${sims[0].toFixed(3)} … ${sims[sims.length - 1].toFixed(3)}`);
    }

    // 2. Where does the block cut off?
    const mem = await retrieveMemory(intent);
    const headings = mem.block
      .split("\n")
      .filter((l) => l.startsWith("###"))
      .map((l) => l.replace(/^###\s*/, "").slice(0, 46));
    console.log(`\n2. block: ${mem.facts} fact(s), ${mem.chars} chars, fallback ${mem.usedFallback}`);
    console.log(`   probe fact present: ${mem.block.includes(unique)}`);
    console.log(`   topics in the block, in order (${headings.length}):`);
    headings.forEach((h, i) => console.log(`     ${i + 1}. ${h}`));

    // 3. How big is the competition?
    const { count: facts } = await db
      .from("memory_facts")
      .select("id", { count: "exact", head: true })
      .eq("status", "active");
    const { count: topics } = await db.from("memory_topics").select("id", { count: "exact", head: true });
    console.log(`\n3. competition: ${facts} active facts across ${topics} topics`);
  } finally {
    await db.from("memory_facts").delete().ilike("key", `%${unique}%`);
    await db.from("memory_topics").delete().ilike("title", `%${unique}%`);
    const left = await db.from("memory_facts").select("id", { count: "exact", head: true }).ilike("key", `%${unique}%`);
    console.log(`\ncleaned up (${left.count ?? "?"} row(s) left with this run id)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
