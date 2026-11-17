#!/usr/bin/env node

import { runRuntimeDependencyPackVerifyCli } from "../src/runtime/runtime-deps-cli.js"

process.exitCode = await runRuntimeDependencyPackVerifyCli()
