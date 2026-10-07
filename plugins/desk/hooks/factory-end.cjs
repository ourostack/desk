#!/usr/bin/env node
"use strict";

// The end hook hosts register. Its logic is in `lib/factory-end.cjs`, which tests import by name.
require("./lib/factory-end.cjs").main(__filename);
