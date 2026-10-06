#!/usr/bin/env node
"use strict";

// Desk's done-claim gate: see mcp/src/runtime/done-claim-gate.js for what it checks and why.
//   done-claim-gate.cjs <host> track   PostToolUse / postToolUse on task_update, task_create, task_move, task_archive, task_signoff: note the task this session touched.
//   done-claim-gate.cjs <host> prompt  UserPromptSubmit / userPromptSubmitted: a new turn starts, so the tasks of the last one are forgotten.
//   done-claim-gate.cjs <host> stop    Stop / agentStop: block once when the reply says done over a task this turn touched that is not done and never states its status.
// <host> is claude or copilot. Copilot's hooks have no matcher, so `track` answers `{}` at once for any tool that is not one of the five, and its `stop` reads the reply from the session transcript.
// Codex is not wired; the module's doc comment says why.
//
// A failure of this wrapper (a bad payload, a module that will not load) fails open, the same as the other Desk hooks: this gate must never be the reason a turn cannot end. It always exits 0, and it counts the failure for desk_doctor.

const { pathToFileURL } = require("node:url");
const path = require("node:path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(input);
    const [host, mode] = process.argv.slice(2);
    const copilot = host === "copilot";
    let shaped = payload;
    if (copilot) {
      const adapter = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/copilot-hook-payload.js")).href);
      // Copilot runs `track` for every tool: only the five task tools are this gate's business, so answer without loading it.
      // ... and the boot script run through the shell, which names the task the operator asked for.
      const bootRun = /^(?:bash|powershell)$/iu.test(String(payload?.toolName ?? "")) && /session-boot\.js/u.test(JSON.stringify(payload?.toolArgs ?? ""));
      if (mode === "track" && !adapter.isTaskToolName(payload?.toolName) && !bootRun) {
        process.stdout.write("{}\n");
        return;
      }
      shaped = adapter.claudeShapedPayload(payload);
    }
    // Claude runs `track` for Bash too (hooks.json), so answer at once for a shell call that is not the boot script.
    if (!copilot && mode === "track" && /^(?:Bash|PowerShell)$/u.test(String(payload?.tool_name ?? "")) && !/session-boot\.js/u.test(String(payload?.tool_input?.command ?? ""))) {
      process.stdout.write("{}\n");
      return;
    }
    const gate = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/done-claim-gate.js")).href);
    const output = mode === "track" ? gate.recordTouchedTask(shaped) : mode === "prompt" ? gate.clearTouchedTasks(shaped) : copilot ? await gate.copilotStopHook(payload) : gate.doneClaimStopHook(payload);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    // Still fails open, but visibly: the failure is counted for desk_doctor (best effort; if the counter cannot load either, the turn still ends).
    try {
      const health = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/gate-health.js")).href);
      health.recordGateFailure("wrapper_error");
    } catch {
      // Nothing more can be done.
    }
    process.stdout.write("{}\n");
  }
});
