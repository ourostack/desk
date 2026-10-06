#!/usr/bin/env node
"use strict";

// Desk's credential-probe guard: a Claude PreToolUse and Copilot preToolUse hook on shell tools. It denies the shell commands that
// print, count, test, store or send a GitHub token, and the ones that read gh's or git's credential stores, while the documented
// push recipe (`GH_TOKEN=$(gh auth token --user X) git ...`) stays allowed. See mcp/src/runtime/credential-probe-guard.js for the
// rules and the boot-acceptance round AK incident behind them. `argv[2]` names the host.
//
// This hook runs on every shell call, so a payload that mentions none of the words a rule reads (a token, a credential store, env,
// set, export, declare, ps, awk, jq; a shell script that reads the token names it too) is answered before the guard loads. It fails open on an internal error, like process-kill-guard.cjs: exit code 1 on Claude (only 2 blocks), an explicit
// `{}` with exit 0 on Copilot.

const { pathToFileURL } = require("node:url");
const path = require("node:path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    if (!/token|credential|hosts\.yml|netrc|security|keychain|cmdkey|\bgh\b|\benv\b|printenv|environ|\bset\b|export|declare|typeset|\bps\b|awk|\bjq\b/i.test(input)) {
      process.stdout.write("{}\n");
      return;
    }
    const { credentialProbeGuardHook } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/credential-probe-guard.js")).href);
    process.stdout.write(`${JSON.stringify(await credentialProbeGuardHook(JSON.parse(input), process.argv[2]))}\n`);
  } catch (error) {
    process.stderr.write(`Desk credential-probe guard could not inspect this call, allowing it: ${error.message}\n`);
    if (process.argv[2] === "copilot") process.stdout.write("{}\n");
    else process.exitCode = 1;
  }
});
