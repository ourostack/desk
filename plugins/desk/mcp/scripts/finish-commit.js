#!/usr/bin/env node
// Finishes a commit Desk could not finish, from the captured change a route carries: reads where it stands and, with
// --commit, commits exactly it once through a private index. See src/util/finish-commit.js. Like sync-push.js it runs
// straight from the installed plugin, so it imports only Node's built-ins and Desk's own dependency-free modules.
import { runFinishCommitCli } from "../src/util/finish-commit.js"

try {
  process.exitCode = runFinishCommitCli()
} catch (error) {
  process.stdout.write(`${JSON.stringify({ state: "unknown", reason: error.message })}\n`)
  process.exitCode = 5
}
