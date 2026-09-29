#!/usr/bin/env node
// Session-start's one-call boot: `session-start/SKILL.md` Step 0 onward runs
// this in place of the host probe, prereq probe, workspace sync, active-task
// scan, card validation and push-account resolution it used to spell out as
// separate steps -- see `bootOnce`/`runBootCli` in src/runtime/boot.js for
// the logic and its own tests. It runs straight from the installed plugin,
// so it imports nothing outside Node's built-ins and Desk's own
// dependency-free modules.
import { runBootCli } from "../src/runtime/boot.js"

process.exitCode = await runBootCli()
