// Debug probe: print the exact context block Nova would receive for an intent.
//
// This exists because the 2026-09-20 kitchen failure was invisible from the
// outside: the facts were IN the store, the store was reachable, and the answer
// was still wrong. What matters is what the block SAYS, and that is what this
// prints. No model call, no writes — read-only.
//
// Run: node --env-file=.env.local --import tsx scripts/_probe-context.ts "ich will jetzt kochen"
import { buildAssistantContext } from "../src/lib/coach";
import { retrieveMemory } from "../src/lib/memory";

async function main(): Promise<void> {
  const intent = process.argv.slice(2).join(" ").trim() || "ich will jetzt kochen";
  console.log(`intent: "${intent}"\n`);

  const mem = await retrieveMemory(intent);
  console.log(
    `--- memory block (${mem.facts} facts, ${mem.chars} chars, fallback: ${mem.usedFallback}) ---`
  );
  console.log(mem.block || "(empty)");

  const full = await buildAssistantContext({ intent });
  console.log("\n--- full context sent to the model ---");
  console.log(`(${full.length} chars)`);
  const idx = full.indexOf("## What Nova knows");
  console.log(full.slice(Math.max(0, idx), idx + 2200));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
