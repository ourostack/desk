#!/usr/bin/env node
// Print the active-task listing desk:session-start renders, with every name
// that carries a secret's value redacted. It runs straight from the installed
// plugin, so it imports nothing outside Node's built-ins and Desk's own
// dependency-free modules. See src/desk/active-tasks.js.
import { runActiveTasksCli } from "../src/desk/active-tasks.js"

process.exitCode = runActiveTasksCli()
