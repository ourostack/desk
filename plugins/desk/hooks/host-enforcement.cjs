#!/usr/bin/env node
"use strict";

// Desk-only enforcement's deny half: a `PreToolUse` hook shared by Claude
// Code, Copilot CLI and Codex CLI (`argv[2]` names which one -- `hooks.json`,
// `copilot-hooks.json` and the Codex activation's own `[hooks] PreToolUse`
// block each pass their own host id), on the surfaces spec §5 names
// (controller ruling 2). It composes `runtime/host-enforcement.js`'s
// host-agnostic deny decision with `runtime/naming-allowlist.js`'s
// same-session "named by the operator" exception (controller ruling 3), and
// writes exactly what `hookProcessOutput` says that host's own `PreToolUse`
// contract needs (Claude Code's `hookSpecificOutput` wrapper, Copilot's flat
// JSON, or Codex's exit-code-2-plus-stderr -- never JSON at all -- confirmed
// live, `docs/host-enforcement-live-proof.md`). This file stays a thin
// wrapper with no host branching of its own: every host's contract is a
// plain function call in `host-enforcement.js`, covered there without
// needing a real denied tool on every host to exercise it end to end.
//
// Fails toward its safe side on internal error, mirroring `ask-gate.cjs`'s
// own catch-all exactly: this enforcement must never be the thing that
// blocks a session, so an error here lets the call through with exit code 1,
// never exit code 2 -- the only code that blocks a Codex or Claude Code
// `PreToolUse` hook's tool call.

const { pathToFileURL } = require("node:url");
const path = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const { evaluateDeniedTool, hookProcessOutput, sessionIdFromPayload, toolNameFromPayload } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/host-enforcement.js")).href);
    const { loadSessionAllowlist } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/naming-allowlist.js")).href);
    const host = process.argv[2];
    const payload = JSON.parse(input);
    const toolName = toolNameFromPayload(host, payload);
    const sessionId = sessionIdFromPayload(host, payload);
    const allowedThisSession = typeof sessionId === "string" && sessionId !== "" ? loadSessionAllowlist({ sessionId }) : new Set();
    const decision = evaluateDeniedTool({ host, toolName, allowedThisSession });
    const { stdout, stderr, exitCode } = hookProcessOutput(host, decision);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`Desk host-enforcement could not inspect this call, allowing it: ${error.message}\n`);
    process.exitCode = 1;
  }
});
