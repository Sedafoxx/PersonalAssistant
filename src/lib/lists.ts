import { createServiceClient } from "./supabase";

export type ListKind = "grocery" | "shopping";

export interface ListItem {
  id: string;
  list: ListKind;
  name: string;
  checked: boolean;
  created_at: string;
  updated_at: string;
}

const COLS = "id,list,name,checked,created_at,updated_at";

function norm(name: string): string {
  return name.trim().toLowerCase();
}

// Unchecked first, then oldest-first so the list reads in the order added.
export async function getList(list: ListKind): Promise<ListItem[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("list_items")
    .select(COLS)
    .eq("list", list)
    .order("checked", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ListItem[];
}

// Returns { added } — false means the item was already on the list (dedup
// no-op). DB unique constraint guarantees no duplicate row regardless.
export async function addToList(
  list: ListKind,
  name: string
): Promise<{ added: boolean; item: ListItem | null }> {
  const db = createServiceClient();
  const clean = name.trim();
  if (!clean) return { added: false, item: null };

  const { data, error } = await db
    .from("list_items")
    .upsert(
      { list, name: clean },
      { onConflict: "list,name_norm", ignoreDuplicates: true }
    )
    .select(COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  // ignoreDuplicates → no row returned on conflict, i.e. already present.
  return { added: data !== null, item: (data as ListItem) ?? null };
}

export async function removeFromList(
  list: ListKind,
  name: string
): Promise<boolean> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("list_items")
    .delete()
    .eq("list", list)
    .eq("name_norm", norm(name))
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export async function removeById(id: string): Promise<void> {
  const db = createServiceClient();
  const { error } = await db.from("list_items").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function setChecked(
  id: string,
  checked: boolean
): Promise<ListItem> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("list_items")
    .update({ checked, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No list item with id "${id}"`);
  return data as ListItem;
}

// Clears checked-off items after a shopping trip. Returns count removed.
export async function clearChecked(list: ListKind): Promise<number> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("list_items")
    .delete()
    .eq("list", list)
    .eq("checked", true)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}
