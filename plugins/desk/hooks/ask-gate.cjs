#!/usr/bin/env node
"use strict";

// Desk's ask-gate guard: see mcp/src/runtime/ask-gate.js for what it checks.
//
// Migrated onto the failure contract (spec.md §1, Part 5): an internal error
// here -- a malformed hook payload, a module that fails to load -- still
// fails open exactly as before (only exit code 2 blocks a PreToolUse hook's
// tool call; every other code, including this one, lets the call proceed
// with no JSON decision), but now writes the standard five-field
// `Desk problem:` block instead of a bare line, and queues the detached
// filer (mcp/scripts/file-desk-problem.js) the same way boot-checks.cjs's
// checks do: spawned detached, stdio ignored, unref'd, and never awaited --
// this hook must answer as fast as it always has, whatever filing turns out
// to cost. `spawnFiler` is an injectable test seam; real callers never pass
// one.

const { pathToFileURL } = require("node:url");
const path = require("node:path");

function defaultSpawnFiler({ mechanism, reason, host, env = process.env }) {
  const { compatibleCommand, launchCommand } = require("./boot-checks.cjs");
  const script = path.join(__dirname, "..", "mcp", "scripts", "file-desk-problem.js");
  const command = compatibleCommand(script, "--mechanism", mechanism, "--reason", reason || "unknown", "--host", host || "unknown");
  // Fire-and-forget: launchCommand resolves once the child has actually
  // spawned, never once it finishes, and is not awaited here -- its own
  // rejection is swallowed rather than left unhandled, so a filer that
  // cannot even start simply is not filed this time.
  launchCommand(command, env).catch(() => {});
}

/**
 * Builds the `Desk problem: ask-gate` block for an internal error, queuing
 * the detached filer via `spawnFiler` (never awaited by this function's own
 * caller past this call). Exported for tests; the real entry point below is
 * the only production caller.
 */
async function askGateFailureBlock(error, { host, env = process.env, spawnFiler = defaultSpawnFiler } = {}) {
  const reason = String(error?.message ?? error);
  let file = "not filed: filer_unavailable";
  try {
    // The reason never reaches the filer's own argv (`ps`-visible to every
    // account on the machine) unredacted, and a mechanism that keeps failing
    // the same way is throttled to one real spawn per hour -- the block below
    // still renders every time regardless (fix round, spec.md §1 Part 5).
    const [{ argvSafeReason }, { shouldLaunchFiler }] = await Promise.all([
      import(pathToFileURL(path.join(__dirname, "../mcp/src/util/redact.js")).href),
      import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/filer-throttle.js")).href),
    ]);
    const safeReason = argvSafeReason(reason);
    if (shouldLaunchFiler({ env, mechanism: "ask-gate", signature: safeReason })) {
      spawnFiler({ mechanism: "ask-gate", reason: safeReason, host, env });
      file = "filing in background";
    } else {
      file = "filing already queued (within the last hour)";
    }
  } catch {
    // stays "not filed: filer_unavailable"
  }
  try {
    const { formatDeskProblem } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/index-drift.js")).href);
    return formatDeskProblem({
      mechanism: "ask-gate",
      symptom: "internal error while inspecting this call",
      broke: reason,
      means: "Desk could not check this call against the first-run-bootstrap gate, so it is allowed through",
      fix: "not fixable automatically -- ask-gate itself needs investigation",
      file,
      tell: `Desk's ask-gate hook failed internally on this call (${reason}) and allowed it through. Filing this now so it gets fixed.`,
    });
  } catch {
    return `Desk ask-gate could not inspect this call, allowing it: ${reason}`;
  }
}

module.exports = { askGateFailureBlock };

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", async () => {
    try {
      const { askGateHook } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/ask-gate.js")).href);
      const output = await askGateHook(JSON.parse(input), process.argv[2]);
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) {
      // Fail open: an internal error here must never block a real setup. Only
      // exit code 2 blocks a PreToolUse hook's tool call; every other code,
      // including this one, lets the call proceed with no JSON decision.
      const block = await askGateFailureBlock(error, { host: process.argv[2] });
      process.stderr.write(`${block}\n`);
      process.exitCode = 1;
    }
  });
}
