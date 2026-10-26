"use strict";

const { spawn } = require("node:child_process");

// Session-end hooks hand their work to a detached copy of themselves and exit. On a loaded machine starting Node, loading
// Desk's modules and running Git can take longer than the host's hook timeout (3 s on Copilot), and nothing the host does
// with the hook's result depends on that work.
const WRITE_WAIT_MS = 1000;
// A detached worker that hangs would outlive the session unseen, so it stops itself after this long.
const WORKER_LIMIT_MS = 60_000;

/** Starts `node entry ...args` detached with `payload` as its stdin; resolves `true` once the payload is handed over. Never throws. */
function startDetached(entry, args, payload, { env = process.env, waitMs = WRITE_WAIT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [entry, ...args], { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true, env });
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

/** Called first in a detached worker: ends the process after `WORKER_LIMIT_MS` whatever it is doing. */
function limitWorker(ms = WORKER_LIMIT_MS) {
  setTimeout(() => process.exit(0), ms).unref();
}

module.exports = { startDetached, limitWorker };
