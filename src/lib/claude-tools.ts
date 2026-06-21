import type OpenAI from "openai";
import {
  createItem,
  updateItem,
  deleteItem,
  getItems,
  type ItemType,
  type ItemStatus,
  type SortBy,
} from "./db";

export const TOOL_DEFINITIONS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_item",
      description:
        "Create a new todo, note, or idea extracted from the conversation.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["todo", "note", "idea"],
            description: "The type of item to create.",
          },
          title: {
            type: "string",
            description: "Short, clear title for the item.",
          },
          content: {
            type: "string",
            description: "Optional longer description or body.",
          },
          priority: {
            type: "number",
            description: "Priority 1-5 where 1 is highest. Default 3.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags for categorization.",
          },
          due_date: {
            type: "string",
            description: "ISO 8601 due date, e.g. 2026-06-20T18:00:00Z",
          },
          notification_time: {
            type: "string",
            description:
              "ISO 8601 datetime to send a push notification reminder.",
          },
        },
        required: ["type", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_item",
      description: "Update an existing item by ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The item UUID." },
          title: { type: "string" },
          content: { type: "string" },
          priority: { type: "number" },
          status: { type: "string", enum: ["active", "done", "archived"] },
          tags: { type: "array", items: { type: "string" } },
          due_date: { type: "string" },
          notification_time: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_item",
      description: "Permanently delete an item by ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The item UUID." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_items",
      description:
        "List items with optional filters. Use this to show the user their todos, notes, or ideas.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["todo", "note", "idea"],
            description: "Filter by item type.",
          },
          status: {
            type: "string",
            enum: ["active", "done", "archived"],
            description: "Filter by status. Defaults to active.",
          },
          sort_by: {
            type: "string",
            enum: ["priority", "created_at", "due_date"],
            description: "Sort order. Default: created_at.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_items",
      description:
        "Search across ALL item types (todos, notes, ideas) by keyword and meaning. Always searches every type — do not assume the user means only ideas. Use the user's words as the query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string." },
        },
        required: ["query"],
      },
    },
  },
];

export async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "create_item": {
      const item = await createItem({
        type: input.type as ItemType,
        title: input.title as string,
        content: input.content as string | undefined,
        priority: input.priority as number | undefined,
        tags: input.tags as string[] | undefined,
        due_date: input.due_date as string | undefined,
        notification_time: input.notification_time as string | undefined,
      });
      return JSON.stringify({ success: true, item });
    }

    case "update_item": {
      const { id, ...rest } = input as { id: string } & Record<string, unknown>;
      const item = await updateItem(id, rest);
      return JSON.stringify({ success: true, item });
    }

    case "delete_item": {
      await deleteItem(input.id as string);
      return JSON.stringify({ success: true });
    }

    case "list_items": {
      const items = await getItems({
        type: input.type as ItemType | undefined,
        status: (input.status as ItemStatus | undefined) ?? "active",
        sort_by: input.sort_by as SortBy | undefined,
      });
      return JSON.stringify({ items });
    }

    case "search_items": {
      const items = await getItems({
        query: input.query as string,
      });
      return JSON.stringify({ items });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
