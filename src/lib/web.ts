// Live web access for the assistant: web search (Tavily) and page reading.
// Used by the search_web / fetch_url tools. Best-effort — always return a
// string the model can relay, never throw.

const TAVILY_URL = "https://api.tavily.com/search";

export async function searchWeb(query: string, maxResults = 5): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return "Web search is not configured (TAVILY_API_KEY missing).";
  try {
    const res = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: "basic",
      }),
    });
    if (!res.ok) return `Web search failed (HTTP ${res.status})`;
    const data = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };
    const results = data.results ?? [];
    if (results.length === 0) return "No results found.";
    return results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title ?? ""}\n   ${r.url ?? ""}\n   ${(r.content ?? "").slice(0, 1000)}`
      )
      .join("\n");
  } catch (e) {
    return `Web search failed: ${e instanceof Error ? e.message : "unknown error"}`;
  }
}

export async function fetchPageText(url: string, maxChars = 20000): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
      redirect: "follow",
    });
    if (!res.ok) return `Failed to fetch ${url} (HTTP ${res.status})`;
    const html = await res.text();
    const text = htmlToText(html);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
  } catch (e) {
    return `Failed to fetch ${url}: ${e instanceof Error ? e.message : "unknown error"}`;
  }
}

// Crude but effective HTML → readable text: strip scripts/styles/tags, decode
// the common entities, and collapse whitespace.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&/gi, "&")
    .replace(/</gi, "<")
    .replace(/>/gi, ">")
    .replace(/"/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
