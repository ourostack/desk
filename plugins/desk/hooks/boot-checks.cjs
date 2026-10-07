#!/usr/bin/env node
"use strict";

// The command line of the boot-check registry: `--compatible`, `--fast-forward`, `--repair`, `--ack` and `--revoke`, started by path from the
// hooks, the docs and the doctor. The registry itself is in `lib/boot-checks.cjs`, which tests and both session-start hooks import by name.
// This file has no `require.main` guard: requiring it runs the command line, so it must never be required. Import `lib/boot-checks.cjs` instead.
require("./lib/boot-checks.cjs").main();
