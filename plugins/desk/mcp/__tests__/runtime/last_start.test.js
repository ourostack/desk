// last-start.json and the repair log live in Desk's state directory, never in the desk.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync, statSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  appendRepairLog, LAST_START_FILE, LAST_START_ROOTS_DIR, lastStartRootKey, REPAIR_LOG_FILE, resolveDeskStateDir, resolveReadinessStateHome, writeLastStart,
} from "../../src/runtime/last-start.js"
import { existsSync } from "node:fs"
import { mkTempRoot } from "../_temp_roots.js"

test("the state directory follows XDG_STATE_HOME, then HOME, then the account home", () => {
  assert.equal(resolveDeskStateDir({ env: { XDG_STATE_HOME: "/x/state", HOME: "/h" } }), path.join("/x/state", "ouroboros-skills", "desk"))
  assert.equal(resolveDeskStateDir({ env: { HOME: "/h" } }), path.join("/h", ".local", "state", "ouroboros-skills", "desk"))
  assert.equal(resolveDeskStateDir({ env: { XDG_STATE_HOME: " " }, homeDir: "/given" }), path.join("/given", ".local", "state", "ouroboros-skills", "desk"))
  assert.equal(resolveDeskStateDir({ env: {} }), path.join(os.homedir(), ".local", "state", "ouroboros-skills", "desk"))
  assert.equal(resolveReadinessStateHome({ env: { HOME: "/h" } }), path.join("/h", ".cache", "ouroboros-skills", "desk", "readiness"))
  assert.equal(resolveReadinessStateHome({ env: {}, homeDir: "/given" }), path.join("/given", ".cache", "ouroboros-skills", "desk", "readiness"))
  assert.equal(resolveReadinessStateHome({ env: {} }), path.join(os.homedir(), ".cache", "ouroboros-skills", "desk", "readiness"))
  assert.equal(typeof resolveDeskStateDir(), "string")
  assert.equal(typeof resolveReadinessStateHome(), "string")
})

test("last-start.json is replaced atomically with state, code and repair, owner-only", async () => {
  const base = await mkTempRoot("desk-last-start-")
  const stateDir = path.join(base, "state")
  const snapshot = { state: "degraded:state_branch_detached", code: "state_branch_detached", repair: null, fix: "push it" }
  const file = writeLastStart({ stateDir, snapshot, root: "/desk", pid: 42, now: () => new Date("2026-09-25T00:00:00Z") })
  assert.equal(path.basename(file), LAST_START_FILE)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    schema_version: 1, state: "degraded:state_branch_detached", code: "state_branch_detached", repair: null,
    fix: "push it", root: "/desk", pid: 42, updated_at: "2026-09-25T00:00:00.000Z",
  })
  const perRoot = path.join(stateDir, LAST_START_ROOTS_DIR, `${lastStartRootKey("/desk")}.json`)
  assert.equal(JSON.parse(readFileSync(perRoot, "utf8")).state, "degraded:state_branch_detached", "each root keeps its own record")
  assert.match(lastStartRootKey("/desk"), /^[0-9a-f]{16}$/u)
  assert.notEqual(lastStartRootKey("/desk"), lastStartRootKey("/other-desk"))
  writeLastStart({ stateDir, snapshot: { state: "ready", code: null, repair: "repaired: x", fix: null } })
  assert.equal(JSON.parse(readFileSync(perRoot, "utf8")).state, "degraded:state_branch_detached", "a record without a root leaves the per-root records alone")
  assert.equal(existsSync(path.join(stateDir, LAST_START_ROOTS_DIR)), true)
  const record = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(record.state, "ready")
  assert.equal(record.root, null)
  assert.equal(record.pid, process.pid)
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("the repair log gets one line per repair", async () => {
  const base = await mkTempRoot("desk-repair-log-")
  const stateDir = path.join(base, "state")
  appendRepairLog({ stateDir, line: "repaired: detached HEAD → main (was abc)", root: "/desk", now: () => new Date("2026-09-25T01:00:00Z") })
  const file = appendRepairLog({ stateDir, line: "repaired: second", root: "/desk" })
  assert.equal(path.basename(file), REPAIR_LOG_FILE)
  const lines = readFileSync(file, "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
  assert.equal(lines[0], "2026-09-25T01:00:00.000Z /desk repaired: detached HEAD → main (was abc)")
})
