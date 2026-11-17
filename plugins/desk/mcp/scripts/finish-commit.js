#!/usr/bin/env node
// Finishes a commit Desk could not finish, from the captured change a route carries: reads where it stands and, with
// --commit, commits exactly it once through a private index. See src/util/finish-commit.js. Like sync-push.js it runs
// straight from the installed plugin, so it imports only Node's built-ins, Desk's own dependency-free modules and the vendored Ouro AX kit.
import { runFinishCommitCli } from "../src/util/finish-commit.js"

process.exitCode = await runFinishCommitCli()
