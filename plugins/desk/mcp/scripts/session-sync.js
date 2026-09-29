#!/usr/bin/env node
// Session-start's own sync step: `session-start/SKILL.md` Step 2 runs this in place of a bare
// `git pull --rebase --quiet origin main` plus "warn the operator but proceed" (the old text left a
// desk silently out of sync with its remote for the rest of the session) -- see `syncWorkspace`/
// `runSessionSyncCli` in src/runtime/session-sync.js for the retry-quarantine-diagnose logic and its
// own tests. It runs straight from the installed plugin, so it imports nothing outside Node's
// built-ins and Desk's own dependency-free modules.
import { runSessionSyncCli } from "../src/runtime/session-sync.js"

process.exitCode = await runSessionSyncCli()
