// Unit coverage for the repairs admission leans on: an unreadable index database is reported and rebuilt, and authority checks keep their defaults.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { indexDbPath } from "../../src/db/init.js"
import { ensureIndexOrQuarantine } from "../../src/server.js"
import { desk_status } from "../../src/tools/status.js"
import {
  admitControlPlane, resolveAdmittedPerson, validateAdmissionAuthority, verifyAdmissionAuthority,
} from "../../src/activation/admit.js"
import { mkTempRoot } from "../_temp_roots.js"

async function deskWithCorruptIndex() {
  const root = await mkTempRoot("desk-corrupt-index-")
  writeFileSync(path.join(root, "task.md"), "# Harbor\n\nFerry log.\n")
  mkdirSync(path.dirname(indexDbPath(root)), { recursive: true })
  writeFileSync(indexDbPath(root), "SQLite format 3\u0000truncated")
  writeFileSync(`${indexDbPath(root)}-wal`, "stale wal")
  return root
}

test("desk_status reports an unreadable index database as corrupt instead of throwing", async () => {
  const root = await deskWithCorruptIndex()
  const status = await desk_status({ deskRoot: root, statusContext: { root: { root, source: "explicit-root" } } })
  assert.equal(status.local_db.state, "corrupt")
  assert.equal(status.lexical_index.available, false)
})

test("an unreadable index database is moved aside with its sidecars and rebuilt once", async (t) => {
  const root = await deskWithCorruptIndex()
  const writes = []
  t.mock.method(process.stderr, "write", (text) => { writes.push(String(text)); return true })
  let calls = 0
  const result = await ensureIndexOrQuarantine(root, {}, {
    now: () => 42,
    ensure: async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" })
      return { built: true }
    },
  })
  assert.equal(calls, 2)
  assert.equal(result.built, true)
  assert.equal(result.quarantined_index, `${indexDbPath(root)}.corrupt-42`)
  const kept = readdirSync(path.dirname(indexDbPath(root))).sort()
  assert.deepEqual(kept, ["desk-index.sqlite.corrupt-42", "desk-index.sqlite.corrupt-42-wal"])
  assert.match(writes.join(""), /repaired: unreadable index database moved to .*corrupt-42 and rebuilt \(SQLITE_NOTADB\)/u)
  const corrupt = await ensureIndexOrQuarantine(root, {}, {
    ensure: async () => { throw Object.assign(new Error("malformed"), { code: "SQLITE_CORRUPT" }) },
  }).catch((error) => error)
  assert.equal(corrupt.code, "SQLITE_CORRUPT", "a second failure after the rebuild is reported, not looped")
})

test("other index errors are not treated as corruption", async () => {
  const root = await mkTempRoot("desk-index-error-")
  for (const error of [new Error("disk full"), null]) {
    await assert.rejects(ensureIndexOrQuarantine(root, {}, { ensure: async () => { throw error } }), (thrown) => thrown === error)
  }
  assert.equal(existsSync(path.join(root, ".state")), false)
  // The real ensureIndex is the default.
  const real = await ensureIndexOrQuarantine(root, { snapshots: false, vectorPacks: false, skipEmbed: true })
  assert.equal(typeof real.built, "boolean")
})

test("admission authority helpers keep their defaults", async () => {
  await assert.rejects(admitControlPlane(), (error) => error.code === "controller_start_failed")
  await assert.rejects(
    admitControlPlane({ controllerConnector: async () => null }),
    (error) => error.code === "controller_start_failed" && error.observed !== undefined,
  )
  assert.throws(() => validateAdmissionAuthority(), (error) => error.code === "authority_invalid")
  assert.throws(() => resolveAdmittedPerson(), (error) => error.code === "authority_invalid")
  await assert.rejects(verifyAdmissionAuthority({ person: " ", policy: { write_authority: "person", authority_provider: null } }), (error) => error.code === "authority_invalid")
  await assert.rejects(verifyAdmissionAuthority({ person: null, policy: { write_authority: "person", authority_provider: null } }), (error) => error.code === "authority_invalid")
  assert.deepEqual(await verifyAdmissionAuthority({ person: "ari", policy: { write_authority: "person", authority_provider: null } }), { mode: "person", person: "ari" })
  assert.deepEqual(await verifyAdmissionAuthority({ policy: { write_authority: "workspace", authority_provider: null } }), { mode: "workspace" })
})
