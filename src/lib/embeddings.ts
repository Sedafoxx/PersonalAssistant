import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const EMBEDDING_MODEL = "text-embedding-3-small";

// Build the text we embed for an item: title carries most signal, content adds context.
export function itemText(title: string, content?: string | null): string {
  return `${title}\n${content ?? ""}`.trim();
}

export async function embed(text: string): Promise<number[]> {
  const input = text.trim().slice(0, 8000) || " ";
  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input,
  });
  return res.data[0].embedding;
}

/**
 * Embed many texts in ONE request, preserving order (null where a row came back
 * missing). Batching is not a micro-optimisation here: a single chat turn can
 * write up to six facts, and one request per fact would multiply the latency and
 * the cost of every turn for no benefit.
 */
export async function embedMany(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const input = texts.map((t) => t.trim().slice(0, 8000) || " ");
  const res = await client.embeddings.create({ model: EMBEDDING_MODEL, input });
  const out: (number[] | null)[] = input.map(() => null);
  for (const row of res.data) out[row.index] = row.embedding;
  return out;
}
