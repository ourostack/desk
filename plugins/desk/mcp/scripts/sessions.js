#!/usr/bin/env node
// Reads and messages this machine's agent sessions. See src/runtime/sessions-cli.js.
import { runSessionsCli } from "../src/runtime/sessions-cli.js"

process.exitCode = await runSessionsCli({ argv: process.argv.slice(2), script: process.argv[1] })
