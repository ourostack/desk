#!/usr/bin/env node
// Session-start's one-call boot: `session-start/SKILL.md` runs this one
// command, optionally with `--task <name>`, in place of the migration check,
// host probe, prereq probe, workspace sync, active-task scan, card validation,
// push-account resolution, repo fetch and open-PR lookup it used to spell out
// as separate steps -- see `bootOnce`/`runBootCli` in src/runtime/boot.js for
// the logic and its own tests. It runs straight from the installed plugin,
// so it imports nothing outside Node's built-ins and Desk's own
// dependency-free modules.
import { runBootCli } from "../src/runtime/boot.js"

process.exitCode = await runBootCli({ argv: process.argv.slice(2) })
