#!/usr/bin/env node
// Report or record the one-time tidy for this session's own desk. The
// `02-tidy-desk` migration runs this straight from the installed plugin, so
// it imports nothing outside Node's built-ins and Desk's own dependency-free
// modules. See src/desk/tidy.js for the modes.
import { runTidyStatusCli } from "../src/desk/tidy.js"

process.exitCode = runTidyStatusCli()
