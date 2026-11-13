// The boot instruction lets a bounded or "don't boot" session skip the boot and use desk_status and desk-web instead.
// This pins that claim: both servers answer in a fresh desk where no boot script, boot claim or session record exists.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { indexPath, isolatedEnv, makeIsolatedHome } from "../launch/_mcp_handshake.js"
import { openSession } from "../launch/_mcp_session.js"

const WEB = fileURLToPath(new URL("../../../../../plugins/desk/mcp/web.cjs", import.meta.url))

async function freshDesk() {
  const f = await makeIsolatedHome("desk-no-boot-")
  for (const dir of ["_meta", "_archive"]) mkdirSync(path.join(f.desk, dir), { recursive: true })
  return { f, env: isolatedEnv(f, { DESK: f.desk }) }
}

test("desk_status admits the desk and reports ready with no boot run", { timeout: 180000 }, async () => {
  const { f, env } = await freshDesk()
  const server = await openSession({ command: process.execPath, args: [indexPath], cwd: f.desk, env, timeoutMs: 60000 })
  try {
    const status = await server.statusUntil((payload) => payload.state !== "admitting", { deadlineMs: 120000 })
    assert.equal(status.state, "ready", JSON.stringify(status))
    assert.equal(status.status, "ok")
    assert.equal(existsSync(path.join(f.home, ".local", "state", "desk", "copilot-sessions")), false, "no boot or session record was needed")
  } finally {
    await server.close()
  }
})

test("desk-web lists its tools and answers a call with no desk bound and no boot run", { timeout: 60000 }, async () => {
  const { f, env } = await freshDesk()
  delete env.DESK
  const server = await openSession({ command: process.execPath, args: [WEB], cwd: f.root, env })
  try {
    assert.deepEqual(server.tools.result.tools.map((tool) => tool.name).sort(), ["browser_command", "browser_context"])
    const answer = await server.request("tools/call", { name: "browser_context", arguments: { action: "close", contextId: "none" } })
    assert.equal(answer.result.isError, true, "an unknown context is refused as a tool error, not a crash")
    assert.doesNotMatch(answer.result.content[0].text, /\bboot\b/iu, "the refusal never sends the agent to the boot")
  } finally {
    await server.close()
  }
})
