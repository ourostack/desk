// A resumed or compacted session is not asked twice for the same sign-offs, and the boot says nothing about the factory (Epoch 3).
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const gh = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "unexpected call" }
}
const delivered = (title, days) => [
  "schema_version: 1", `title: ${title}`, "status: done", "created: '2026-01-01T00:00:00Z'", "updated: '2026-01-02T00:00:00Z'", "track: ops", "repos: []",
  "signoff:", "  state: delivered_unsigned", "  at: null", "  verified: null", "  reason: null",
  "flow:", "  since: created", "  rev: 1", "  reached: done", `  delivered_at: '${new Date(Date.now() - days * 86_400_000).toISOString()}'`, "  deliveries: 1",
  "evidence:", "  kind: pr", "  ref: https://example.test/pr/7", `  recorded_at: '${new Date(Date.now() - days * 86_400_000).toISOString()}'`,
].join("\n")

async function desk() {
  const root = await mkTempRoot("desk-boot-consent-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  return root
}
async function card(root, slug, frontmatter) {
  const dir = path.join(root, "ops", slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "task.md"), `---\n${frontmatter}\n---\n\nBody.\n`)
}
const boot = (root, extra = {}) => bootOnce({ env: { DESK: root }, cwd: root, homeDir: root, gh, jq, syncFn: async () => ({ state: "synced" }), ...extra })

test("an earlier boot of the same session listed the deliveries: a later boot says so instead of asking for them again; a new delivery is raised again", async () => {
  const root = await desk()
  await card(root, "shipped", delivered("Shipped thing", 9))
  const env = { DESK: root, CLAUDE_CODE_SESSION_ID: "session-1" }
  const first = await boot(root, { env })
  assert.match(first.instructions.find((line) => /sign-off/u.test(line)), /^1 delivered task awaits sign-off/u)
  const again = await boot(root, { env })
  const line = again.instructions.find((entry) => /sign-off/u.test(entry))
  assert.match(line, /^The delivered task that awaits sign-off was already listed by an earlier boot of this session\. Raise it only if this session has not raised it yet, never twice/u)
  const other = await boot(root, { env: { DESK: root, COPILOT_AGENT_SESSION_ID: "copilot-2" } })
  assert.match(other.instructions.find((entry) => /sign-off/u.test(entry)), /^1 delivered task awaits sign-off/u, "another session is asked")
  await card(root, "second", delivered("Second thing", 2))
  const more = await boot(root, { env })
  assert.match(more.instructions.find((entry) => /sign-off/u.test(entry)), /^2 delivered tasks await sign-off/u, "a new delivery means the list is raised")
  const twice = await boot(root, { env })
  assert.match(twice.instructions.find((entry) => /sign-off/u.test(entry)), /^The delivered tasks that await sign-off were already listed/u)
  const noId = await boot(root)
  assert.match(noId.instructions.find((entry) => /sign-off/u.test(entry)), /^2 delivered tasks await sign-off/u, "a host with no session id gets the plain line")
  const quiet = await boot(root, { env: { ...env, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" } })
  assert.ok(!quiet.instructions.some((entry) => /sign-off/u.test(entry)), "a noninteractive session gets no sign-off line")
})

test("the boot says nothing about the factory or the improvement cards", async () => {
  const root = await desk()
  await card(root, "shipped", delivered("Shipped thing", 9))
  const result = await boot(root)
  const all = [...result.instructions, ...result.text_instructions, formatBootText(result)].join("\n")
  assert.doesNotMatch(all, /factory|Improvement cards|improvement card/iu)
  assert.ok(!("factory" in result))
  assert.match(formatBootText(result), /Delivered, awaiting sign-off:\n- ops\/shipped, 9 days/u)
})
