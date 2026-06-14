import { createServiceClient } from "./supabase";

export type ItemType = "todo" | "note" | "idea";
export type ItemStatus = "active" | "done" | "archived";
export type SortBy = "priority" | "created_at" | "due_date";

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
  let q = db.from("items").select("*");

  if (opts.type) q = q.eq("type", opts.type);
  if (opts.status) q = q.eq("status", opts.status);
  else q = q.neq("status", "archived");

  if (opts.query) {
    q = q.textSearch("fts", opts.query, { type: "websearch" });
  }

  const sortCol = opts.sort_by ?? "created_at";
  q = q.order(sortCol, { ascending: sortCol === "priority" });

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Item[];
}

export async function createItem(input: CreateItemInput): Promise<Item> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("items")
    .insert({ ...input, priority: input.priority ?? 3 })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Item;
}

export async function updateItem(
  id: string,
  input: UpdateItemInput
): Promise<Item> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("items")
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(error.message);
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
    .select("*")
    .eq("status", "active")
    .not("notification_time", "is", null)
    .lte("notification_time", now);
  if (error) throw new Error(error.message);
  return (data ?? []) as Item[];
}
