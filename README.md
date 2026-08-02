# PersonalAssistant

Personal AI assistant project.

## Alexa (Echo Dot) voice control

An Alexa skill backend lives in this repo so an Echo Dot can talk to the same
assistant brain the web app uses — lists, todos, calendar, goals.

- Say: _"Alexa, tell personal assistant to add milk to my grocery list"_
- All intents/sample utterances live in `skill-package/` (no Alexa console
  editing needed).
- Full setup + the 3 manual steps (Vercel deploy, Amazon login, enable) are in
  **`ALEXA_SETUP.md`**.
- Local test without an Echo: `npm run ask:smoke`

## LLM provider (OpenAI → DeepSeek)

The assistant brain in `src/lib/chat.ts` is provider-agnostic. It calls any
**OpenAI-compatible** chat endpoint based on three env vars:

| Env var | To use DeepSeek |
|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com` |
| `LLM_API_KEY` | your DeepSeek API key (from platform.deepseek.com) |
| `LLM_MODEL` | `deepseek-chat` |

Defaults (if unset): OpenAI (`https://api.openai.com/v1`, `gpt-4o`, key from
`OPENAI_API_KEY`). Set these in `.env.local` for local dev and in the Vercel
project's environment variables, then redeploy.

Notes:
- Use **`deepseek-chat`** (V3), not `deepseek-reasoner` (R1) — R1 does not
  support the function/tool calling this assistant relies on.
- **Embeddings** (`src/lib/embeddings.ts`) and **voice transcription**
  (`src/app/api/transcribe/route.ts`) stay on OpenAI — DeepSeek offers no
  embedding or speech-to-text API, and the pgvector column is sized for
  `text-embedding-3-small` (1536 dims).

## Web search, file upload & conversation memory

- **Web search** — the assistant can call `search_web` (Tavily) and `fetch_url`
  (read a page) for current/live info. Set `TAVILY_API_KEY` (free tier at
  tavily.com) in `.env.local` and in Vercel. Without a key it replies
  "web search is not configured".
- **File upload** — the 📎 button in the chat attaches a file. Plain-text files
  (txt/md/csv/json/code) are read client-side; **PDF/DOCX** are parsed
  server-side at `/api/upload` (via `pdf-parse` + `mammoth`). The file's text is
  fed to the model as context.
- **Conversation memory** — each browser keeps a persistent `client_id`
  (localStorage). Chat history is stored per client in `chat_messages`, and the
  last ~40 turns are loaded with every request, so the assistant remembers the
  conversation across page reloads. Migration `0007_conversation_memory.sql`
  adds the `client_id` column (`npm run migrate`).
