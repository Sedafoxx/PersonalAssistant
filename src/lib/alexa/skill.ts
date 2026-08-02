import {
  SkillBuilders,
  RequestHandler,
  ErrorHandler,
  HandlerInput,
} from "ask-sdk-core";
import type { Response } from "ask-sdk-model";
import {
  getList,
  addToList,
  removeFromList,
  clearChecked,
  clearList,
  type ListKind,
} from "../lists";
import { runAssistant } from "../chat";

// ---------------------------------------------------------------------------
// Slot helpers
// ---------------------------------------------------------------------------

// Returns the canonical resolved slot value when Alexa maps a synonym (e.g.
// "groceries" -> "grocery"), falling back to the raw spoken value for
// free-text slots like Item / Query.
function slotValue(input: HandlerInput, name: string): string | null {
  const request = input.requestEnvelope.request;
  if (request.type !== "IntentRequest") return null;
  const slot = request.intent?.slots?.[name];
  if (!slot) return null;
  const resolved =
    slot.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name;
  return resolved ?? slot.value ?? null;
}

function parseListType(raw: string | null): ListKind {
  const v = raw?.trim().toLowerCase() ?? "";
  if (v.includes("shop") || v.includes("household")) return "shopping";
  // grocery, groceries, supermarket, food, or missing -> default to grocery
  return "grocery";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

class LaunchHandler implements RequestHandler {
  canHandle(input: HandlerInput): boolean {
    return input.requestEnvelope.request.type === "LaunchRequest";
  }
  handle(input: HandlerInput): Response {
    return input.responseBuilder
      .speak(
        "Welcome to your personal assistant. You can add, remove, or check your grocery and shopping lists by voice. For example, say add milk to my grocery list, or ask me anything else you'd normally type in the app."
      )
      .reprompt("What would you like to do?")
      .getResponse();
  }
}

class AddToListHandler implements RequestHandler {
  canHandle(input: HandlerInput): boolean {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      input.requestEnvelope.request.intent?.name === "AddToListIntent"
    );
  }
  async handle(input: HandlerInput): Promise<Response> {
    const item = slotValue(input, "Item");
    const list = parseListType(slotValue(input, "ListType"));
    if (!item) {
      return input.responseBuilder
        .speak(
          "Sorry, I didn't catch what you want to add. Try saying add milk to my grocery list."
        )
        .reprompt("What should I add to the list?")
        .getResponse();
    }
    const { added, item: created } = await addToList(list, item);
    return input.responseBuilder
      .speak(
        added
          ? `Okay, I added ${created?.name ?? item} to your ${list} list.`
          : `${item} is already on your ${list} list.`
      )
      .getResponse();
  }
}

class ViewListHandler implements RequestHandler {
  canHandle(input: HandlerInput): boolean {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      input.requestEnvelope.request.intent?.name === "ViewListIntent"
    );
  }
  async handle(input: HandlerInput): Promise<Response> {
    const list = parseListType(slotValue(input, "ListType"));
    const items = await getList(list);
    if (items.length === 0) {
      return input.responseBuilder
        .speak(`Your ${list} list is empty.`)
        .getResponse();
    }
    const names = items.map((i) => i.name);
    const shown = names.slice(0, 20).join(", ");
    const extra =
      names.length > 20 ? `, and ${names.length - 20} more.` : ".";
    return input.responseBuilder
      .speak(`On your ${list} list: ${shown}${extra}`)
      .getResponse();
  }
}

class RemoveFromListHandler implements RequestHandler {
  canHandle(input: HandlerInput): boolean {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      input.requestEnvelope.request.intent?.name === "RemoveFromListIntent"
    );
  }
  async handle(input: HandlerInput): Promise<Response> {
    const item = slotValue(input, "Item");
    const list = parseListType(slotValue(input, "ListType"));
    if (!item) {
      return input.responseBuilder
        .speak(
          "Sorry, I didn't catch what you want to remove. Try saying remove milk from my grocery list."
        )
        .reprompt("What should I remove from the list?")
        .getResponse();
    }
    const removed = await removeFromList(list, item);
    return input.responseBuilder
      .speak(
        removed
          ? `Okay, I removed ${item} from your ${list} list.`
          : `I couldn't find ${item} on your ${list} list.`
      )
      .getResponse();
  }
}

// "clear my list" -> remove everything (checked AND unchecked).
class ClearListHandler implements RequestHandler {
  canHandle(input: HandlerInput): boolean {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      input.requestEnvelope.request.intent?.name === "ClearListIntent"
    );
  }
  async handle(input: HandlerInput): Promise<Response> {
    const list = parseListType(slotValue(input, "ListType"));
    const removed = await clearList(list);
    return input.responseBuilder
      .speak(
        removed > 0
          ? `I cleared ${removed} item${removed === 1 ? "" : "s"} from your ${list} list.`
          : `Your ${list} list was already empty.`
      )
      .getResponse();
  }
}

