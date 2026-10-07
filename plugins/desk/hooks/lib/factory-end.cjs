"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
// Loaded only when a worker starts: the Stop hook runs after every turn.
const compatibleNode = (options) => require("../compatible-node.cjs").compatibleNode(options);
const ownRoot = path.resolve(__dirname, "..", "..");
const headless = (env) => { try { return require("../../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(env); } catch { const v = String(env?.DESK_FACTORY_HEADLESS ?? ""); return v !== "" && v !== "0"; } };
const MAX_INPUT = 1024 * 1024;

async function readInput(stream, timeoutMs = 150) {
  return new Promise((resolve) => {
    let bytes = 0;
    const chunks = [];
    const finish = (value) => {
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
      stream.pause();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    stream.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT) finish(null);
      else chunks.push(Buffer.from(chunk));
    });
    stream.once("error", () => finish(null));
    stream.once("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        finish(value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);
      } catch {
        finish(null);
      }
    });
  });
}

// factory.js loads Desk's MCP code, so it runs in a Node that satisfies the
// MCP's engines range, never simply in the hook's own Node. With none
// installed nothing starts, and the retained marker is the retry path.
async function launch(script, args, env, resolveNode = compatibleNode) {
  const { node } = resolveNode({ env });
  if (!node) return;
  await new Promise((resolve, reject) => {
    const child = spawn(node, [script, ...args], { detached: true, stdio: "ignore", windowsHide: true, env });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

// How long the Stop hook may spend finding install sources before it names none.
const SOURCE_BUDGET_MS = 400;

// A Codex thread spawned by another thread is not a session. SessionEnd never fires for one, but a payload or rollout that names a parent is refused anyway.
function childThread(payload, log) {
  if (payload.parent_thread_id || payload.source?.subagent) return true;
  try {
    const fd = fs.openSync(log, "r");
    try {
      const buffer = Buffer.alloc(65536);
      const text = buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, buffer.length, 0));
      const meta = JSON.parse(text.split("\n")[0])?.payload;
      return Boolean(meta?.parent_thread_id || meta?.source?.subagent);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

async function runHook({ host, payload, env = process.env, pluginRoot = ownRoot, launch: start = launch, supportsFinalize } = {}) {
  try {
    // A headless evaluator session is never captured: no marker, no derive.
    if (headless(env)) return "headless";
    const [{ absolutePath, readSmallText, validMarker }, { ENUMS, PATTERNS, isPlainObject }] = await Promise.all([
      import("../../mcp/src/factory/marker.js"), import("../../mcp/src/factory/schema.js"),
    ]);
    if (!["claude", "copilot", "codex"].includes(host) || !isPlainObject(payload)) return "invalid";
    const claude = host === "claude";
    const codex = host === "codex";
    // Codex fires only SessionEnd, root thread only (openai/codex 60947e2, codex-rs/core/src/hook_runtime.rs#L471-L499). Its stdin is session_id, transcript_path (the rollout, or null), cwd, hook_event_name and reason (codex-rs/hooks/src/schema.rs#L512-L523).
    const event = claude || codex ? payload.hook_event_name : Object.hasOwn(payload, "stopReason") ? "agentStop" : Object.hasOwn(payload, "reason") ? "sessionEnd" : null;
    if (!(codex ? ["SessionEnd"] : claude ? ["Stop", "SessionEnd"] : ["agentStop", "sessionEnd"]).includes(event)) return "invalid";
    const id = claude || codex ? payload.session_id : payload.sessionId;
    if (typeof id !== "string" || !PATTERNS.sessionId.test(id) || !absolutePath(payload.cwd)) return "invalid";
    const home = env.HOME || os.homedir();
    const log = claude || codex ? payload.transcript_path : path.join(env.COPILOT_HOME || path.join(home, ".copilot"), "session-state", id, "events.jsonl");
    if (!absolutePath(log)) return "invalid";
    if (codex && childThread(payload, log)) return "invalid";
    const [{ resolveHookDeskRoot }, outbox, { resolveStore }, cli] = await Promise.all([
      import("../../mcp/scripts/resolve-desk-root.js"), import("../../mcp/src/factory/outbox.js"), import("../../mcp/src/factory/store-route.js"), import("../../mcp/scripts/factory.js"),
    ]);
    const { root: deskRoot } = resolveHookDeskRoot({ env, cwd: payload.cwd });
    if (deskRoot === null) return "unavailable";
    const { metadata } = require("../../mcp/src/factory/plugin-sources.cjs");
    const { plugins, dirs, incomplete } = metadata({ host, pluginRoot, home, env, readSmallText, PATTERNS, sourceDeadline: performance.now() + SOURCE_BUDGET_MS });
    const ended = event === "SessionEnd" || event === "sessionEnd";
    const at = !claude && Number.isSafeInteger(payload.timestamp) && payload.timestamp >= 0 ? new Date(payload.timestamp).toISOString() : new Date().toISOString();
    const agency = path.join(home, ".local", "agency", "plugins", "sessions") + path.sep;
    let routing = deskRoot === null ? { store: null, source: "invalid_declaration", warnings: [] } : resolveStore({ deskRoot, pluginDirs: dirs, read: (file) => readSmallText(file) });
    if (incomplete && routing.source !== "desk") routing = { store: null, source: "invalid_declaration", warnings: routing.warnings };
    const marker = {
      schema_version: 1, host: claude ? "claude-code" : codex ? "codex-cli" : "copilot-cli", session_id: id,
      log_path: log, cwd: payload.cwd, desk_root: deskRoot,
      end_reason: ended ? ENUMS.endReason.includes(payload.reason) ? payload.reason : "other" : null,
      ended_at: ended ? at : null, plugins, updated_at: new Date().toISOString(),
      entrypoint: claude || codex ? "unknown" : path.resolve(pluginRoot).startsWith(agency) ? "launcher" : "cli",
      person_prefix: env.DESK_PERSON ? `desks/${env.DESK_PERSON.trim()}` : "",
      routing,
    };
    if (!validMarker(marker)) return "invalid";
    await outbox.writeMarker(env, marker);
    // Codex gives SessionEnd at most 3 s (codex-rs/hooks/src/events/session_end.rs#L20-L24), so this hook only records the marker; the next session-start sweep derives it.
    if (codex) return "written";
    const script = path.join(ownRoot, "mcp", "scripts", "factory.js");
    // One Node search per hook run, however many jobs it starts.
    let resolved;
    const resolveOnce = (options) => (resolved ??= compatibleNode(options));
    if (ended) {
      const root = await outbox.factoryStateRoot(env);
      await start(script, ["derive", "--marker", path.join(root, "markers", `${marker.host}-${id}.json`), "--wait-quiet", "30000"], env, resolveOnce);
    } else if (supportsFinalize ?? cli.SUPPORTED_COMMANDS.includes("finalize")) {
      for (const job of await outbox.listFinalizeJobs(env)) await start(script, ["finalize", "--job", job], env, resolveOnce);
    }
    return "written";
  } catch {
    // Hooks cannot veto lifecycle events. The retained marker is the retry path.
    return "unavailable";
  }
}

async function runBoundedHook(host, input, entry) {
  if (headless(process.env)) return;
  const deadline = Date.now() + 1500;
  const payload = await readInput(input);
  if (payload === null || Date.now() >= deadline) return;
  // A separate process makes the unchanged deadline effective even during synchronous OS calls.
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, host, "--factory-worker"], {
      stdio: ["pipe", "ignore", "ignore"], windowsHide: true, env: process.env,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(0, deadline - Date.now()));
    const finish = () => { clearTimeout(timer); resolve(); };
    child.once("error", finish);
    child.once("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

// The command line of the entry file `hooks/factory-end.cjs`, which is the file hosts register and the worker process runs again.
function main(entry, argv = process.argv, stdin = process.stdin) {
  const work = argv[3] === "--factory-worker"
    ? readInput(stdin).then((payload) => runHook({ host: argv[2], payload }))
    : runBoundedHook(argv[2], stdin, entry);
  work.then(() => process.exit(0), () => process.exit(0));
}

module.exports = { readInput, runHook, launch, main };
