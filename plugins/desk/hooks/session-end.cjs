#!/usr/bin/env node
"use strict";

// Runs the newest Desk release on disk when this session started on an older one (lib/current-release.cjs).
if (require("./lib/current-release.cjs").delegate(__filename)) return;

// The one session-end hook hosts register. Its logic is in `lib/session-end.cjs`, which tests import by name.
require("./lib/session-end.cjs").main();
