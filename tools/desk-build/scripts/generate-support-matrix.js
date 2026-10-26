#!/usr/bin/env node

import { runSupportMatrixGenerator } from "../activation/support-matrix.js"

process.exitCode = runSupportMatrixGenerator()
