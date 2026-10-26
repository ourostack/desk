"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

// Session-end hooks hand their work to a detached copy of themselves and exit. On a loaded machine starting Node, loading
// Desk's modules and running Git can take longer than the host's hook timeout (3 s on Copilot), and nothing the host does
// with the hook's result depends on that work.
const WRITE_WAIT_MS = 1000;
// A detached worker that hangs would outlive the session unseen, so it stops itself after this long.
const WORKER_LIMIT_MS = 60_000;

// On Windows every process Node starts inherits all of its parent's inheritable handles, including the output pipe of
// the PowerShell that runs a Copilot hook, so a detached worker would hold that pipe open and the host would wait for the
// worker to finish. With `--spool` (Copilot's PowerShell commands) the hook only writes its work here, and the command's
// own `Start-Process` runs this file, which inherits nothing, to start the workers.
const SPOOL_FLAG = "--spool";
const spoolDir = () => path.join(os.tmpdir(), "desk-hook-spool");
// The only files the spool may start, so a file dropped in the shared temp folder cannot name another program.
const ENTRIES = new Set(["factory-end.cjs", "sync-end.cjs"]);
// Work older than this is from a session whose start command never ran; it is dropped rather than run late.
const SPOOL_MAX_AGE_MS = 10 * 60_000;

function spawnDetached(entry, args, payload, { env, waitMs, cwd }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [entry, ...args], { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true, env, cwd });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.unref();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), waitMs);
    child.once("error", () => done(false));
    child.stdin.on("error", () => done(false));
    child.stdin.end(JSON.stringify(payload), () => done(true));
  });
}

function writeSpool(entry, args, payload) {
  if (path.dirname(entry) !== path.resolve(__dirname, "..") || !ENTRIES.has(path.basename(entry))) return false;
  try {
    fs.mkdirSync(spoolDir(), { recursive: true });
    const record = { entry: path.basename(entry), args, cwd: process.cwd(), payload, at: Date.now() };
    fs.writeFileSync(path.join(spoolDir(), `${randomUUID()}.json`), JSON.stringify(record), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts `node entry ...args` detached with `payload` as its stdin; resolves `true` once the payload is handed over. With
 * `spool` it only records that work for `drainSpool`. Never throws.
 */
async function startDetached(entry, args, payload, { env = process.env, waitMs = WRITE_WAIT_MS, spool = process.argv.includes(SPOOL_FLAG) } = {}) {
  if (spool && writeSpool(entry, args, payload)) return true;
  return spawnDetached(entry, args, payload, { env, waitMs });
}

/** Starts every worker waiting in the spool, each exactly once however many drains run at the same time. Never throws. */
async function drainSpool({ env = process.env, now = Date.now() } = {}) {
  let names;
  try { names = fs.readdirSync(spoolDir()).filter((name) => name.endsWith(".json")); } catch { return 0; }
  let started = 0;
  for (const name of names) {
    const claimed = path.join(spoolDir(), `${name}.${process.pid}`);
    let record;
    try {
      fs.renameSync(path.join(spoolDir(), name), claimed);
      record = JSON.parse(fs.readFileSync(claimed, "utf8"));
    } catch { continue; } finally { try { fs.unlinkSync(claimed); } catch { /* another drain claimed it */ } }
    if (!ENTRIES.has(record?.entry) || !Array.isArray(record.args) || !(now - record.at < SPOOL_MAX_AGE_MS)) continue;
    const cwd = typeof record.cwd === "string" && fs.existsSync(record.cwd) ? record.cwd : os.homedir();
    if (await spawnDetached(path.join(__dirname, "..", record.entry), record.args.map(String), record.payload, { env, waitMs: WRITE_WAIT_MS, cwd })) started++;
  }
  return started;
}

/** Called first in a detached worker: ends the process after `WORKER_LIMIT_MS` whatever it is doing. */
function limitWorker(ms = WORKER_LIMIT_MS) {
  setTimeout(() => process.exit(0), ms).unref();
}

if (require.main === module) drainSpool().then(() => process.exit(0), () => process.exit(0));

module.exports = { startDetached, limitWorker };
