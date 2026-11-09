#!/usr/bin/env node
// Keeps agent session storage bounded; a dry run unless --apply. See docs/session-retention.md and src/runtime/session-retention.js.
import { runSessionRetentionCli } from "../src/runtime/session-retention.js"

process.exitCode = await runSessionRetentionCli({ argv: process.argv.slice(2) })
