#!/usr/bin/env node
"use strict";

// Desk's process-kill guard: a Claude PreToolUse and Copilot preToolUse hook on shell tools. It denies pkill, pgrep and
// killall calls that kill the operator's other sessions (an option after the first pattern, a short or generic pattern),
// `kill` of a process group, and the Windows equivalents. See mcp/src/runtime/process-kill-guard.js for the rules and the
// 2026-10-02 incident behind them. `argv[2]` names the host.
//
// This hook runs on every shell call, so a payload that never mentions a kill command is answered before the guard
// loads. It fails open on an internal error, like task-status-guard.cjs: exit code 1 on Claude (only 2 blocks), an
// explicit `{}` with exit 0 on Copilot.

const { pathToFileURL } = require("node:url");
const path = require("node:path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    if (!/pkill|pgrep|kill|stop-process|spps|taskkill|wmic|terminate|osascript/i.test(input)) {
      process.stdout.write("{}\n");
      return;
    }
    const { processKillGuardHook } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/process-kill-guard.js")).href);
    process.stdout.write(`${JSON.stringify(await processKillGuardHook(JSON.parse(input), process.argv[2]))}\n`);
  } catch (error) {
    process.stderr.write(`Desk process-kill guard could not inspect this call, allowing it: ${error.message}\n`);
    if (process.argv[2] === "copilot") process.stdout.write("{}\n");
    else process.exitCode = 1;
  }
});
