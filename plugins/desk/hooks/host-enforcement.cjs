#!/usr/bin/env node
"use strict";

// Desk-only enforcement's deny half: a Claude Code `PreToolUse` hook on the
// surfaces `hooks.json`'s matcher names (spec §5, controller ruling 2). It
// composes `runtime/host-enforcement.js`'s host-agnostic deny decision with
// `runtime/naming-allowlist.js`'s same-session "named by the operator"
// exception (controller ruling 3), and wraps the result in Claude Code's own
// `hookSpecificOutput` shape -- the shape `protected-checkout.cjs`/
// `ask-gate.cjs` already emit today.
//
// Fails toward its safe side on internal error, mirroring `ask-gate.cjs`'s
// own catch-all exactly: this enforcement must never be the thing that
// blocks a session, so an error here lets the call through with no JSON
// decision at all, never exit code 2.

const { pathToFileURL } = require("node:url");
const path = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const { evaluateDeniedTool } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/host-enforcement.js")).href);
    const { loadSessionAllowlist } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/naming-allowlist.js")).href);
    const payload = JSON.parse(input);
    const toolName = typeof payload?.tool_name === "string" ? payload.tool_name : payload?.toolName;
    const sessionId = payload?.session_id;
    const allowedThisSession = typeof sessionId === "string" && sessionId !== "" ? loadSessionAllowlist({ sessionId }) : new Set();
    const decision = evaluateDeniedTool({ toolName, allowedThisSession });
    const output = decision.permissionDecision === "deny"
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } }
      : {};
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    // Fail open: only exit code 2 blocks a PreToolUse hook's tool call; every
    // other code, including this one, lets the call proceed with no JSON
    // decision, exactly like ask-gate.cjs's own catch-all.
    process.stderr.write(`Desk host-enforcement could not inspect this call, allowing it: ${error.message}\n`);
    process.exitCode = 1;
  }
});
