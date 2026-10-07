#!/usr/bin/env node
"use strict";

// The command line of the boot-check registry: `--compatible`, `--fast-forward`, `--repair`, `--ack` and `--revoke`, started by path from the
// hooks, the docs and the doctor. The registry itself is in `lib/boot-checks.cjs`, which tests and both session-start hooks import by name.
require("./lib/boot-checks.cjs").main();
