#!/usr/bin/env node
// Polls repositories' issues for drains with no model turn. See docs/issue-drains.md and src/runtime/drains-cli.js.
import { runDrainsCli } from "../src/runtime/drains-cli.js"

process.exitCode = await runDrainsCli({ argv: process.argv.slice(2), script: process.argv[1] })
