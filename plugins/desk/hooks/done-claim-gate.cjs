#!/usr/bin/env node
"use strict";

// Desk's done-claim gate: see mcp/src/runtime/done-claim-gate.js for what it checks and why.
//   done-claim-gate.cjs claude track   PostToolUse on task_update, task_create, task_move, task_archive: note the task this session touched.
//   done-claim-gate.cjs claude prompt  UserPromptSubmit: a new turn starts, so the tasks of the last one are forgotten.
//   done-claim-gate.cjs claude stop    Stop: block once when the reply says done over a task this turn touched that is not done and never states its status.
// Claude Code only today; the module's doc comment says what Copilot and Codex would need.
//
// Fails open on every error, the same as the other Desk hooks, and quietly: this gate must never be the reason a turn cannot end. It always exits 0.

const { pathToFileURL } = require("node:url");
const path = require("node:path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(input);
    const gate = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/done-claim-gate.js")).href);
    const mode = process.argv[3];
    const output = mode === "track" ? gate.recordTouchedTask(payload) : mode === "prompt" ? gate.clearTouchedTasks(payload) : gate.doneClaimStopHook(payload);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
});
