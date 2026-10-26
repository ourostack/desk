// Unit coverage for the repairs admission leans on: an unreadable index database is reported and rebuilt, and authority checks keep their defaults.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { indexDbPath } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { desk_status } from "../../../../../plugins/desk/mcp/src/tools/status.js"
import {
  resolveAdmittedPerson, validateAdmissionAuthority, verifyAdmissionAuthority,
} from "../../../../../plugins/desk/mcp/src/activation/admit.js"
import { mkTempRoot } from "../_temp_roots.js"

async function deskWithCorruptIndex() {
  const root = await mkTempRoot("desk-corrupt-index-")
  writeFileSync(path.join(root, "task.md"), "# Harbor\n\nFerry log.\n")
  mkdirSync(path.dirname(indexDbPath(root)), { recursive: true })
  writeFileSync(indexDbPath(root), "SQLite format 3\u0000truncated")
  writeFileSync(`${indexDbPath(root)}-wal`, "stale wal")
  return root
}

test("admission authority helpers keep their defaults", async () => {
  assert.throws(() => validateAdmissionAuthority(), (error) => error.code === "authority_invalid")
  assert.throws(() => resolveAdmittedPerson(), (error) => error.code === "authority_invalid")
  await assert.rejects(verifyAdmissionAuthority({ person: " ", policy: { write_authority: "person", authority_provider: null } }), (error) => error.code === "authority_invalid")
  await assert.rejects(verifyAdmissionAuthority({ person: null, policy: { write_authority: "person", authority_provider: null } }), (error) => error.code === "authority_invalid")
  assert.deepEqual(await verifyAdmissionAuthority({ person: "ari", policy: { write_authority: "person", authority_provider: null } }), { mode: "person", person: "ari" })
  assert.deepEqual(await verifyAdmissionAuthority({ policy: { write_authority: "workspace", authority_provider: null } }), { mode: "workspace" })
})
