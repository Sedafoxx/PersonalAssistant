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
  addDayTask,
  carryOver,
  dropTask,
  pullIntoDay,
  listLeftovers,
  localDay,
  isDayString,
  getDay,
} from "./day";
import {
  getMilestones,
  getMilestonesByGoal,
  createMilestone,
  toggleMilestone,
  type Milestone,
} from "./milestones";
import { getReflection, upsertReflection, DEFAULT_CHECKLIST } from "./reflection";
import { saveCheckin } from "./coach";
import {
  getList,
  addToList,
  removeFromList,
  clearChecked,
  type ListKind,
} from "./lists";
import {
  listUpcomingEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from "./calendar";
import { searchWeb, fetchPageText } from "./web";
import {
  codeReadFile,
  codeWriteFile,
  codeListDir,
  codeRunCommand,
  codeGit,
} from "./coding-agent";
import {
  upsertFact,
  getTopics,
  getActiveFacts,
  setFactStatus,
} from "./memory";
import {
  createCommitment,
  listCommitments,
  closeCommitment,
  getCommitment,
} from "./commitments";
import {
  listLoops,
  upsertLoop,
  setLoopState,
  getLoop,
  type LoopState,
  type WaitingOn,
  type LoopKind,
} from "./loops";
import { getBacklog, formatBacklogForContext, type Backlog } from "./backlog";

// Commitments ledger + open loops tools (P6a). Declared separately and spread
// into TOOL_DEFINITIONS so the additions stay grouped and reviewable.
const COMMITMENT_LOOP_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "log_commitment",
      description:
        "Log a promise the USER just made as a real todo plus a ledger row. Call this the moment they say they will do something themselves (e.g. 'I will call the dentist tomorrow', 'ich kaufe morgen Karotten'). Logging the same promise twice is treated as a duplicate, so it is safe to call. NEVER log your OWN suggestions, offers, hypotheticals, or something already in the past.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Short imperative todo, e.g. 'Call the dentist'.",
          },
          due: {
            type: "string",
            description: "Optional due day 'YYYY-MM-DD'.",
          },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_commitments",
      description:
        "List the promises the user has made, with their due dates. Defaults to the open ones.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["open", "done", "dropped"],
            description: "Filter by status. Defaults to open.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_commitment",
      description:
        "Close a logged commitment by id - mark it done or dropped. Get the id from list_commitments first. This also completes or archives its linked todo.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The commitment UUID." },
          status: {
            type: "string",
            enum: ["done", "dropped"],
            description: "done (kept the promise) or dropped (let it go).",
          },
        },
        required: ["id", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_loop",
      description:
        "Track an unfinished thread tied to a person or project (e.g. 'waiting on the landlord about the heating'). Writing the same subject+thread again UPDATES that thread instead of duplicating it, so it is always safe to call.",
      parameters: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description: "The person or project, e.g. 'Theresa'.",
          },
          thread: {
            type: "string",
            description: "The open thread, e.g. 'Owes me the venue answer'.",
          },
          state: {
            type: "string",
            enum: ["open", "waiting", "done"],
            description: "Default open.",
          },
          waiting_on: {
            type: "string",
            enum: ["you", "them"],
            description: "Who owes the next move.",
          },
          detail: { type: "string", description: "Optional detail." },
          due: {
            type: "string",
            description: "Optional due day 'YYYY-MM-DD'.",
          },
          kind: {
            type: "string",
            enum: ["person", "project", "topic"],
            description:
              "What the thread is about: 'person' for a human, 'project' for work you own, otherwise 'topic'.",
          },
          next_step: {
            type: "string",
            description:
              "The ONE next concrete move. A thread with a state but no next step is a note, not something that can be planned.",
          },
        },
        required: ["subject", "thread"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_loop",
      description:
        "Move an open loop forward by id: change its state, who it is waiting on, or its detail. Get the id from list_loops first.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The loop UUID." },
          state: { type: "string", enum: ["open", "waiting", "done"] },
          waiting_on: { type: "string", enum: ["you", "them"] },
          detail: { type: "string" },
          kind: {
            type: "string",
            enum: ["person", "project", "topic"],
            description: "Correct what the thread is about.",
          },
          next_step: {
            type: "string",
            description:
              "Replace the thread's next concrete move (empty string clears it).",
          },
        },
        required: ["id", "state"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_loops",
      description:
        "List open loops (unfinished threads), optionally scoped to one subject or state.",
      parameters: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description: "Optional subject to filter by.",
          },
          state: {
            type: "string",
            enum: ["open", "waiting", "done"],
            description: "Filter by state.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_backlog",
      description:
        "Show what has stalled and what is waiting: milestones with no activity for two weeks, active todos that were never put on a day, and ideas captured but never turned into a step. Use this to dig mid-conversation without the whole backlog being in every prompt.",
      parameters: {
        type: "object",
        properties: {
          group: {
            type: "string",
            enum: ["stalled", "unscheduled", "ideas"],
            description:
              "Optional. Omit for the whole backlog.",
          },
        },
      },
    },
  },
];

