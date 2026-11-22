#!/usr/bin/env node
"use strict";

// Runs the newest Desk release on disk when this session started on an older one (lib/current-release.cjs).
if (require("./lib/current-release.cjs").delegate(__filename)) return;

// The PostToolUse hook Claude Code runs after task_focus and task_create (hooks.json). Its logic is in `lib/orca-session-title.cjs`.
require("./lib/orca-session-title.cjs").main();
