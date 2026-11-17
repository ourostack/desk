#!/usr/bin/env node

import { runRuntimeDependencyPackBuildCli } from "../src/runtime/runtime-deps-cli.js"

process.exitCode = await runRuntimeDependencyPackBuildCli()
