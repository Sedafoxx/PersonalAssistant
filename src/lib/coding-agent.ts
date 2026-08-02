// Client for the coding-agent worker (scripts/coding-agent-server.mjs).
// The assistant's code_* tools call these; each returns a plain string the
// model can relay, and never throws. The worker must be running locally (where
// the repo lives) with CODING_AGENT_TOKEN set — otherwise the tools report that
// the coding agent is not available.

const BASE = process.env.CODING_AGENT_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.CODING_AGENT_TOKEN;

async function call<T>(endpoint: string, body: T): Promise<string> {
  if (!TOKEN) {
    return "Coding agent is not configured (set CODING_AGENT_TOKEN and run `npm run agent`).";
  }
  try {
    const res = await fetch(`${BASE}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) return `Coding agent error (HTTP ${res.status}): ${text}`;
    return text;
  } catch (e) {
    return `Coding agent worker unreachable (${e instanceof Error ? e.message : "unknown error"}). Start it in the repo with: npm run agent`;
  }
}

export function codeReadFile(path: string): Promise<string> {
  return call("/read", { path });
}

export function codeWriteFile(path: string, content: string): Promise<string> {
  return call("/write", { path, content });
}

export function codeListDir(path: string): Promise<string> {
  return call("/list", { path });
}

export function codeRunCommand(command: string, cwd?: string): Promise<string> {
  return call("/run", { command, cwd: cwd ?? "." });
}

export function codeGit(action: string, message?: string): Promise<string> {
  return call("/git", { action, message: message ?? "" });
}