export const TOOL_DEFINITIONS: OpenAI.ChatCompletionTool[] = [
  ...COMMITMENT_LOOP_TOOLS,
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
      name: "list_calendar_events",
      description:
        "Read upcoming events from the user's Google Calendar. Use when they ask what's on their schedule, if they're free, when something is, or before booking to check for conflicts.",
      parameters: {
        type: "object",
        properties: {
          days_ahead: {
            type: "number",
            description: "How many days from now to look. Default 7.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description:
        "Create a real appointment on the user's Google Calendar. Use when they want to schedule, book, or plan something at a specific time (e.g. 'dentist Tuesday 3pm', 'lunch with Theresa Friday'). This is different from a todo — use this for things that happen AT a time. Always confirm the time you booked.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title." },
          start: {
            type: "string",
            description:
              "Local start datetime, no timezone suffix: 'YYYY-MM-DDTHH:MM:SS' (interpreted as Europe/Vienna). For all-day, use 'YYYY-MM-DD' and set all_day true.",
          },
          end: {
            type: "string",
            description:
              "Local end datetime, same format as start. If the user gives no duration, default to 1 hour after start. For all-day, the day AFTER the last day.",
          },
          all_day: {
            type: "boolean",
            description: "True for all-day events. Default false.",
          },
          location: { type: "string", description: "Optional location." },
          description: { type: "string", description: "Optional notes." },
        },
        required: ["title", "start", "end"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_calendar_event",
      description:
        "Reschedule or edit an existing calendar event. You MUST have the event's real id from a list_calendar_events call in THIS request — never guess it. Only pass the fields that change.",
      parameters: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "The event id (from list_calendar_events)." },
          title: { type: "string" },
          start: { type: "string", description: "New local start, same format as create." },
          end: { type: "string", description: "New local end, same format as create." },
          all_day: { type: "boolean" },
          location: { type: "string" },
          description: { type: "string" },
        },
        required: ["event_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_calendar_event",
      description:
        "Cancel/delete a calendar event. You MUST have the event's real id from a list_calendar_events call in THIS request — never guess it.",
      parameters: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "The event id (from list_calendar_events)." },
        },
        required: ["event_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_items",
      description:
        "Search across ALL item types (todos, notes, ideas) by keyword and meaning — the notebook mixes German and English, and the search understands both. Always searches every type — do not assume the user means only ideas. Use the user's own words as the query (a whole sentence is fine). Results come back already ranked, strongest match first: ANSWER FROM THE TOP OF THE LIST, and if the top hits are not actually about the thing that was asked, say so rather than padding the reply with weak matches.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "Search the live web (Tavily) and return the top results with titles, URLs, and content snippets. Use for current events, recent news, live data, or anything you're not confident about — especially things that may have happened after your training data.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch a web page and return its readable text. Use after search_web to read a specific article or page in full before answering.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_read_file",
      description:
        "Read a file in the project repository (path relative to repo root). Use to inspect code before editing.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to repo root." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_write_file",
      description:
        "Write (create or overwrite) a file in the project repository (path relative to repo root). Use to make code changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to repo root." },
          content: { type: "string", description: "Full file contents." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_list_dir",
      description:
        "List the contents of a directory in the project repository (path relative to repo root, default '.').",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to repo root." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_run_command",
      description:
        "Run a shell command in the project repository, e.g. 'npm test' or 'npm run build'. Use to verify changes. cwd is relative to repo root (default '.').",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command." },
          cwd: { type: "string", description: "Optional working dir relative to repo root." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_git",
      description:
        "Git operations in the repo. action: 'status' (uncommitted changes), 'diff', 'add' (stage all), 'commit' (requires message), 'push', 'log' (recent commits).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "diff", "add", "commit", "push", "log"] },
          message: { type: "string", description: "Commit message (required for commit)." },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_day_task",
      description:
        "Add a small task to the user's plan for TODAY (the 'Today' window). Use when planning the day or when the user agrees to a concrete next step. Each task should be small and tied to one of their milestones when possible.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short, concrete task title." },
          time: {
            type: "string",
            description: "Optional local time of day, e.g. '07:30'.",
          },
          priority: {
            type: "number",
            description: "Priority 1-5 where 1 is highest. Default 3.",
          },
          required: {
            type: "boolean",
            description:
              "True if this task is needed today, false if optional. Default true.",
          },
          goal: {
            type: "string",
            description:
              "Optional goal TITLE this task advances (e.g. 'Run a half marathon'). Resolved to the goal automatically.",
          },
          milestone: {
            type: "string",
            description:
              "Optional milestone TITLE this task advances (a real step inside a goal). Resolved to the milestone automatically; prefer this over goal when the task maps to a specific step.",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "triage_day_task",
      description:
        "Resolve a leftover task from a previous day, one at a time. action 'carry' moves it onto today, 'reschedule' moves it to a future date, 'drop' archives it (never deletes). Identify the task by id, or by title (it is looked up in today's plan, then in the leftovers). Some leftovers expire — a missed morning workout cannot be recovered, so dropping it is often the honest choice.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The task's item UUID, if you have it." },
          title: {
            type: "string",
            description:
              "The task title to look up in the current day, then among leftovers.",
          },
          action: {
            type: "string",
            enum: ["carry", "drop", "reschedule"],
            description: "What to do with the task.",
          },
          date: {
            type: "string",
            description:
              "For action 'reschedule': the target local day 'YYYY-MM-DD'. Defaults to today for 'carry'.",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_milestones",
      description:
        "List a goal's milestones, or the milestones of every active goal grouped by goal. Use when the user asks about milestones or steps toward a goal.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description:
              "Optional goal TITLE to scope to one goal. Omit to group across active goals.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_milestone",
      description:
        "Add a milestone (a real ordered step) to one of the user's goals. Adding milestones switches the goal's progress to be derived from them.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The goal TITLE to add the milestone to." },
          title: { type: "string", description: "Short milestone title." },
          target_date: {
            type: "string",
            description: "Optional target day 'YYYY-MM-DD'.",
          },
        },
        required: ["goal", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_milestone",
      description:
        "Mark a milestone done (or undone). Identify it by id, or by title together with its goal title. With only a title, the goal's milestones are listed first so you can disambiguate.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The milestone UUID, if you have it." },
          title: { type: "string", description: "The milestone title." },
          goal: {
            type: "string",
            description: "The goal TITLE the milestone belongs to (helps disambiguate).",
          },
          done: {
            type: "boolean",
            description: "Default true (mark done). Set false to un-complete.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_reflection",
      description:
        "Save the user's evening reflection for today. Call this once a reflection conversation has covered what they wanted to say: it marks today's reflection COMPLETE, which advances their streak, and records the mood numerically so their mood history and stats stay accurate. Infer the mood from how they described the day rather than asking them to score it. Only pass what was actually said; empty values never overwrite what is already saved.",
      parameters: {
        type: "object",
        properties: {
          went_well: { type: "string", description: "What went well today, in their words." },
          could_improve: { type: "string", description: "What could improve, in their words." },
          mood: {
            type: "number",
            description:
              "Mood 1-5 inferred from how they described the day (1 = rough, 5 = great). Omit if it is genuinely unclear.",
          },
          energy: {
            type: "number",
            description: "Energy 1-5, only if it came up.",
          },
          habits: {
            type: "array",
            items: { type: "string" },
            description:
              'Habits they said they did today, e.g. ["move", "water"]. Matched case-insensitively against their checklist: journal, plan, screens, move, water, gratitude.',
          },
          day: {
            type: "string",
            description:
              'Which day this reflection is FOR. Omit for the normal case. Pass "yesterday" when the user is up past midnight and is reflecting on the day that just ended, or an explicit YYYY-MM-DD if they name a day.',
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_fact",
      description:
        "Remember a durable fact about the user, keeping it current. Use when the user tells you something worth recalling long-term (a preference, a person, a routine, a constraint). Facts live under a topic and are keyed: writing the same topic+key again UPDATES the value instead of piling up duplicate rows, so it is always safe to call when something changes. You may add and update facts; you can never delete them. PIN A CONSTRAINT (diet, allergy, medical, never/always X) — an unpinned fact has to be retrieved to be seen, and a constraint that is only sometimes in front of you is what lets you suggest chicken to a vegan.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Topic bucket, e.g. the area of life this belongs to (Küche, Health, Work).",
          },
          key: {
            type: "string",
            description: "Short attribute name, e.g. favourite cuisine.",
          },
          value: {
            type: "string",
            description: "The current value to remember.",
          },
          pinned: {
            type: "boolean",
            description:
              "True ONLY for a hard constraint (diet, allergy, medical, never/always X). A pinned fact is always in your context and is never silently overwritten, so pin sparingly and only what must never be violated.",
          },
        },
        required: ["topic", "key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memory",
      description:
        "Show what the coach currently remembers. With no topic, list the topics and how many active facts each holds; with a topic, list that topic as key: value lines. Use when the user asks what you know or remember about them.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Optional topic to list in detail. Omit to show all topics with counts.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_fact",
      description:
        "Propose removing one remembered fact. This does NOT delete anything: it flags the fact as pending removal and the user must confirm the removal in the Stats tab (\"What I remember\"). Use only when the user asks you to forget something.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "The topic the fact belongs to.",
          },
          key: {
            type: "string",
            description: "The key of the fact to propose for removal.",
          },
        },
        required: ["topic", "key"],
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
      // getItems already ranks by relevance (literal coverage first, then the
      // bilingual synonyms, then meaning). Cap what the model sees: 45 rows is
      // not more information, it is a haystack — and the far end of it is what
      // made a search that HAD the answer read as "I found nothing".
      const items = await getItems({
        query: input.query as string,
      });
      return JSON.stringify({
        total: items.length,
        shown: Math.min(items.length, 12),
        items: items.slice(0, 12),
      });
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

    case "list_calendar_events": {
      try {
        const events = await listUpcomingEvents({
          daysAhead: input.days_ahead as number | undefined,
        });
        return JSON.stringify({ events });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : "calendar read failed" });
      }
    }

    case "create_calendar_event": {
      try {
        const event = await createEvent({
          title: input.title as string,
          start: input.start as string,
          end: input.end as string,
          allDay: input.all_day as boolean | undefined,
          location: input.location as string | undefined,
          description: input.description as string | undefined,
        });
        return JSON.stringify({ success: true, event });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : "create event failed" });
      }
    }

    case "update_calendar_event": {
      try {
        const event = await updateEvent({
          eventId: input.event_id as string,
          title: input.title as string | undefined,
          start: input.start as string | undefined,
          end: input.end as string | undefined,
          allDay: input.all_day as boolean | undefined,
          location: input.location as string | undefined,
          description: input.description as string | undefined,
        });
        return JSON.stringify({ success: true, event });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : "update event failed" });
      }
    }

    case "delete_calendar_event": {
      try {
        await deleteEvent(input.event_id as string);
        return JSON.stringify({ success: true });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : "delete event failed" });
      }
    }

    case "search_web": {
      return await searchWeb(input.query as string);
    }

    case "fetch_url": {
      return await fetchPageText(input.url as string);
    }

    case "code_read_file": {
      return await codeReadFile(input.path as string);
    }

    case "code_write_file": {
      return await codeWriteFile(input.path as string, input.content as string);
    }

    case "code_list_dir": {
      return await codeListDir(input.path as string);
    }

    case "code_run_command": {
      return await codeRunCommand(input.command as string, input.cwd as string | undefined);
    }

    case "code_git": {
      return await codeGit(input.action as string, input.message as string | undefined);
    }

    case "add_day_task": {
      const goalTitle = input.goal as string | undefined;
      let goalId: string | undefined;
      if (goalTitle) {
        const goals = await getGoals("active");
        const match = goals.find(
          (g) => g.title.toLowerCase() === goalTitle.toLowerCase()
        ) ??
          goals.find((g) =>
            g.title.toLowerCase().includes(goalTitle.toLowerCase())
          );
        if (!match) {
          return JSON.stringify({
            error: `No active goal matching "${goalTitle}". Call list_goals to see the real titles.`,
          });
        }
        goalId = match.id;
      }
      const milestoneTitle = input.milestone as string | undefined;
      let milestoneId: string | undefined;
      if (milestoneTitle) {
        // Search the named goal's milestones first, else every active goal's.
        const needle = milestoneTitle.toLowerCase();
        const scopeGoalIds = goalId
          ? [goalId]
          : (await getGoals("active")).map((g) => g.id);
        const grouped = await getMilestonesByGoal(scopeGoalIds);
        const candidates = scopeGoalIds.flatMap((gid) =>
          (grouped[gid] ?? []).filter(
            (m) =>
              m.title.toLowerCase() === needle ||
              m.title.toLowerCase().includes(needle)
          )
        );
        if (candidates.length === 0) {
          return JSON.stringify({
            error: `No milestone matching "${milestoneTitle}". Call list_milestones to see the real titles.`,
          });
        }
        if (candidates.length > 1) {
          return JSON.stringify({
            error: `"${milestoneTitle}" matches several milestones — pass the goal too.`,
            matches: candidates.map((m) => m.title),
          });
        }
        milestoneId = candidates[0].id;
        // A milestone implies its goal — derive it so the two never disagree.
        goalId = candidates[0].goal_id;
      }
      const item = await addDayTask({
        title: input.title as string,
        priority: input.priority as number | undefined,
        required: input.required as boolean | undefined,
        planned_time: input.time as string | undefined,
        goal_id: goalId,
        milestone_id: milestoneId,
      });
      return JSON.stringify({ success: true, task: item });
    }

    case "triage_day_task": {
      const action = input.action as string;
      if (action !== "carry" && action !== "drop" && action !== "reschedule") {
        return JSON.stringify({
          error: `Unknown action "${action}" — use carry, drop or reschedule.`,
        });
      }

      let id = input.id as string | undefined;
      let found: { id: string; title: string; planned_for: string | null } | undefined;

      if (!id) {
        const title = input.title as string | undefined;
        if (!title) {
          return JSON.stringify({
            error: "Provide either an id or a title to triage.",
          });
        }
        const needle = title.toLowerCase();
        const isMatch = (t: string) =>
          t.toLowerCase() === needle || t.toLowerCase().includes(needle);

        // Look in the current day first, then in the leftovers.
        const dayView = await getDay();
        const inDay = dayView.today.find((i) => isMatch(i.title));
        if (inDay) {
          id = inDay.id;
          found = { id: inDay.id, title: inDay.title, planned_for: inDay.planned_for };
        } else {
          const leftovers = await listLeftovers();
          const left = leftovers.find((i) => isMatch(i.title));
          if (left) {
            id = left.id;
            found = { id: left.id, title: left.title, planned_for: left.planned_for };
          }
        }

        if (!id) {
          return JSON.stringify({
            error: `No task matching "${title}" in today's plan or the leftovers.`,
          });
        }
      }

      if (action === "carry") {
        const item = await carryOver(id, isDayString(input.date) ? (input.date as string) : undefined);
        return JSON.stringify({ success: true, carried: item });
      }
      if (action === "reschedule") {
        if (!isDayString(input.date)) {
          return JSON.stringify({
            error: "Reschedule needs a target day 'YYYY-MM-DD'.",
          });
        }
        const item = await pullIntoDay(id, input.date as string);
        return JSON.stringify({ success: true, rescheduled: item });
      }
      await dropTask(id);
      return JSON.stringify({
        success: true,
        dropped: found ?? { id },
      });
    }

    case "list_milestones": {
      const goalTitle = input.goal as string | undefined;
      if (goalTitle) {
        const goals = await getGoals();
        const match = goals.find(
          (g) => g.title.toLowerCase() === goalTitle.toLowerCase()
        ) ?? goals.find((g) =>
          g.title.toLowerCase().includes(goalTitle.toLowerCase())
        );
        if (!match) {
          return JSON.stringify({
            error: `No goal matching "${goalTitle}". Call list_goals to see the real titles.`,
          });
        }
        const milestones = await getMilestones(match.id);
        return JSON.stringify({ goal: match.title, milestones });
      }

      const goals = await getGoals("active");
      const grouped = await getMilestonesByGoal(goals.map((g) => g.id));
      const result = goals.map((g) => ({
        goal: g.title,
        milestones: grouped[g.id] ?? [],
      }));
      return JSON.stringify({ goals: result });
    }

    case "create_milestone": {
      const goalTitle = input.goal as string;
      const goals = await getGoals();
      const match = goals.find(
        (g) => g.title.toLowerCase() === goalTitle.toLowerCase()
      ) ?? goals.find((g) =>
        g.title.toLowerCase().includes(goalTitle.toLowerCase())
      );
      if (!match) {
        return JSON.stringify({
          error: `No goal matching "${goalTitle}". Call list_goals to see the real titles.`,
        });
      }
      const milestone = await createMilestone({
        goal_id: match.id,
        title: input.title as string,
        target_date: (input.target_date as string | undefined) ?? null,
      });
      return JSON.stringify({ success: true, goal: match.title, milestone });
    }

    case "complete_milestone": {
      const done = (input.done as boolean | undefined) ?? true;
      let id = input.id as string | undefined;

      if (!id) {
        const title = input.title as string | undefined;
        if (!title) {
          return JSON.stringify({
            error: "Provide a milestone id, or a title (with its goal).",
          });
        }
        const needle = title.toLowerCase();

        let goalIds: { id: string; title: string }[] = [];
        const goalTitle = input.goal as string | undefined;
        if (goalTitle) {
          const goals = await getGoals();
          const match = goals.find(
            (g) => g.title.toLowerCase() === goalTitle.toLowerCase()
          ) ?? goals.find((g) =>
            g.title.toLowerCase().includes(goalTitle.toLowerCase())
          );
          if (!match) {
            return JSON.stringify({
              error: `No goal matching "${goalTitle}". Call list_goals first.`,
            });
          }
          goalIds = [{ id: match.id, title: match.title }];
        } else {
          const goals = await getGoals("active");
          goalIds = goals.map((g) => ({ id: g.id, title: g.title }));
        }

        const grouped = await getMilestonesByGoal(goalIds.map((g) => g.id));
        const candidates: { id: string; goal: string }[] = [];
        for (const g of goalIds) {
          for (const m of grouped[g.id] ?? []) {
            if (
              m.title.toLowerCase() === needle ||
              m.title.toLowerCase().includes(needle)
            ) {
              candidates.push({ id: m.id, goal: g.title });
            }
          }
        }

        if (candidates.length === 0) {
          const listing: { goal: string; milestones: Milestone[] }[] =
            goalIds.map((g) => ({
              goal: g.title,
              milestones: grouped[g.id] ?? [],
            }));
          return JSON.stringify({
            error: `No milestone matching "${title}".`,
            milestones: listing,
          });
        }
        if (candidates.length > 1 && !goalTitle) {
          return JSON.stringify({
            error: `"${title}" matches several milestones — say which goal.`,
            matches: candidates,
          });
        }
        id = candidates[0].id;
      }

      const milestone = await toggleMilestone(id, done);
      return JSON.stringify({ success: true, milestone });
    }

    case "save_reflection": {
      // The day is normally the one the user is living (see dates.ts: before
      // 04:00 that is the day that just ended). `day` exists for the case they are
      // explicit about it — "this is for yesterday" at 1am — because refusing a
      // reflection just because the calendar moved on is the bug they hit.
      const shift = (from: string, days: number): string => {
        const [y, m, d] = from.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        dt.setUTCDate(dt.getUTCDate() + days);
        return dt.toISOString().slice(0, 10);
      };
      const dayArg = (input.day as string | undefined)?.trim().toLowerCase();
      const day =
        dayArg === "yesterday"
          ? shift(localDay(), -1)
          : dayArg === "tomorrow"
            ? shift(localDay(), 1)
            : isDayString(dayArg)
              ? dayArg
              : localDay();

      const wentWell = (input.went_well as string | undefined)?.trim();
      const couldImprove = (input.could_improve as string | undefined)?.trim();
      const habits = Array.isArray(input.habits)
        ? input.habits
            .map((h) => String(h).trim().toLowerCase())
            .filter((h) => h.length > 0)
        : [];

      // Clamp rather than trust: a 0 or a 7 would corrupt the mood sparkline and
      // the stats tab.
      const rating = (value: unknown): number | undefined => {
        const n = Math.round(Number(value));
        return Number.isFinite(n) && n >= 1 && n <= 5 ? n : undefined;
      };
      const mood = rating(input.mood);
      const energy = rating(input.energy);

      // Read the current record first so an empty field never clobbers a value
      // that is already saved.
      const existing = await getReflection(day);

      // Mood is recorded on the day's evening check-in, not only as prose: the
      // mood sparkline, the stats tab and the coach's own context read it from
      // there, so recording text alone would quietly end mood tracking now that
      // the form is gone.
      // Close the day's evening check-in as well. That used to be the "Log today"
      // button; leaving it open would keep the evening action on the coach's
      // "open past actions" list, so it would keep re-proposing what you have just
      // finished reflecting on. Undefined ratings are simply not written.
      try {
        await saveCheckin({ kind: "evening", day, mood, energy, status: "done" });
      } catch {
        // non-fatal — the reflection below still saves
      }

      // Tick the checklist items the conversation actually covered, so the habits
      // count in the Wins card keeps working without a form.
      const base = existing?.checklist ?? DEFAULT_CHECKLIST;
      const checklist = habits.length
        ? base.map((item) =>
            habits.some(
              (h) => item.id.toLowerCase() === h || item.label.toLowerCase().includes(h)
            )
              ? { ...item, done: true }
              : item
          )
        : base;

      const reflection = await upsertReflection({
        day,
        checklist,
        went_well: wentWell ?? existing?.went_well ?? null,
        could_improve: couldImprove ?? existing?.could_improve ?? null,
        // A lived-through conversation IS the reflection, so it counts as done.
        // Without this the streak could never advance from a chat reflection.
        completed: true,
      });
      if (!reflection) return "Could not save the reflection - try again.";

      const bits = [
        mood !== undefined ? `mood ${mood}/5` : "",
        habits.length ? `${habits.length} habit${habits.length === 1 ? "" : "s"}` : "",
      ].filter((b) => b.length > 0);
      return (
        "Reflection saved for " +
        day +
        (bits.length > 0 ? " (" + bits.join(", ") + ")" : "") +
        ". Streak updated."
      );
    }

    case "remember_fact": {
      const topic = (input.topic as string | undefined)?.trim();
      const key = (input.key as string | undefined)?.trim();
      const value = (input.value as string | undefined)?.trim();
      if (!topic || !key || !value) {
        return "Tell me the topic, key and value to remember.";
      }

      // Resolve the topic by name so we can name the value being replaced.
      const topics = await getTopics();
      const needle = topic.toLowerCase();
      const match =
        topics.find((t) => t.title.toLowerCase() === needle || t.slug === needle) ??
        topics.find((t) => t.title.toLowerCase().includes(needle));
      let oldValue: string | null = null;
      if (match) {
        const existing = await getActiveFacts(match.id);
        const live = existing.find((f) => f.key.toLowerCase() === key.toLowerCase());
        if (live) oldValue = live.value;
      }

      const pinned = input.pinned === true;
      const result = await upsertFact({
        topic,
        key,
        value,
        ...(pinned ? { pinned: true } : {}),
      });
      if (!result.fact) {
        return "I could not save that fact - please give a topic, key and value.";
      }
      if (!result.changed) {
        if (result.fact.pinned && oldValue !== null && oldValue !== value) {
          return "Already remembered as " + key + ": " + oldValue + ". It is pinned, so I left it as-is.";
        }
        return "Already had " + key + ": " + result.fact.value + " - nothing changed.";
      }
      const pinNote = result.fact.pinned
        ? " It is pinned, so it stays in front of me."
        : "";
      if (oldValue !== null) {
        return "Updated " + key + ": " + oldValue + " -> " + value + "." + pinNote;
      }
      return "Saved " + key + ": " + value + " under " + topic + "." + pinNote;
    }

    case "list_memory": {
      const topicArg = (input.topic as string | undefined)?.trim();
      const topics = await getTopics();
      if (!topics.length) {
        return "I am not maintaining any facts yet. Tell me something concrete and I will start keeping track.";
      }

      if (!topicArg) {
        const facts = await getActiveFacts();
        const lines = topics.map((t) => {
          const n = facts.filter((f) => f.topic_id === t.id).length;
          return "- " + t.title + " (" + n + (n === 1 ? " fact)" : " facts)");
        });
        return "Topics I keep current:\n" + lines.join("\n");
      }

      const needle = topicArg.toLowerCase();
      const topic =
        topics.find((t) => t.title.toLowerCase() === needle || t.slug === needle) ??
        topics.find((t) => t.title.toLowerCase().includes(needle));
      if (!topic) return "I have nothing filed under " + topicArg + " yet.";

      const facts = await getActiveFacts(topic.id);
      if (!facts.length) return topic.title + " has no live facts right now.";
      const lines = facts.map(
        (f) => "- " + f.key + ": " + f.value + (f.pinned ? " [pinned]" : "")
      );
      return (
        topic.title +
        (topic.summary ? "\n" + topic.summary : "") +
        "\n" +
        lines.join("\n")
      );
    }

    case "forget_fact": {
      const topicArg = (input.topic as string | undefined)?.trim();
      const keyArg = (input.key as string | undefined)?.trim();
      if (!topicArg || !keyArg) {
        return "Tell me the topic and the key to propose for removal.";
      }

      // PROPOSE ONLY. This never deletes: the row is flagged for removal and the
      // human confirms it in the Stats tab ("What I remember"). The assistant
      // must not erase facts on its own, because a wrong deletion is
      // unrecoverable while a stale fact is merely corrected.
      const topics = await getTopics();
      const needle = topicArg.toLowerCase();
      const topic =
        topics.find((t) => t.title.toLowerCase() === needle || t.slug === needle) ??
        topics.find((t) => t.title.toLowerCase().includes(needle));
      if (!topic) return "I have nothing filed under " + topicArg + " to remove.";

      const facts = await getActiveFacts(topic.id);
      const live = facts.find((f) => f.key.toLowerCase() === keyArg.toLowerCase());
      if (!live) {
        return "There is no live fact for " + keyArg + " in " + topic.title + ".";
      }
      await setFactStatus(live.id, "pending_removal");
      return (
        "Proposed removing " +
        live.key +
        ": " +
        live.value +
        ". I do not delete facts on my own - confirm it in the Stats tab (What I remember) and it will go."
      );
    }

    case "log_commitment": {
      const text = (input.text as string | undefined)?.trim();
      if (!text) return "Tell me what you promised to do.";
      const { commitment, duplicate } = await createCommitment({
        text,
        due_date: (input.due as string | undefined) ?? null,
        source: "coach",
      });
      if (duplicate) {
        return "That promise is already logged: " + commitment.text + ".";
      }
      const when = commitment.due_date ? " (due " + commitment.due_date + ")" : "";
      return "Logged: " + commitment.text + when + ". I made a todo for it too.";
    }

    case "list_commitments": {
      const status = (input.status as "open" | "done" | "dropped" | undefined) ?? "open";
      const rows = await listCommitments({ status, limit: 20 });
      if (!rows.length) {
        return status === "open"
          ? "No open promises right now."
          : "Nothing with status " + status + ".";
      }
      const lines = rows.map(
        (c) =>
          "- " +
          c.text +
          (c.due_date ? " (due " + c.due_date + ")" : "") +
          " [" +
          c.status +
          "]"
      );
      return "Promises (" + status + "):\n" + lines.join("\n");
    }

    case "close_commitment": {
      const id = input.id as string | undefined;
      const status = input.status as "done" | "dropped" | undefined;
      if (!id || (status !== "done" && status !== "dropped")) {
        return "Give me the commitment id, and whether it is done or dropped.";
      }
      const row = await getCommitment(id);
      if (!row) {
        return "No commitment with that id. Call list_commitments to get a real one.";
      }
      await closeCommitment(id, status);
      return (
        (status === "done" ? "Marked done: " : "Dropped: ") +
        row.text +
        (row.item_id ? " (its todo was updated too)." : ".")
      );
    }

    case "open_loop": {
      const subject = (input.subject as string | undefined)?.trim();
      const thread = (input.thread as string | undefined)?.trim();
      if (!subject || !thread) {
        return "Tell me the person or project, and the open thread.";
      }
      const loop = await upsertLoop({
        subject,
        thread,
        state: (input.state as LoopState | undefined) ?? "open",
        waiting_on: (input.waiting_on as WaitingOn | undefined) ?? null,
        detail: input.detail as string | undefined,
        due_date: (input.due as string | undefined) ?? null,
        kind: (input.kind as LoopKind | undefined) ?? "topic",
        next_step: (input.next_step as string | undefined) ?? null,
      });
      const who =
        loop.waiting_on === "you"
          ? " - waiting on you"
          : loop.waiting_on === "them"
            ? " - waiting on them"
            : "";
      // A thread with no next step is half-recorded, so say so out loud instead of
      // reporting a tidy success.
      const next = loop.next_step
        ? " Next: " + loop.next_step
        : " No next step yet - propose one.";
      return "Thread tracked: " + loop.subject + " / " + loop.thread + who + "." + next;
    }

    case "update_loop": {
      const id = input.id as string | undefined;
      const state = input.state as LoopState | undefined;
      if (!id || (state !== "open" && state !== "waiting" && state !== "done")) {
        return "Give me the loop id and a state (open, waiting or done).";
      }
      const loop = await getLoop(id);
      if (!loop) {
        return "No loop with that id. Call list_loops to get a real one.";
      }
      // Anything beyond the state needs the full upsert (which also touches
      // last_touched_at, so a thread that moves does not go stale by accident).
      const wantsFields =
        input.detail !== undefined ||
        input.next_step !== undefined ||
        input.kind !== undefined;
      if (wantsFields) {
        await upsertLoop({
          subject: loop.subject,
          thread: loop.thread,
          state,
          waiting_on: (input.waiting_on as WaitingOn | undefined) ?? loop.waiting_on,
          detail: (input.detail as string | undefined) ?? loop.detail ?? undefined,
          kind: (input.kind as LoopKind | undefined) ?? loop.kind,
          next_step: (input.next_step as string | undefined) ?? loop.next_step,
        });
      } else {
        await setLoopState(
          id,
          state,
          (input.waiting_on as WaitingOn | undefined) ?? undefined
        );
      }
      return "Thread updated: " + loop.subject + " / " + loop.thread + " -> " + state + ".";
    }

    case "list_loops": {
      const subject = input.subject as string | undefined;
      const state = input.state as string | undefined;
      const rows = await listLoops({ subject, state, limit: 30 });
      if (!rows.length) {
        return state
          ? "No loops with state " + state + "."
          : "No open loops right now.";
      }
      const lines = rows.map(
        (l) =>
          "- [" +
          l.kind +
          "] " +
          l.subject +
          " / " +
          l.thread +
          " [" +
          l.state +
          (l.waiting_on ? " on " + l.waiting_on : "") +
          "]" +
          (l.due_date ? " (due " + l.due_date + ")" : "") +
          (l.next_step ? " - next: " + l.next_step : " - no next step yet")
      );
      return "Threads:\n" + lines.join("\n");
    }

    case "list_backlog": {
      const group = input.group as "stalled" | "unscheduled" | "ideas" | undefined;
      const backlog = await getBacklog();
      // Reuse the SAME formatter as the coach context rather than reimplementing
      // it, so the tool and the context can never drift apart. A group filter
      // simply empties the groups that were not asked for.
      const filtered: Backlog = {
        stalled: group && group !== "stalled" ? [] : backlog.stalled,
        unscheduled: group && group !== "unscheduled" ? [] : backlog.unscheduled,
        ideas: group && group !== "ideas" ? [] : backlog.ideas,
        empty: backlog.empty,
      };
      const block = formatBacklogForContext(filtered);
      if (!block) {
        return group
          ? "Nothing in the backlog under " + group + "."
          : "The backlog is empty - nothing has stalled and nothing is waiting.";
      }
      return block;
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
