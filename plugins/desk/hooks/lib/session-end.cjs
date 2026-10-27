"use strict";

// Session end, the one command each host registers for it. On Windows every registered command is its own PowerShell process,
// about 0.75 s before any work, so the factory capture (factory-end.cjs) and the unpushed-commit check (sync-end.cjs) share one.
// The hook reads the payload once and hands it to one detached worker (`--worker`) that runs both, so it exits well inside the
// host's timeout however slow loading Desk or Git is (see detach-worker.cjs). Nothing the host does depends on either job.

const path = require("node:path");
const { limitWorker, startDetached } = require("./detach-worker.cjs");
const factoryEnd = require("./factory-end.cjs");
const syncEnd = require("./sync-end.cjs");

const ENTRY = path.join(__dirname, "..", "session-end.cjs");
const headless = (env) => { try { return require("../../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(env); } catch { const v = String(env?.DESK_FACTORY_HEADLESS ?? ""); return v !== "" && v !== "0"; } };

/** Both session-end jobs for one payload. Each is fail-open on its own, so one failing never stops the other. */
function runJobs({ host, payload, env = process.env }) {
  return Promise.all([factoryEnd.runHook({ host, payload, env }), syncEnd.runHook({ host, payload, env })]);
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
