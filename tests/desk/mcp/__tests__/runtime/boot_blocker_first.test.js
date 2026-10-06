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
  assert.ok(text.split("\n")[0].includes("waiting on you"))
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

test("a task whose next step or blocker says it lives only on another machine gets a not-here note: ask, never clone or fetch to look for it", () => {
  const base = { status: "ready", degraded: [], pending: [] }
  const tasks = (task) => ({ ...base, active_tasks: { task_count: 1, tracks: [{ track: "lighthouse-relay", desk: null, tasks: [{ slug: "push-check", handle: "h", status: "processing", ...task }] }] } })
  const note = "  not here: do not clone or fetch to look for it; ask the operator to push it from that machine or say where it is; unless the operator's own message already says it is pushed, in which case record that with task_update and retry"
  const real = "Push relay-heartbeat-15s and open a pull request. The branch lives only on the other laptop, not on this machine. First confirm which GitHub account and route can deliver it from here, and tell me."
  for (const task of [{ next_step: real }, { next_step: "the branch exists only on the work laptop" }, { next_step: "Wait", blocker: "branch is on the other machine" }, { status: "blocked", blocker: "relay-heartbeat is not on this machine" }]) {
    const lines = formatBootText(tasks(task)).split("\n")
    const at = lines.indexOf(note)
    assert.ok(at > 0, JSON.stringify(task))
    assert.ok(/^- lighthouse-relay\/push-check/u.test(lines[at - 2] ?? "") || /^  (?:next|blocker):/u.test(lines[at - 1]), "the note sits under its task, after the step")
  }
  assert.ok(!formatBootText(tasks({ next_step: "Thread the flag through cli.py" })).includes("not here:"))
  assert.ok(!formatBootText(tasks({})).includes("not here:"))
})

test("rule 5 is scoped: no clone or fetch to look for what the card says is on another machine, none inside the desk folder, and a missing repo is cloned only where an instruction above says to, in text and in JSON", async () => {
  const root = await deskWithTask(CARD)
  const result = await bootNamed(root, [state({ present: true })])
  const scoped = ["never clone or fetch to look for something the card says is on another machine", "never clone inside the desk folder", "clone a missing repo only where an instruction above says to, at the path it gives"]
  const text = result.text_instructions.find((line) => line.startsWith("In every reply:"))
  const json = result.instructions.find((line) => line.includes("never clone inside the desk folder"))
  for (const piece of scoped) for (const line of [text, json]) assert.ok(line?.toLowerCase().includes(piece), `${piece} in ${line}`)
  assert.ok(!text.includes("to look for it"), "no unscoped 'never clone' left to contradict the missing-clone instruction")
})

test("the ask-then-hand-off instruction is number 1 in text and JSON, before the desk path and the tool names", async () => {
  const root = await deskWithTask(CARD)
  const result = await bootNamed(root, [state({})])
  for (const list of [result.instructions, result.text_instructions]) {
    assert.ok(list[0].includes("ask the operator one question and stop until they answer"), list[0].slice(0, 80))
    assert.ok(list.findIndex((line) => line.includes("as the desk path")) > 0 || list.findIndex((line) => line.includes("the absolute path")) > 0)
    assert.equal(list.filter((line) => line.includes("only then hand off")).length, 1)
  }
  assert.match(formatBootText(result), /Instructions, in order:\n1\. The operator named a task/u)
  const clear = await bootNamed(root, [state({ present: true })])
  assert.ok(!clear.instructions[0].includes("ask the operator one question"), "no blocker, no reorder")
})

test("the not-here rule matches an owner or pointer word with a machine noun and nothing else", () => {
  const note = (next_step) => formatBootText({ status: "ready", degraded: [], pending: [], active_tasks: { task_count: 1, tracks: [{ track: "t", desk: null, tasks: [{ slug: "s", handle: "h", status: "processing", next_step }] }] } }).includes("not here:")
  for (const text of ["The branch lives only on the other laptop, not on this machine.", "the branch is on my work laptop", "it's on my desktop", "not on this machine", "only on the old mac", "it is on the other desktop"]) assert.ok(note(text), text)
  for (const text of ["only on weekdays", "run only on main", "test only on macOS", "this is only on Linux CI", "Ship is only on staging", "verify the flag exists only on Windows", "another machine-readable format", "not on this machine's PATH", "Test the home computer vision module", "old machine learning model", "the work machine-id file", "only on desktop widths"]) assert.ok(!note(text), text)
})

test("a waiting boot says so in a degraded headline too, and the headline names at most three repos while the question stays within 400 characters", async () => {
  const text = formatBootText({ status: "degraded", degraded: ["jq: missing"], needs_operator: { question: "Q?", summary: "x not on this machine" } })
  assert.match(text.split("\n")[0], /^Desk boot: degraded \(jq: missing\), waiting on you \(x not on this machine\)/u)
  assert.equal(formatBootText({ status: "degraded", degraded: [], needs_operator: { question: "Q?", summary: "s" } }).split("\n")[0].startsWith("Desk boot: degraded, waiting on you (s)"), true)
  const root = await deskWithTask(CARD)
  const few = await bootNamed(root, ["a", "b", "c"].map((repo) => state({ repo, local_path: `~/code/${repo}` })))
  assert.equal(few.needs_operator.summary, "a, b, c not on this machine")
  const names = Array.from({ length: 40 }, (_, index) => `valve-firmware-${index}`)
  const many = await bootNamed(root, names.map((repo) => state({ repo, local_path: `~/code/${repo}` })))
  assert.equal(many.needs_operator.summary, "valve-firmware-0, valve-firmware-1, valve-firmware-2 and 37 more not on this machine")
  assert.ok(many.needs_operator.question.length <= 400 && many.needs_operator.question.includes("valve-firmware-0") && /and \d+ more/u.test(many.needs_operator.question), many.needs_operator.question)
  const four = await bootNamed(root, ["a", "b", "c", "d"].map((repo) => state({ repo, local_path: `~/code/${repo}` })))
  assert.ok(four.needs_operator.question.includes("Where is d cloned"), "every repo is in a question that fits")
})
