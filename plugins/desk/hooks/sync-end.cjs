#!/usr/bin/env node
"use strict";

// The session-end hook hosts register. Its logic is in `lib/sync-end.cjs`, which tests import by name.
require("./lib/sync-end.cjs").main();
