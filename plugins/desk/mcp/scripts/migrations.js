#!/usr/bin/env node
// Run one of Desk's own session-start migrations: `run <id> [--tools-root
// <path>] [--tools-person <alias>]`. The startup hooks name this command when
// a migration is pending. It runs straight from the installed plugin, so it
// imports nothing outside Node's built-ins and Desk's own dependency-free
// modules. See src/runtime/pending-migrations.js.
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { runMigrationCli } from "../src/runtime/pending-migrations.js"

process.exitCode = await runMigrationCli({ pluginRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..") })
