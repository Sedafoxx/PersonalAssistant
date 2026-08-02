// Coding-agent worker: gives the assistant real file + shell + git access to a
// repo by exposing a tiny local HTTP API. Run it where your code lives:
//
//   npm run agent          (in the Codespace or on your laptop, repo root)
//
// It binds to 127.0.0.1 by default and every request must send the token:
//   Authorization: Bearer <CODING_AGENT_TOKEN>
//
// Env:
//   CODING_AGENT_PORT  (default 8787)
//   CODING_AGENT_HOST  (default 127.0.0.1)
//   CODING_AGENT_ROOT  (default process.cwd(); file ops are locked to this)
//   CODING_AGENT_TOKEN (if unset, a random one is generated and printed)
//
// Endpoints (POST with JSON body unless noted):
//   GET  /health
//   POST /read      { path }                 -> { path, content }
//   POST /write     { path, content }        -> { ok, path }
//   POST /list      { path }                 -> { entries: [{name,type,size}] }
//   POST /run       { command, cwd? }        -> { exitCode, stdout, stderr }
//   POST /git       { action, message? }     -> { exitCode, stdout, stderr }
//        action: status | diff | add | commit | push | log
//
// SECURITY: /run executes arbitrary shell commands and /write edits real files.
// That is the point of a coding agent, but it means ONLY run this on machines
// you trust, keep the token secret, and keep it on localhost.

import http from "node:http";
import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { exec, execFile } from "node:child_process";

const PORT = Number(process.env.CODING_AGENT_PORT ?? 8787);
const HOST = process.env.CODING_AGENT_HOST ?? "127.0.0.1";
const ROOT = path.resolve(process.env.CODING_AGENT_ROOT ?? process.cwd());
const TOKEN = process.env.CODING_AGENT_TOKEN ?? crypto.randomBytes(24).toString("hex");

const MAX_READ_BYTES = 512 * 1024; // 512 KB per file
const MAX_OUTPUT = 200 * 1024; // cap command output
const RUN_TIMEOUT_MS = 60_000;

function safeWithin(root, p) {
  const resolved = path.resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes repo root: ${p}`);
  }
  return resolved;
}

function authOk(req) {
  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function run(cmd, cwd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, env: process.env }, (err, stdout, stderr) => {
      resolve({
        exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? "").slice(0, MAX_OUTPUT),
        stderr: String(stderr ?? "").slice(0, MAX_OUTPUT),
      });
    });
  });
}

function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      resolve({
        exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? "").slice(0, MAX_OUTPUT),
        stderr: String(stderr ?? "").slice(0, MAX_OUTPUT),
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true, root: ROOT });
    }

    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

    const body = JSON.parse((await readBody(req)) || "{}");
    const url = (req.url ?? "").split("?")[0];

    if (url === "/read") {
      const file = safeWithin(ROOT, String(body.path ?? ""));
      const content = await readFile(file, "utf8");
      if (content.length > MAX_READ_BYTES) throw new Error("file too large to read");
      return sendJson(res, 200, { path: body.path, content });
    }

    if (url === "/write") {
      const file = safeWithin(ROOT, String(body.path ?? ""));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, String(body.content ?? ""), "utf8");
      return sendJson(res, 200, { ok: true, path: body.path });
    }

    if (url === "/list") {
      const dir = safeWithin(ROOT, String(body.path ?? "."));
      const names = await readdir(dir);
      const entries = [];
      for (const name of names) {
        try {
          const st = await stat(path.join(dir, name));
          entries.push({ name, type: st.isDirectory() ? "dir" : "file", size: st.size });
        } catch {
          entries.push({ name, type: "unknown", size: 0 });
        }
      }
      return sendJson(res, 200, { path: body.path, entries });
    }

    if (url === "/run") {
      const cwd = safeWithin(ROOT, String(body.cwd ?? "."));
      const result = await run(String(body.command ?? ""), cwd);
      return sendJson(res, 200, result);
    }

    if (url === "/git") {
      const cwd = ROOT;
      const action = String(body.action ?? "");
      let args = [];
      if (action === "status") args = ["status", "--short"];
      else if (action === "diff") args = ["diff"];
      else if (action === "add") args = ["add", "-A"];
      else if (action === "commit") args = ["commit", "-m", String(body.message ?? "")];
      else if (action === "push") args = ["push"];
      else if (action === "log") args = ["log", "--oneline", "-10"];
      else return sendJson(res, 400, { error: `unknown git action: ${action}` });
      if (action === "commit" && !body.message) {
        return sendJson(res, 400, { error: "commit requires a message" });
      }
      const result = await runGit(args, cwd);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    return sendJson(res, 500, { error: err instanceof Error ? err.message : "error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`coding-agent worker on http://${HOST}:${PORT}`);
  console.log(`repo root: ${ROOT}`);
  console.log(`token: ${TOKEN}`);
});
