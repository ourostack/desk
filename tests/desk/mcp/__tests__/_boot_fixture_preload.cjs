// A test-only preload (never shipped): `NODE_OPTIONS=--require=<this file>` on a spawned session-start hook swaps parts of the real
// boot registry for fixtures. The registry's own exports are the seam, because both session-start hooks read `runBootChecks`,
// `migrationLine` and `startFactory` from them when they run.
//
// `DESK_TEST_BOOT_FIXTURE` names a module that may export `checks` (replaces the registry's checks), `options` (merged over what
// `runBootChecks` is given), `startFactory` and `migrationLine`. NODE_OPTIONS reaches every Node process the hook starts, including
// each migration's Detect, which has a two-second budget, so only the hook process itself is touched.
"use strict";

const path = require("node:path");

if (/(claude-session-start\.cjs|copilot-session-start\.cjs|resolve-desk-root\.js)$/u.test(process.argv[1] ?? "") && process.env.DESK_TEST_BOOT_FIXTURE) {
  const fixture = require(process.env.DESK_TEST_BOOT_FIXTURE);
  const boot = require(path.resolve(__dirname, "../../../../plugins/desk/hooks/lib/boot-checks.cjs"));
  if (fixture.checks) boot.checks.splice(0, boot.checks.length, ...fixture.checks);
  if (fixture.options) {
    const real = boot.runBootChecks;
    boot.runBootChecks = (options) => real({ ...options, ...fixture.options });
  }
  if (fixture.startFactory) boot.startFactory = fixture.startFactory;
  if (fixture.migrationLine) boot.migrationLine = fixture.migrationLine;
}
