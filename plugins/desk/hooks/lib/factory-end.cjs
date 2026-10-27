"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
// Loaded only when a worker starts: the Stop hook runs after every turn.
const compatibleNode = (options) => require("../compatible-node.cjs").compatibleNode(options);
const ownRoot = path.resolve(__dirname, "..", "..");
const headless = (env) => { try { return require("../../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(env); } catch { const v = String(env?.DESK_FACTORY_HEADLESS ?? ""); return v !== "" && v !== "0"; } };
const { limitWorker, startDetached } = require("./detach-worker.cjs");
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

// Outbox counts a lock as abandoned only after 10 minutes, but its holder here is a capture that stops itself after 60 s
// (detach-worker.cjs) and holds the lock for milliseconds. A capture killed inside that section (its own time limit, which skips
// cleanup, a crash or a forced kill) would leave every later capture for the session waiting until it gives up, and a session
// end in that window would never be recorded. The lock file names its holder's process (outbox.js withLock), so while waiting
// this removes a lock whose holder is gone, or one still without a holder after far longer than writing it takes.
const LOCK_SWEEP_MS = 200;
// Outbox creates the lock and then writes the holder's process id. A holder whose event loop is blocked in between (the session-end
// worker runs Git synchronously, up to 10 s per call) still holds it, so only a lock unnamed for this long is abandoned.
const LOCK_UNNAMED_MS = 30_000;

function holderGone(text, stat) {
  let pid;
  try { pid = JSON.parse(text).pid; } catch { /* not written yet */ }
  if (!Number.isSafeInteger(pid) || pid <= 0) return Date.now() - Number(stat.mtimeMs) > LOCK_UNNAMED_MS;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM: the process exists but is not ours to signal.
    return error.code === "ESRCH";
  }
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs;

function clearAbandonedLock(lockFile) {
  let before;
  try {
    before = fs.statSync(lockFile, { bigint: true });
    if (!holderGone(fs.readFileSync(lockFile, "utf8"), before)) return;
  } catch { return; /* gone already: outbox's own wait applies */ }
  // Another waiter may judge the same lock, remove it and take its own in the instant before this one removes it. Moving the
  // lock aside is atomic, so this waiter then holds exactly one file, and removes it only if it is the lock it judged.
  const aside = `${lockFile}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.stale`;
  try { fs.renameSync(lockFile, aside); } catch { return; /* already moved or removed by another waiter */ }
  try {
    if (sameFile(fs.statSync(aside, { bigint: true }), before)) {
      fs.unlinkSync(aside);
      return;
    }
    // Another waiter's live lock: put it back without replacing anything created there since (a link never overwrites).
    fs.linkSync(aside, lockFile);
    fs.unlinkSync(aside);
  } catch {
    try { if (!fs.existsSync(lockFile)) fs.renameSync(aside, lockFile); } catch { /* cannot be put back without risking a newer lock */ }
  }
}

async function withAbandonedLockCleared(lockFile, body) {
  clearAbandonedLock(lockFile);
  const sweep = setInterval(() => clearAbandonedLock(lockFile), LOCK_SWEEP_MS);
  try {
    return await body();
  } finally {
    clearInterval(sweep);
  }
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
    // On Copilot, the payload's cwd: the folder the server records for the session (copilot-session.js), so both pick the same desk.
    // Copilot 1.0.12 and later also set CLAUDE_PROJECT_DIR for plugin hooks; older ones do not.
    const { root: deskRoot } = resolveHookDeskRoot({ env, cwd: payload.cwd, hostProjectRoot: claude || codex ? env.CLAUDE_PROJECT_DIR : payload.cwd });
    if (deskRoot === null) return "unavailable";
    const { metadata } = require("../../mcp/src/factory/plugin-sources.cjs");
    const { plugins, dirs, incomplete } = metadata({ host, pluginRoot, home, env, readSmallText, PATTERNS, sourceDeadline: performance.now() + SOURCE_BUDGET_MS });
    const ended = event === "SessionEnd" || event === "sessionEnd";
    const at = !claude && Number.isSafeInteger(payload.timestamp) && payload.timestamp >= 0 ? new Date(payload.timestamp).toISOString() : new Date().toISOString();
    const agency = path.join(home, ".local", "agency", "plugins", "sessions") + path.sep;
    let routing = resolveStore({ deskRoot, pluginDirs: dirs, read: (file) => readSmallText(file) });
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
    // A turn's capture runs detached, so it can land after the session's end is recorded (a session that ends right after a turn,
    // as every `-p` run does). It must never undo that end: the read and the write share one lock per session, and a capture with
    // no end keeps the end already recorded. Later activity in a resumed session still reopens it when derived (session-lifetime).
    // Only a missing record has no end: a record that exists but cannot be read or checked (a failed Windows permission step, a file
    // that changed under the read) may hold one, so that capture leaves it as it is.
    const lockName = `marker-${marker.host}-${id}`;
    const stateRoot = await outbox.factoryStateRoot(env);
    let kept = false;
    await withAbandonedLockCleared(path.join(stateRoot, "locks", `${lockName}.lock`), () => outbox.withNamedLock(env, lockName, async () => {
      if (!ended) {
        const file = path.join(stateRoot, "markers", `${marker.host}-${id}.json`);
        let recorded = null;
        try {
          recorded = await outbox.readMarker(env, file);
          kept = recorded === null;
        } catch (error) {
          kept = error?.code !== "ENOENT";
        }
        if (kept) return;
        if (recorded?.ended_at) Object.assign(marker, { end_reason: recorded.end_reason, ended_at: recorded.ended_at });
      }
      await outbox.writeMarker(env, marker);
    }, { deskRoot }));
    // Codex gives SessionEnd at most 3 s (codex-rs/hooks/src/events/session_end.rs#L20-L24), so this hook only records the marker; the next session-start sweep derives it.
    if (codex) return "written";
    const { improvementPerson } = await import("../../mcp/src/desk/improvement-person.js");
    let person;
    try { person = await improvementPerson({ deskRoot, env }); } catch { /* no positive person */ }
    const scope = person?.status === "ok" ? { deskRoot, personPrefix: person.personPrefix } : null;
    const workerEnv = { ...env };
    if (scope === null) delete workerEnv.DESK_FACTORY_LOOP_SCOPE;
    else workerEnv.DESK_FACTORY_LOOP_SCOPE = JSON.stringify(scope);
    const script = path.join(ownRoot, "mcp", "scripts", "factory.js");
    // One Node search per hook run, however many jobs it starts.
    let resolved;
    const resolveOnce = (options) => (resolved ??= compatibleNode(options));
    if (ended) {
      const root = await outbox.factoryStateRoot(env);
      await start(script, ["derive", "--marker", path.join(root, "markers", `${marker.host}-${id}.json`), "--wait-quiet", "30000"], env, resolveOnce);
    } else if (supportsFinalize ?? cli.SUPPORTED_COMMANDS.includes("finalize")) {
      const jobs = await outbox.listFinalizeJobs(env);
      for (const job of jobs) await start(script, ["finalize", "--job", job], workerEnv, resolveOnce);
      // A finalize run starts the loop worker itself once it has derived the job's sessions; with none pending, the end of a turn
      // starts it when the evaluator step is due (a request newer than its last run, or requests waiting past its gap), or when a task context evaluation is due.
      if (jobs.length === 0) await kickAtTurnEnd(workerEnv, start, resolveOnce, scope);
    }
    return kept ? "kept" : "written";
  } catch {
    // Accounting remains fail-open. The separate wrapper reply check never changes these markers.
    return "unavailable";
  }
}

// Starts the loop launcher (hooks/loop-start.cjs) through the same detached launch as every other hook job, only when evaluate-kick.js says the evaluator step is due.
async function kickAtTurnEnd(env, start, resolveOnce, scope) {
  const { kickLoop } = await import("../../mcp/src/factory/evaluate-kick.js");
  await kickLoop(env, { scope, spawn: async (_node, args, options) => {
    await start(args[0], args.slice(1), options.env, resolveOnce);
    return {};
  } });
}

// Session end needs no reply from the hook (the delivery check only answers a turn's stop), so its work runs detached and
// the hook exits at once: on a loaded machine it can take longer than the host's hook timeout (see detach-worker.cjs).
function sessionEnded(host, payload) {
  return host === "copilot" ? !Object.hasOwn(payload, "stopReason") && Object.hasOwn(payload, "reason") : payload.hook_event_name === "SessionEnd";
}

// How long a turn's end may wait for the delivery check, counted from the hook's own start.
const DEADLINE_MS = 1500;

// The capture (marker, finalize jobs, loop kick) never changes the hook's answer, and loading Desk's MCP modules for it was almost
// all of the bounded child's time (about 200 ms of 206 on macOS; Windows is several times slower and ran past the deadline on most
// turns). So it always runs detached, and at a turn's end the bounded child runs only the delivery check, whose answer the host uses.
async function runBoundedHook(host, input, entry, { deadlineMs = DEADLINE_MS, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  if (headless(env)) return;
  const deadline = Date.now() + deadlineMs;
  const payload = await readInput(input);
  if (payload === null || Date.now() >= deadline) return;
  const capture = startDetached(entry, [host, "--factory-worker", "--detached"], payload, { env });
  if (sessionEnded(host, payload)) {
    await capture;
    return;
  }
  // A separate process makes the deadline effective even during synchronous OS calls.
  const check = new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, host, "--factory-worker"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env,
    });
    let output = "", diagnostic = "", timedOut = false, spawnError = null;
    child.stdout.on("data", chunk => { if (output.length < 16384) output += chunk; });
    child.stderr.on("data", chunk => { if (diagnostic.length < 2048) diagnostic += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Math.max(0, deadline - Date.now()));
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        if (diagnostic) stderr.write(diagnostic.slice(0, 2048));
        try {
          const value = JSON.parse(output);
          if (value?.decision === "block" && typeof value.reason === "string" && value.reason.includes("[DESK_DELIVERY_CORRECTION]")) stdout.write(JSON.stringify(value));
        } catch { /* Accounting produces no stdout when no correction is due. */ }
      } else {
        const why = timedOut ? "deadline" : spawnError ? `spawn ${spawnError.code ?? "error"}` : signal ? `signal ${signal}` : `exit ${code}`;
        stderr.write(`[desk-delivery] unverified: hook_worker_unavailable (${why})\n`);
      }
      resolve();
    };
    child.once("error", (error) => { spawnError = error; finish(null, null); });
    child.once("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
  await Promise.all([capture, check]);
}

// The command line of the entry file `hooks/factory-end.cjs`, which is the file hosts register and the worker process runs again.
// `--factory-worker --detached` is the capture, `--factory-worker` alone the bounded delivery check.
function main(entry, argv = process.argv, stdin = process.stdin) {
  const detached = argv[4] === "--detached";
  if (detached) limitWorker();
  const work = argv[3] === "--factory-worker"
    ? readInput(stdin, detached ? 5000 : undefined).then(async (payload) => {
      if (detached) {
        await runHook({ host: argv[2], payload });
        return;
      }
      const delivery = await checkDelivery({ host: argv[2], payload }).catch(() => ({ diagnostic: "guard_unavailable" }));
      if (delivery.diagnostic) process.stderr.write(`[desk-delivery] unverified: ${delivery.diagnostic}\n`);
      if (delivery.output) process.stdout.write(JSON.stringify(delivery.output));
    })
    : runBoundedHook(argv[2], stdin, entry);
  work.then(() => process.exit(0), () => process.exit(0));
}

const checkDelivery = options => require("./delivery-stop.cjs").checkDelivery(options);
module.exports = { readInput, runHook, runBoundedHook, launch, main };
