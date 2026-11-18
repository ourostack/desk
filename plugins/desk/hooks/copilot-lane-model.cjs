#!/usr/bin/env node
"use strict";

// Runs the newest Desk release on disk when this session started on an older one (lib/current-release.cjs).
if (require("./lib/current-release.cjs").delegate(__filename)) return;

// Copilot preToolUse: a lane started without a model gets Desk's lane default. The logic is in `lib/lane-model.cjs`.
require("./lib/lane-model.cjs").main();
