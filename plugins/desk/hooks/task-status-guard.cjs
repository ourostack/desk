#!/usr/bin/env node
"use strict";

// Desk's task-status guard: see mcp/src/runtime/task-status-guard.js for
// what it checks and why. `argv[2]` names the host. On Claude Code it is a
// PreToolUse hook on Write|Edit|MultiEdit and, for a shell command that writes
// a live task card, Bash|PowerShell. On Copilot CLI it is a `preToolUse` hook
// (which has no matcher, so it runs for every tool) that maps `create`, `edit`,
// `apply_patch`, `bash` and `powershell` onto the same calls and answers `{}`
// at once for any other tool. Codex has no wiring (see that module's doc
// comment).
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
    // Copilot runs this hook for every tool: a tool that writes no file and runs no shell is not this guard's business, so answer without loading it.
    if (process.argv[2] === "copilot") {
      const { copilotToolCalls } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/copilot-hook-payload.js")).href);
      if (copilotToolCalls(payload).length === 0) {
        process.stdout.write("{}\n");
        return;
      }
    }
    // A shell command that never says task.md cannot write a card: answer without loading the guard (this hook runs on every shell call).
    const args = typeof payload?.tool_input === "string" ? payload.tool_input : JSON.stringify(payload?.tool_input ?? payload?.toolArgs ?? "");
    if (/^(?:bash|powershell)$/i.test(String(payload?.tool_name ?? payload?.toolName)) && !/task\.md/i.test(args)) {
      process.stdout.write("{}\n");
      return;
    }
    // The guard reads card frontmatter (nested `repos:` included) with gray-matter; restore it before the module that binds its parser loads.
    const { ensureHookDependencies } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/hook-dependencies.js")).href);
    ensureHookDependencies({ hook: "task-status-guard", env: process.env });
    const { taskStatusGuardHook } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/task-status-guard.js")).href);
    const output = taskStatusGuardHook(payload, process.argv[2]);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`Desk task-status guard could not inspect this call, allowing it: ${error.message}\n`);
    // Copilot reads a nonzero exit as a hook failure it may surface or act on, so there the answer is an explicit allow with exit 0; Claude keeps exit 1.
    if (process.argv[2] === "copilot") {
      process.stdout.write("{}\n");
    } else {
      process.exitCode = 1;
    }
  }
});
