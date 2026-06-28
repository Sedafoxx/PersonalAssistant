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
import {
  createGoal,
  getGoals,
  updateGoal,
  type GoalStatus,
} from "./goals";
import {
  getList,
  addToList,
  removeFromList,
  clearChecked,
  type ListKind,
} from "./lists";

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
      name: "create_goal",
      description:
        "Create a long-term goal to track. Use when the user states an aspiration, target, or habit they want to build (e.g. 'I want to run 3x a week', 'read 12 books this year').",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short goal title." },
          description: { type: "string", description: "Optional detail." },
          cadence: {
            type: "string",
            description:
              "Optional rhythm: 'daily', 'weekly', 'monthly', or null for one-off.",
          },
          target: {
            type: "number",
            description:
              "Optional numeric target (e.g. 12 books, 100 workouts). Goal auto-completes when progress reaches it.",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_goals",
      description:
        "List the user's goals and their progress. Use when they ask about goals, progress, or how they're tracking.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "done", "archived"],
            description: "Filter by status. Defaults to active.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_goal",
      description:
        "Update a goal by ID — edit fields, set progress, or mark done/archived. Get the ID from list_goals first.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The goal UUID." },
          title: { type: "string" },
          description: { type: "string" },
          cadence: { type: "string" },
          target: { type: "number" },
          progress: { type: "number", description: "Set absolute progress value." },
          status: { type: "string", enum: ["active", "done", "archived"] },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_choice",
      description:
        "Ask the user to pick from a short list of discrete options via tappable buttons instead of free typing. Use whenever the next step is a clear choice: item type (idea/todo/note), priority level, a yes/no confirmation, or any 'which of these?' question. Do NOT use for open-ended questions. Calling this ends your turn and shows the buttons.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question or prompt shown above the buttons.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "2-6 short button labels the user can tap.",
          },
          mode: {
            type: "string",
            enum: ["single", "multi"],
            description:
              "single = pick one (sends immediately). multi = pick several then confirm. Default single.",
          },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_list",
      description:
        "Add an item to a persistent shopping list. Use for anything the user needs to buy. 'grocery' = food/supermarket; 'shopping' = everything else (household, hardware, clothes...). Duplicates are ignored automatically — safe to call even if it might already be there. Add one item per call.",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", enum: ["grocery", "shopping"] },
          name: { type: "string", description: "The item to buy, e.g. 'Milk'." },
        },
        required: ["list", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_from_list",
      description:
        "Remove an item from a shopping list by name (e.g. user already bought it or changed their mind).",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", enum: ["grocery", "shopping"] },
          name: { type: "string" },
        },
        required: ["list", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_list",
      description:
        "Show the current contents of a shopping list. Use when the user asks what's on their grocery/shopping list.",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", enum: ["grocery", "shopping"] },
        },
        required: ["list"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_checked_list",
      description:
        "Remove all checked-off items from a list. Use after the user says they finished shopping / bought everything checked.",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", enum: ["grocery", "shopping"] },
        },
        required: ["list"],
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

    case "create_goal": {
      const goal = await createGoal({
        title: input.title as string,
        description: input.description as string | undefined,
        cadence: input.cadence as string | undefined,
        target: input.target as number | undefined,
      });
      return JSON.stringify({ success: true, goal });
    }

    case "list_goals": {
      const goals = await getGoals(
        (input.status as GoalStatus | undefined) ?? "active"
      );
      return JSON.stringify({ goals });
    }

    case "update_goal": {
      const { id, ...rest } = input as { id: string } & Record<string, unknown>;
      const goal = await updateGoal(id, rest);
      return JSON.stringify({ success: true, goal });
    }

    case "ask_choice": {
      // Handled specially in the chat route (ends the loop, renders buttons).
      // No DB side effect.
      return JSON.stringify({ ok: true });
    }

    case "search_items": {
      const items = await getItems({
        query: input.query as string,
      });
      return JSON.stringify({ items });
    }

    case "add_to_list": {
      const { added, item } = await addToList(
        input.list as ListKind,
        input.name as string
      );
      return JSON.stringify({
        success: true,
        added,
        already_present: !added,
        item,
      });
    }

    case "remove_from_list": {
      const removed = await removeFromList(
        input.list as ListKind,
        input.name as string
      );
      return JSON.stringify({ success: true, removed });
    }

    case "view_list": {
      const items = await getList(input.list as ListKind);
      return JSON.stringify({ list: input.list, items });
    }

    case "clear_checked_list": {
      const removed = await clearChecked(input.list as ListKind);
      return JSON.stringify({ success: true, removed });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
