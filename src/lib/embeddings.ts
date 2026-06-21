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
