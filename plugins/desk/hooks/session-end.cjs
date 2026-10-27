#!/usr/bin/env node
"use strict";

// The one session-end hook hosts register. Its logic is in `lib/session-end.cjs`, which tests import by name.
require("./lib/session-end.cjs").main();
