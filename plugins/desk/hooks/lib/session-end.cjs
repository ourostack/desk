"use strict";

// Session end, the one command each host registers for it. On Windows every registered command is its own PowerShell process,
// about 0.75 s before any work, so the unpushed-commit check (sync-end.cjs) runs in a detached worker too.
// The hook reads the payload once and hands it to one detached worker (`--worker`) that runs the check, so it exits well inside the
// host's timeout however slow loading Desk or Git is (see detach-worker.cjs). Nothing the host does depends on it. The factory's
// capture (factory-end.cjs) is not registered: it runs only where someone registers it.

const path = require("node:path");
const { limitWorker, startDetached } = require("./detach-worker.cjs");
const syncEnd = require("./sync-end.cjs");

const ENTRY = path.join(__dirname, "..", "session-end.cjs");
const headless = (env) => { try { return require("../../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(env); } catch { const v = String(env?.DESK_FACTORY_HEADLESS ?? ""); return v !== "" && v !== "0"; } };

/** The session-end job for one payload. It is fail-open. */
function runJobs({ host, payload, env = process.env }) {
  return syncEnd.runHook({ host, payload, env });
}

// The command line of the entry file `hooks/session-end.cjs`.
function main(argv = process.argv, stdin = process.stdin) {
  const host = argv[2];
  const work = argv[3] === "--worker"
    ? (limitWorker(), syncEnd.readInput(stdin, 5000).then((payload) => runJobs({ host, payload })))
    : syncEnd.readInput(stdin).then((payload) => payload === null || headless(process.env) ? null : startDetached(ENTRY, [host, "--worker"], payload));
  work.then(() => process.exit(0), () => process.exit(0));
}

module.exports = { main };
