#!/usr/bin/env node
"use strict";

// Desk's brief task line: see mcp/src/runtime/brief-task-line.js for what it checks and why.
//   brief-task-line.cjs <host> record   PostToolUse / postToolUse on task_focus and task_create: keep the task the main agent declared.
//   brief-task-line.cjs <host> check    PreToolUse / preToolUse on the subagent tool: pass a brief with a Desk-Task line, add the line (Claude Code), or deny once with the line to add.
// <host> is claude or copilot. Copilot's hooks have no matcher, so both modes answer `{}` at once for a tool that is not theirs.
// Codex is not wired; the module's doc comment says why.
//
// Fails open on every error and always exits 0: this hook must never be the reason a subagent cannot start.

const { pathToFileURL } = require("node:url");
const path = require("node:path");

const runtime = (name) => import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime", name)).href);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(input);
    const [host, mode] = process.argv.slice(2);
    const toolName = String((host === "copilot" ? payload?.toolName : payload?.tool_name) ?? "");
    // Answer at once for a tool that is not this hook's business, without loading anything.
    if (mode === "record" ? !/task_(?:focus|create)$/u.test(toolName) : !/^(?:Agent|Task|task)$/u.test(toolName)) {
      process.stdout.write("{}\n");
      return;
    }
    const [brief, { resolveDeskStateDir }] = await Promise.all([runtime("brief-task-line.js"), runtime("last-start.js")]);
    const stateDir = resolveDeskStateDir({ env: process.env });
    if (mode === "record") {
      process.stdout.write(`${JSON.stringify(brief.recordBriefFocus(host, payload, { stateDir }))}\n`);
      return;
    }
    const { resolveHookDeskRoot } = await import(pathToFileURL(path.join(__dirname, "../mcp/scripts/resolve-desk-root.js")).href);
    const cwd = typeof payload?.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();
    const deskRoot = resolveHookDeskRoot({ env: process.env, cwd }).root;
    process.stdout.write(`${JSON.stringify(brief.briefHookOutput(host, brief.briefDecision(host, payload, { stateDir, deskRoot })))}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
});
