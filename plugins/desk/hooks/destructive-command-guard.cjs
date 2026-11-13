#!/usr/bin/env node
"use strict";

// The destructive-command guard hosts register on shell calls. Its logic is in `lib/destructive-command-guard.cjs`, which tests import by name.
require("./lib/destructive-command-guard.cjs").main();