// "I bought everything" -> only remove checked-off items.
class ClearCheckedHandler implements RequestHandler {
  canHandle(input: HandlerInput): boolean {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      input.requestEnvelope.request.intent?.name === "ClearCheckedIntent"
    );
  }
  async handle(input: HandlerInput): Promise<Response> {
    const list = parseListType(slotValue(input, "ListType"));
    const removed = await clearChecked(list);
    return input.responseBuilder
      .speak(
        removed > 0
          ? `Great, I cleared ${removed} checked-off item${removed === 1 ? "" : "s"} from your ${list} list.`
          : `There were no checked-off items on your ${list} list to clear.`
      )
      .getResponse();
  }
}

// Free-form requests go to the same LLM brain the web app uses.
class AssistantQueryHandler implements RequestHandler {
  canHandle(input: HandlerInput): boolean {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      input.requestEnvelope.request.intent?.name === "AssistantQueryIntent"
    );
  }
  async handle(input: HandlerInput): Promise<Response> {
    const query = slotValue(input, "Query");
    if (!query) {
      return input.responseBuilder
        .speak(
          "Sorry, I didn't catch that. You can say add milk to my grocery list, what's on my shopping list, or ask me to create a todo or check your calendar."
        )
        .getResponse();
    }
    try {
      const reply = await runAssistant([{ role: "user", content: query }]);
      const text = reply.split("[[CHOICES]]")[0].trim();
      // Strip markdown-ish formatting so the spoken output stays clean.
      const spoken = text
        .replace(/^[-*]\s+/gm, "")
        .replace(/[#*_`>]/g, "")
        .trim();
      return input.responseBuilder.speak(spoken || "Done.").getResponse();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "something went wrong";
      return input.responseBuilder
        .speak(`I hit an error: ${msg}`)
        .getResponse();
    }
  }
}

class FallbackHandler implements RequestHandler {
  canHandle(input: HandlerInput): boolean {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      input.requestEnvelope.request.intent?.name === "AMAZON.FallbackIntent"
    );
  }
  handle(input: HandlerInput): Response {
    return input.responseBuilder
      .speak(
        "I didn't quite get that. Try something like: add milk to my grocery list, what's on my shopping list, or ask me to create a todo."
      )
      .reprompt("What would you like me to do?")
      .getResponse();
  }
}

class HelpHandler implements RequestHandler {
  canHandle(input: HandlerInput): boolean {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      input.requestEnvelope.request.intent?.name === "AMAZON.HelpIntent"
    );
  }
  handle(input: HandlerInput): Response {
    return input.responseBuilder
      .speak(
        "You can manage your grocery and shopping lists by voice. Say add milk to my grocery list, remove milk from my list, what's on my shopping list, or clear my grocery list. You can also ask me anything you'd normally type into the app, like add a reminder or check my calendar."
      )
      .reprompt("What would you like to do?")
      .getResponse();
  }
}

class CancelAndStopHandler implements RequestHandler {
  canHandle(input: HandlerInput): boolean {
    const request = input.requestEnvelope.request;
    return (
      request.type === "IntentRequest" &&
      (request.intent?.name === "AMAZON.StopIntent" ||
        request.intent?.name === "AMAZON.CancelIntent")
    );
  }
  handle(input: HandlerInput): Response {
    return input.responseBuilder.speak("Goodbye.").getResponse();
  }
}

class SessionEndedHandler implements RequestHandler {
  canHandle(input: HandlerInput): boolean {
    return input.requestEnvelope.request.type === "SessionEndedRequest";
  }
  handle(input: HandlerInput): Response {
    return input.responseBuilder.getResponse();
  }
}

class CatchAllErrorHandler implements ErrorHandler {
  canHandle(input: HandlerInput, error: Error): boolean {
    void input;
    void error;
    return true;
  }
  handle(input: HandlerInput, error: Error): Response {
    console.error("alexa skill error:", error);
    return input.responseBuilder
      .speak("Sorry, something went wrong. Please try again.")
      .getResponse();
  }
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export const alexaSkill = SkillBuilders.custom()
  .addRequestHandlers(
    new LaunchHandler(),
    new AddToListHandler(),
    new ViewListHandler(),
    new RemoveFromListHandler(),
    new ClearListHandler(),
    new ClearCheckedHandler(),
    new AssistantQueryHandler(),
    new FallbackHandler(),
    new HelpHandler(),
    new CancelAndStopHandler(),
    new SessionEndedHandler()
  )
  .addErrorHandlers(new CatchAllErrorHandler())
  .create();
