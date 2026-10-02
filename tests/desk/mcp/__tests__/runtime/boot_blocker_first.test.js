// Blocker first: a boot that must ask the operator one question says so right after the headline, in JSON and text, and drops the consent line.
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { shellQuote, shellQuotePath } from "../../../../../plugins/desk/mcp/src/util/shell-quote.js"
import { bootOnce, cardProblems, repoStates } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const gh = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "unexpected call" }
}

async function deskWithTask(repoLines) {
  const root = await mkTempRoot("desk-boot-blocker-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  const dir = path.join(root, "ops", "flash-valves")
  await fs.mkdir(dir, { recursive: true })
  const card = ["schema_version: 1", "title: Flash valves", "status: processing", "created: '2026-01-01T00:00:00Z'", "updated: '2026-01-02T00:00:00Z'", "track: ops", `repos:\n${repoLines}`].join("\n")
  await fs.writeFile(path.join(dir, "task.md"), `---\n${card}\n---\n\nBody.\n`)
  return root
}

function bootNamed(root, states, consent = "held", taskQuery = "flash-valves") {
  return bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, taskQuery,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => (consent === "undecided" ? { store: "ourostack/factory-intake", source: "x", consent, stores: [], warnings: [] } : { store: null, source: "no_remote", consent, stores: [], warnings: [] }),
    repoFn: () => ({ states, pending: [] }),
  })
}

const state = (extra) => ({ track: "ops", slug: "flash-valves", repo: "valve-firmware", local_path: "~/code/valve-firmware", present: false, ...extra })
const CARD = "  - name: valve-firmware\n    local_path: ~/code/valve-firmware\n    mode: local"

test("needs_operator and the Needs you first line carry the one question for a missing repo with no clone source", async () => {
  const root = await deskWithTask(CARD)
  const result = await bootNamed(root, [state({})])
  assert.deepEqual(result.needs_operator, { question: "Where is valve-firmware cloned, or what URL should I clone it from?", summary: "valve-firmware not on this machine" })
  const lines = formatBootText(result).split("\n")
  assert.match(lines[0], /^Desk boot: ready, waiting on you \(valve-firmware not on this machine\) \| desk /u)
  assert.equal(lines[1], "Needs you first: Where is valve-firmware cloned, or what URL should I clone it from?")
  assert.ok(result.text_instructions.some((line) => line.includes("only then hand off to desk:session-resumption")), "the blocker instruction is unchanged")
})

test("two blockers join their questions and names", async () => {
  const root = await deskWithTask(CARD)
  const result = await bootNamed(root, [state({}), state({ repo: "relay", local_path: "~/code/relay" })])
  assert.equal(result.needs_operator.summary, "valve-firmware, relay not on this machine")
  assert.match(result.needs_operator.question, /valve-firmware cloned.*\? Where is relay cloned/u)
})

test("needs_operator is null with no named task, an unmatched task, a present repo or a repo that can be cloned, and the headline stays plain", async () => {
  const root = await deskWithTask(CARD)
  for (const result of [await bootNamed(root, [state({})], "held", null), await bootNamed(root, [state({})], "held", "no-such-task"), await bootNamed(root, [state({ present: true })]), await bootNamed(root, [state({ url: "https://example.com/a/v.git" })])]) {
    assert.equal(result.needs_operator, null)
    const text = formatBootText(result)
    assert.match(text.split("\n")[0], /^Desk boot: ready \|/u)
    assert.ok(!text.includes("Needs you first"))
  }
})

test("a degraded boot keeps its degraded headline and still prints the Needs you first line", () => {
  const text = formatBootText({ status: "degraded", degraded: ["jq: missing"], needs_operator: { question: "Where is x cloned?", summary: "x not on this machine" } })
  assert.match(text.split("\n")[0], /^Desk boot: degraded/u)
  assert.ok(!text.split("\n")[0].includes("waiting on you"))
  assert.equal(text.split("\n")[1], "Needs you first: Where is x cloned?")
})

test("with an ask-and-stop blocker the boot omits the factory consent instruction in JSON and in text; without one it is there", async () => {
  const root = await deskWithTask(CARD)
  const stopped = await bootNamed(root, [state({})], "undecided")
  for (const list of [stopped.instructions, stopped.text_instructions]) assert.ok(!list.some((line) => /Factory consent|factory details/u.test(line)), "no consent line while the operator has a question to answer")
  assert.ok(!formatBootText(stopped).includes("Factory consent"))
  const clear = await bootNamed(root, [state({ present: true })], "undecided")
  assert.ok(clear.instructions.some((line) => line.startsWith("Factory consent is undecided")))
  assert.ok(clear.text_instructions.some((line) => line.startsWith("Factory consent is undecided")))
})
