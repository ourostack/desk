import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { normalizePublished } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const FACTS = path.join(here, "..", "fixtures", "store", "facts")
const sessions = readdirSync(FACTS).sort().map((name) => JSON.parse(readFileSync(path.join(FACTS, name), "utf8")))
const byHost = (host) => sessions.filter((session) => session.session.host === host)
const flags = (value) => value.unavailable.map((item) => `${item.field}/${item.reason}`)

function legacy(host, overrides = {}) {
  const base = structuredClone(byHost(host)[0])
  base.schema = "desk.factory.published/1"
  base.unavailable = []
  return Object.assign(base, overrides)
}

test("a /1 Claude session reads as compaction_waits and reasoning_tokens not recorded", () => {
  const out = normalizePublished(legacy("claude-code"))
  assert.ok(flags(out).includes("compaction_waits/host_does_not_record"))
  assert.ok(flags(out).includes("reasoning_tokens/host_does_not_record"))
  assert.ok(flags(out).includes("prs/host_records_partly"))
})

test("a /1 Claude session reads api_retries as recorded only partly", () => {
  const out = normalizePublished(legacy("claude-code"))
  assert.ok(flags(out).includes("api_retries/host_records_partly"))
  assert.equal(out.counts.api_retries, legacy("claude-code").counts.api_retries, "the value is kept")
})

test("a /1 Copilot cli session reads entrypoint as not recorded", () => {
  const session = legacy("copilot-cli")
  session.session.entrypoint = "cli"
  assert.ok(flags(normalizePublished(session)).includes("entrypoint/host_does_not_record"))
  session.session.entrypoint = "desktop"
  assert.equal(flags(normalizePublished(session)).includes("entrypoint/host_does_not_record"), false)
})

test("a /1 session with empty models reads as models, tokens and requests not recorded", () => {
  const out = normalizePublished(legacy("claude-code", { models: [] }))
  for (const field of ["models", "tokens", "requests"]) assert.ok(flags(out).includes(`${field}/field_absent`), field)
  const withModels = normalizePublished(legacy("claude-code"))
  for (const field of ["models", "tokens", "requests"]) assert.equal(flags(withModels).includes(`${field}/field_absent`), false, field)
})

test("empty models is flagged per field: a field that already carries a flag keeps it and the others gain field_absent", () => {
  const session = legacy("claude-code", { models: [], unavailable: [{ field: "tokens", reason: "host_does_not_record" }] })
  const out = normalizePublished(session)
  assert.deepEqual(flags(out).filter((flag) => flag.startsWith("tokens/")), ["tokens/host_does_not_record"])
  assert.ok(flags(out).includes("models/field_absent"))
  assert.ok(flags(out).includes("requests/field_absent"))
})

test("a /1 Codex session with empty models gains models field_absent next to its tokens and requests host flags", () => {
  const session = legacy("claude-code", { models: [] })
  session.session.host = "codex-cli"
  const out = normalizePublished(session)
  assert.ok(flags(out).includes("models/field_absent"))
  assert.ok(flags(out).includes("tokens/host_records_partly"))
  assert.ok(flags(out).includes("requests/host_records_partly"))
  assert.equal(flags(out).includes("tokens/field_absent"), false, "a field that already carries a flag is not flagged again")
})

test("a /1 session that already carries a flag is not given it twice", () => {
  const session = legacy("claude-code", {
    unavailable: [{ field: "reasoning_tokens", reason: "host_does_not_record" }, { field: "permission_waits", reason: "host_does_not_record" }],
  })
  const once = normalizePublished(session)
  assert.equal(flags(once).filter((flag) => flag === "reasoning_tokens/host_does_not_record").length, 1)
  assert.deepEqual(normalizePublished(once).unavailable, once.unavailable, "normalizing twice changes nothing")
  assert.deepEqual(flags(once), [...flags(once)].sort())
})

test("a /2 session is returned unchanged", () => {
  const session = legacy("claude-code", { models: [] })
  session.schema = "desk.factory.published/2"
  assert.deepEqual(normalizePublished(session).unavailable, [])
})

test("a /1 session's absent values are never turned into zero", () => {
  const session = legacy("claude-code", { models: [] })
  session.counts.api_retries = null
  const before = structuredClone(session)
  const out = normalizePublished(session)
  assert.deepEqual(out.models, [])
  assert.equal(out.counts.api_retries, null)
  assert.deepEqual(session, before, "the caller's value is not mutated")
  const keys = (value) => JSON.stringify(Object.keys(value).sort())
  assert.equal(keys(out), keys(before))
  assert.deepEqual(out.counts, before.counts)
})

test("a /1 Claude session reads commits and permission waits as not recorded, never as a measured zero", () => {
  const out = normalizePublished(legacy("claude-code"))
  assert.ok(flags(out).includes("commits/host_does_not_record"))
  assert.ok(flags(out).includes("permission_waits/host_does_not_record"))
  assert.equal(flags(out).includes("api_retries/host_does_not_record"), false, "Claude records retries in part")
})

test("a /1 Codex session reads commits, permission waits and API retries as not recorded", () => {
  const session = legacy("claude-code")
  session.session.host = "codex-cli"
  const out = normalizePublished(session)
  for (const field of ["commits", "permission_waits", "api_retries"]) assert.ok(flags(out).includes(`${field}/host_does_not_record`), field)
})
