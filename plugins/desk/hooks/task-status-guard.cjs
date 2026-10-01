#!/usr/bin/env node
"use strict";

// Desk's task-status guard: see mcp/src/runtime/task-status-guard.js for
// what it checks and why. A PreToolUse hook on Write|Edit|MultiEdit and, for
// a shell command that writes a live task card, Bash|PowerShell; Claude
// Code only today (see that module's doc comment for what Copilot/Codex
// would need).
//
// Fails open on an internal error, the same as ask-gate.cjs and
// host-enforcement.cjs: this guard must never be the thing that blocks a
// legitimate task-card edit, so an error here lets the call through with
// exit code 1, never exit code 2 -- the only code that blocks a Claude Code
// `PreToolUse` hook's tool call.

const { pathToFileURL } = require("node:url");
const path = require("node:path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(input);
    // A shell command that never says task.md cannot write a card: answer without loading the guard (this hook runs on every Bash call).
    const args = typeof payload?.tool_input === "string" ? payload.tool_input : JSON.stringify(payload?.tool_input ?? payload?.toolArgs ?? "");
    if ((payload?.tool_name === "Bash" || payload?.tool_name === "PowerShell") && !/task\.md/i.test(args)) {
      process.stdout.write("{}\n");
      return;
    }
    const { taskStatusGuardHook } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/task-status-guard.js")).href);
    const output = taskStatusGuardHook(payload, process.argv[2]);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`Desk task-status guard could not inspect this call, allowing it: ${error.message}\n`);
    process.exitCode = 1;
  }
});
