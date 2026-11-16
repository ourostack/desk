"use strict";

// Runs the newest Desk release on disk when this session started on an older one (lib/current-release.cjs).
if (require("./lib/current-release.cjs").delegate(__filename)) return;
require("./lib/copilot-intake-context.cjs").main();
