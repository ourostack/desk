#!/usr/bin/env node
// Session-start's one-call boot: `session-start/SKILL.md` runs this one
// command, optionally with `--task <name>`, in place of the migration check,
// host probe, prereq probe, workspace sync, active-task scan, card validation,
// push-account resolution, repo fetch and open-PR lookup it used to spell out
// as separate steps -- see `bootOnce`/`runBootCli` in src/runtime/boot.js for
// the logic and its own tests. It runs straight from the installed plugin,
// so it has no node_modules beside it: before the boot code loads, it restores
// the plugin's runtime pack the way the MCP server does (see
// src/runtime/boot-dependencies.js) so task cards' `repos:` lists parse, and
// falls back to the dependency-free reader when it cannot.
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureBootDependencies } from "../src/runtime/boot-dependencies.js"

ensureBootDependencies({ mcpRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), env: process.env })
const { runBootCli } = await import("../src/runtime/boot.js")

process.exitCode = await runBootCli({ argv: process.argv.slice(2) })
