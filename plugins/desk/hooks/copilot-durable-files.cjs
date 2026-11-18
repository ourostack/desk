#!/usr/bin/env node
"use strict";

// Runs the newest Desk release on disk when this session started on an older one (lib/current-release.cjs).
if (require("./lib/current-release.cjs").delegate(__filename)) return;

// Copilot preToolUse: a durable file written into the host's session folder gets a note naming the desk folder to use. The logic is in `lib/durable-files.cjs`.
require("./lib/durable-files.cjs").main();
