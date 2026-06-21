import { createServiceClient } from "./supabase";
import { embed, itemText } from "./embeddings";

export type ItemType = "todo" | "note" | "idea";
export type ItemStatus = "active" | "done" | "archived";
export type SortBy = "priority" | "created_at" | "due_date";

// Columns to return — excludes `embedding` to keep payloads small.
const ITEM_COLS =
  "id,type,title,content,priority,status,tags,due_date,notification_time,created_at,updated_at";

// Drop embedding from rows returned by the match_items RPC (returns setof items).
function stripEmbedding(row: Record<string, unknown>): Item {
  const { embedding: _embedding, ...rest } = row;
  void _embedding;
  return rest as unknown as Item;
}

export interface Item {
  id: string;
  type: ItemType;
  title: string;
  content: string | null;
  priority: number;
  status: ItemStatus;
  tags: string[];
  due_date: string | null;
  notification_time: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateItemInput {
  type: ItemType;
  title: string;
  content?: string;
  priority?: number;
  tags?: string[];
  due_date?: string;
  notification_time?: string;
}

export interface UpdateItemInput {
  type?: ItemType;
  title?: string;
  content?: string;
  priority?: number;
  status?: ItemStatus;
  tags?: string[];
  due_date?: string;
  notification_time?: string;
}

export async function getItems(opts: {
  type?: ItemType;
  status?: ItemStatus;
  sort_by?: SortBy;
  query?: string;
} = {}): Promise<Item[]> {
  const db = createServiceClient();

  // Hybrid search: combine literal keyword (ilike) matches with semantic
  // (vector) matches. Keyword hits guarantee literal queries surface the
  // right item; semantic hits add contextually-related items.
  if (opts.query) {
    const queryEmbedding = await embed(opts.query);

    // Lexical: any query word as a substring of title or content.
    let lex = db.from("items").select(ITEM_COLS).neq("status", "archived");
    if (opts.type) lex = lex.eq("type", opts.type);
    // Drop short stopwords ("in", "to", "i") so they don't match everything
    // and bury the real hit under the row limit.
    const words = opts.query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    const ors = words.flatMap((w) => [
      `title.ilike.%${w}%`,
      `content.ilike.%${w}%`,
    ]);
    if (ors.length) lex = lex.or(ors.join(","));

    const [semantic, lexical] = await Promise.all([
      db.rpc("match_items", {
        query_embedding: queryEmbedding,
        match_count: 20,
        match_threshold: 0.2,
        filter_type: opts.type ?? null,
      }),
      lex.limit(20),
    ]);
    if (semantic.error) throw new Error(semantic.error.message);
    if (lexical.error) throw new Error(lexical.error.message);

    const semItems = (semantic.data ?? []).map(stripEmbedding);
    const lexItems = (lexical.data ?? []) as Item[];

    // Lexical first (literal match = high confidence), then unseen semantic.
    const seen = new Set<string>();
    const merged: Item[] = [];
    for (const it of [...lexItems, ...semItems]) {
      if (!seen.has(it.id)) {
        seen.add(it.id);
        merged.push(it);
      }
    }
    return merged;
  }

  let q = db.from("items").select(ITEM_COLS);

  if (opts.type) q = q.eq("type", opts.type);
  if (opts.status) q = q.eq("status", opts.status);
  else q = q.neq("status", "archived");

  const sortCol = opts.sort_by ?? "created_at";
  q = q.order(sortCol, { ascending: sortCol === "priority" });

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Item[];
}

export async function createItem(input: CreateItemInput): Promise<Item> {
  const db = createServiceClient();
  const embedding = await embed(itemText(input.title, input.content));
  const { data, error } = await db
    .from("items")
    .insert({ ...input, priority: input.priority ?? 3, embedding })
    .select(ITEM_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data as Item;
}

export async function updateItem(
  id: string,
  input: UpdateItemInput
): Promise<Item> {
  const db = createServiceClient();
  const patch: Record<string, unknown> = {
    ...input,
    updated_at: new Date().toISOString(),
  };

  // Re-embed when title or content changes; merge with existing values for the other field.
  if (input.title !== undefined || input.content !== undefined) {
    const { data: current } = await db
      .from("items")
      .select("title,content")
      .eq("id", id)
      .maybeSingle();
    const title = input.title ?? current?.title ?? "";
    const content = input.content ?? current?.content ?? null;
    patch.embedding = await embed(itemText(title, content));
  }

  const { data, error } = await db
    .from("items")
    .update(patch)
    .eq("id", id)
    .select(ITEM_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No item found with id "${id}"`);
  return data as Item;
}

export async function deleteItem(id: string): Promise<void> {
  const db = createServiceClient();
  const { error } = await db.from("items").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function getItemsDueForNotification(): Promise<Item[]> {
  const db = createServiceClient();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("items")
    .select(ITEM_COLS)
    .eq("status", "active")
    .not("notification_time", "is", null)
    .lte("notification_time", now);
  if (error) throw new Error(error.message);
  return (data ?? []) as Item[];
}
