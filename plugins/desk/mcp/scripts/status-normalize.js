#!/usr/bin/env node
// Find task cards whose status is outside the eight lifecycle states and print the fix. The
// `03-normalize-task-status` migration runs this straight from the installed plugin, so it imports nothing outside
// Node's built-ins and Desk's own dependency-free modules. See src/desk/status-normalize.js for the modes.
import { runStatusNormalizeCli } from "../src/desk/status-normalize.js"

process.exitCode = runStatusNormalizeCli({ argv: process.argv.slice(2), env: process.env, io: process })
