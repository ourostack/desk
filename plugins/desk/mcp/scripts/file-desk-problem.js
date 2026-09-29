#!/usr/bin/env node
// The detached Desk-problem filer: a boot check (or any future caller) that finds a broken mechanism
// launches this script detached, off its own critical path, instead of awaiting the real filer inline
// (ruling 2, spec.md §1) -- see `runFileDeskProblemCli` in src/factory/desk-problem-file.js for the CLI
// surface, its own deadline and its tests. It runs straight from the installed plugin, so it imports
// nothing outside Node's built-ins and Desk's own dependency-free modules.
import { runFileDeskProblemCli } from "../src/factory/desk-problem-file.js"

process.exitCode = await runFileDeskProblemCli()
