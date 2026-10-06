#!/usr/bin/env node
"use strict";

// Desk's sign-off witness: see mcp/src/runtime/signoff-witness.js for what it records and why.
//   signoff-witness.cjs prompt   UserPromptSubmit / userPromptSubmitted: a prompt reached the session, so note when.
//   signoff-witness.cjs stop     Stop / agentStop: the main agent stopped, so note when. A subagent's stop is ignored.
//   signoff-witness.cjs ticket   PreToolUse on task_signoff (Claude Code only): deny a subagent's call, otherwise write the ticket the server reads.
// The same script serves both hosts: a payload in Copilot's own shape (`sessionId`) is read through the adapter. Codex is not wired.
//
// Fails quietly on every error, the same as the other Desk hooks: it always exits 0 and prints `{}` unless it denies a subagent.

const { pathToFileURL } = require("node:url");
const path = require("node:path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(input);
    const mode = process.argv[2];
    let shaped = payload;
    if (payload && typeof payload === "object" && payload.session_id === undefined && payload.sessionId !== undefined) {
      const adapter = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/copilot-hook-payload.js")).href);
      shaped = adapter.claudeShapedPayload(payload);
    }
    const witness = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/signoff-witness.js")).href);
    const output = mode === "prompt" ? witness.recordPrompt(shaped) : mode === "stop" ? witness.recordStop(shaped) : mode === "ticket" ? witness.issueTicket(shaped) : {};
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
});
