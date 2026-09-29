// Deliberately imports nothing that isolates HOME/XDG_STATE_HOME: no `_isolated_env.mjs`, no `_session_helpers.js`, no
// other shared helper. Run bare (`node --test` with no `--import`), this file's only protection against writing under
// whatever HOME/XDG_STATE_HOME the parent process handed it is `factoryStateRoot`'s own guard
// (`../../../../../plugins/desk/mcp/src/factory/test-state-guard.js`), called with no `deskRoot` — the exact call
// shape the incident this guards against actually used (`factory/evaluate-run.js`'s `factoryStateRoot(env)`).
// `test_isolation.test.js`'s "a factory test file with no isolation import at all…" test runs this file on its own,
// with a fake, non-temp HOME standing in for a real one, and asserts it never creates anything there.

import { test } from "node:test"
import assert from "node:assert/strict"
import { factoryStateRoot } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { DESK_TEST_REAL_STATE } from "../../../../../plugins/desk/mcp/src/factory/test-state-guard.js"

test("factoryStateRoot refuses a non-temp state home from a bare node --test run, with no deskRoot given", async () => {
  await assert.rejects(() => factoryStateRoot(), { code: DESK_TEST_REAL_STATE })
})
