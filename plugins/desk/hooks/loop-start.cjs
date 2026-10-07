#!/usr/bin/env node
"use strict";

// Started detached, with ignored stdio, by both session-start hooks once their output is built
// (boot-checks.cjs `startFactory`, right after factory-start.cjs, and only when a store has `contribute: true`).
// It starts the loop worker, `factory.js loop --desk <desk> [--person-prefix <desks/alias>]`, as one child of its
// own Node, and ends when that child ends. It prints nothing and always exits 0.
//
// How it finds what the worker needs: the desk root is the one the session binds, resolved the same way as the
// session-start checks (`boundRoot` in boot-checks.cjs: the project folder the host passed, else this process's
// working folder, then the activation config), and the person prefix is the one the Desk tools resolve from what
// is known without a network call (`improvementPerson`). Either missing means nothing starts.
//
// Starts nothing, before it spawns anything: in a headless factory session (`DESK_FACTORY_HEADLESS`, the
// same exact comparison as mcp/src/factory/headless-flag.cjs), with the loop switched off
// (`DESK_FACTORY_LOOP`, mcp/src/factory/loop-switch.cjs), with no bound desk, or with a crew desk whose person is not known.
//
// The hard stop: `HARD_STOP_MS` (just past the worker's own 20-minute budget) after the start, the launcher
// stops the one child it started, through that child's handle, never by a process id it looked up and never by a
// name, and exits 0. A child that ends first cancels the timer.

const path = require("node:path");
const { spawn } = require("node:child_process");

// The worker's budget is 20 minutes (mcp/src/factory/loop-worker.js); its own process ends itself a minute later.
const HARD_STOP_MS = 22 * 60 * 1000;
const FACTORY_CLI = path.join(__dirname, "..", "mcp", "scripts", "factory.js");

const isHeadless = (env) => { try { return require("../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(env); } catch { const v = String(env?.DESK_FACTORY_HEADLESS ?? ""); return v !== "" && v !== "0"; } };
const isEnabled = (env) => require("../mcp/src/factory/loop-switch.cjs").isLoopEnabled(env);

const resolveRoot = (env) => { const { boundRoot } = require("./lib/boot-checks.cjs"); return boundRoot({ env, host: "claude", shared: {} }); };
async function resolvePerson({ deskRoot, env }) {
  const { improvementPerson } = await import("../mcp/src/desk/improvement-person.js");
  return improvementPerson({ deskRoot, env, now: Date.now() });
}

/** Resolves `{ started, ... }` when the worker has ended, or the hard stop has stopped it. */
async function main({
  env = process.env, spawnImpl = spawn, resolveRoot: findRoot = resolveRoot, resolvePerson: findPerson = resolvePerson,
  setTimer = setTimeout, clearTimer = clearTimeout, hardStopMs = HARD_STOP_MS,
} = {}) {
  if (isHeadless(env)) return { started: false, reason: "headless_session" };
  if (!isEnabled(env)) return { started: false, reason: "disabled" };
  let deskRoot = null;
  try { deskRoot = await findRoot(env); } catch { /* no desk */ }
  if (!deskRoot) return { started: false, reason: "no_desk" };
  let person = null;
  try { person = await findPerson({ deskRoot, env }); } catch { /* unknown */ }
  if (person?.status !== "ok") return { started: false, reason: "person_unresolved" };
  const args = [FACTORY_CLI, "loop", "--desk", deskRoot, ...(person.personPrefix === "" ? [] : ["--person-prefix", person.personPrefix])];
  return new Promise((resolve) => {
    let child;
    let timer;
    const finish = (value) => { clearTimer(timer); resolve(value); };
    try {
      child = spawnImpl(process.execPath, args, { stdio: "ignore", windowsHide: true, env });
    } catch {
      resolve({ started: false, reason: "spawn_failed" });
      return;
    }
    child.once("error", () => finish({ started: false, reason: "spawn_failed" }));
    child.once("exit", () => finish({ started: true, stopped: false }));
    timer = setTimer(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve({ started: true, stopped: true });
    }, hardStopMs);
    timer?.unref?.();
  });
}

module.exports = { main, HARD_STOP_MS };

if (require.main === module) {
  main().then(() => process.exit(0), () => process.exit(0));
}
