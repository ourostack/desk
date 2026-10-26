#!/usr/bin/env node

import { runCoverageCommand } from "../coverage/runner.js"

process.exitCode = runCoverageCommand({ argv: process.argv.slice(2) })
