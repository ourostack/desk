#!/usr/bin/env node

import { runCopilotBundleGenerator } from "../activation/copilot-bundle.js"

process.exitCode = runCopilotBundleGenerator()
