// Consent is the boot's last instruction by construction (Package H, poka-yoke), and a resumed or compacted session is not asked twice for the same sign-offs.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce, withConsentLast } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { consentMentioned, noteConsentMentioned } from "../../../../../plugins/desk/mcp/src/runtime/consent-mentioned.js"
import { resolveDeskStateDir } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"

const bootSource = readFileSync(fileURLToPath(new URL("../../../../../plugins/desk/mcp/src/runtime/boot.js", import.meta.url)), "utf8")

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const gh = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "unexpected call" }
}
const UNDECIDED = () => ({ store: "ourostack/factory-intake", source: "x", consent: "undecided", stores: [], warnings: [] })
const OPEN_CARDS = async () => ({ status: "ok", open: 2, oldest_days: 3, open_keys: [], truncated: false, set_aside: 1, unreadable_files: 0 })
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
const boot = (root, extra = {}) => bootOnce({ env: { DESK: root }, cwd: root, homeDir: root, gh, jq, syncFn: async () => ({ state: "synced" }), factoryStatusFn: UNDECIDED, ...extra })
const isConsent = (line) => /Factory consent is undecided|consent --store|account_found/u.test(line)

test("withConsentLast puts the consent block after every other line, whatever the body holds", () => {
  assert.deepEqual(withConsentLast(["a", "b"], ["c1", "c2"]), ["a", "b", "c1", "c2"])
  assert.deepEqual(withConsentLast(["a"], []), ["a"])
  assert.deepEqual(withConsentLast([], ["c"]), ["c"])
})

test("the consent block is built in one place and joined in one place: no producer can put a line after it", () => {
  const consentItems = /function consentItems\(ctx\) \{[\s\S]*?\n\}/u.exec(bootSource)[0]
  for (const call of ["factoryInstructions(", "factoryTextLine("]) {
    const calls = bootSource.split(call).length - 1 - (new RegExp(`function ${call.replace("(", "\\(")}`, "u").test(bootSource) ? 1 : 0)
    assert.equal(calls, 1, `${call} is called once`)
    assert.ok(consentItems.includes(call), `${call} is called only inside consentItems`)
  }
  for (const builder of ["function buildInstructions(ctx)", "function buildTextInstructions(ctx)"]) {
    const body = new RegExp(`${builder.replace(/[()]/gu, "\\$&")} \\{[\\s\\S]*?\\n\\}`, "u").exec(bootSource)[0]
    assert.match(body, /return withConsentLast\(/u, `${builder} returns through withConsentLast`)
  }
})

test("with every producer active (a named task, a failed sync, a bad card, unsigned deliveries, improvement cards, factory findings), consent is last in both boots", async () => {
  const root = await desk()
  await card(root, "shipped", delivered("Shipped thing", 9))
  await card(root, "broken", "title: no schema")
  await card(root, "flash-valves", ["schema_version: 1", "title: Flash valves", "status: processing", "created: '2026-01-01T00:00:00Z'", "updated: '2026-01-02T00:00:00Z'", "track: ops", "repos: []"].join("\n"))
  const result = await boot(root, {
    taskQuery: "flash-valves",
    improvementFn: OPEN_CARDS,
    syncFn: async () => ({ state: "failed", reason: "origin_unreachable" }),
    factoryStatusFn: () => ({ ...UNDECIDED(), orphans: "pass_failed", retention: "prune_failed", capture_check_unavailable: [{ store: "ourostack/factory-intake", times: 3 }] }),
  })
  const json = result.instructions
  assert.equal(json.filter((line) => /^Factory: (orphan pass|local retention|ourostack\/factory-intake: capture record)/u.test(line)).length, 3, "the three factory findings are body lines")
  assert.equal(result.text_instructions.filter((line) => line.startsWith("Factory: ")).length, 3)
  const consentAt = json.findIndex(isConsent)
  assert.ok(consentAt !== -1)
  assert.ok(json.slice(consentAt).every(isConsent), "nothing follows the consent block in --json")
  assert.ok(json.some((line) => /awaits sign-off/u.test(line)) && json.some((line) => line.startsWith("Improvement cards")) && json.some((line) => /desk:session-resumption/u.test(line)))
  assert.ok(json.some((line) => /This boot covers the/u.test(line)), "the closing lines are in --json, before consent")
  const text = result.text_instructions
  assert.equal(text.filter(isConsent).length, 1, "one consent line in the text boot")
  assert.match(text.at(-1), /^Factory consent is undecided/u)
  assert.match(text.at(-2), /^In every reply:/u, "the closing rules come right before consent")
  assert.match(formatBootText(result).trimEnd().split("\n").at(-1), /^\d+\. Factory consent is undecided/u, "the printed boot ends with consent")
})

test("an earlier boot of the same session listed the deliveries: a later boot says so instead of asking for them again; a new delivery is raised again", async () => {
  const root = await desk()
  await card(root, "shipped", delivered("Shipped thing", 9))
  const env = { DESK: root, CLAUDE_CODE_SESSION_ID: "session-1" }
  const first = await boot(root, { env })
  assert.match(first.instructions.find((line) => /sign-off/u.test(line)), /^1 delivered task awaits sign-off/u)
  const again = await boot(root, { env })
  const line = again.instructions.find((entry) => /sign-off/u.test(entry))
  assert.match(line, /^The delivered task that awaits sign-off was already listed by an earlier boot of this session\. Raise it only if this session has not raised it yet, never twice/u)
  assert.match(again.text_instructions.at(-1), /^Factory consent is undecided/u, "consent stays last")
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

test("unsigned deliveries and open improvement cards reach the operator's session in one boot, side by side, before consent", async () => {
  const root = await desk()
  await card(root, "shipped", delivered("Shipped thing", 9))
  await card(root, "second", delivered("Second thing", 3))
  const result = await boot(root, { improvementFn: OPEN_CARDS })
  for (const list of [result.instructions, result.text_instructions]) {
    const signoff = list.findIndex((line) => /await sign-off/u.test(line))
    const cards = list.findIndex((line) => line.startsWith("Improvement cards"))
    assert.ok(signoff !== -1 && cards === signoff + 1, "the sign-off line and the improvement line are adjacent")
    assert.match(list[signoff], /raise them together, once/u)
  }
  assert.match(formatBootText(result), /Delivered, awaiting sign-off:\n- ops\/shipped, 9 days, [^\n]*overdue\n- ops\/second, 3 days/u)
})

// Agency dry runs, 2026-10-12: one session said the contribution sentence twice and the next session said it again. The RFC's contract is
// "asked once at setup", so the agent that says the sentence records it and no later boot hands the sentence out.
test("the sentence about contributing is handed out until an agent records having said it; after that the boot says not to raise it", async () => {
  const root = await desk()
  const stateDir = resolveDeskStateDir({ env: { DESK: root }, homeDir: root })
  const record = /In the same turn, just before the reply that includes it, run `node [^`]*mcp.scripts.factory\.js consent --store ourostack\/factory-intake --mentioned yes`, so that no later session says it again; if the command fails or is refused, say the sentence anyway, do not retry and do not mention it\. If you already said the sentence in this session, do not say it again\. A child agent never says it and never runs the command\./u
  const first = await boot(root)
  assert.match(first.instructions.find(isConsent), record)
  assert.match(first.text_instructions.at(-1), record)
  assert.equal(consentMentioned(stateDir, "ourostack/factory-intake"), false, "the boot itself records nothing: it cannot know the sentence was said")
  assert.match((await boot(root)).text_instructions.at(-1), /"Desk can contribute measurement data/u, "so a second session still gets the sentence")

  noteConsentMentioned(stateDir, "ourostack/factory-intake")
  const later = await boot(root, { env: { DESK: root, CLAUDE_CODE_SESSION_ID: "another-session" } })
  for (const list of [later.instructions, later.text_instructions]) {
    assert.equal(list.filter(isConsent).length, 1)
    assert.match(list.at(-1), /^Factory consent is undecided for ourostack\/factory-intake, and the operator was already told that Desk can contribute to it: do not raise it again\. Only if they say 'factory details' \(or ask what Desk sends\), follow "Factory consent" in .*skills.session-start.details\.md; the script is `node [^`]*mcp.scripts.factory\.js`\.$/u)
    assert.doesNotMatch(list.join("\n"), /"Desk can contribute|want the details|--mentioned|--contribute/u)
  }
  assert.match(formatBootText(later).trimEnd().split("\n").at(-1), /do not raise it again/u)
})

test("an undecided factory notice cannot replace a delivery's required sign-off", async () => {
  const root = await desk()
  const result = await boot(root)
  for (const lines of [result.instructions, result.text_instructions]) {
    const notice = lines.find(isConsent)
    assert.match(notice, /If this reply delivers a task, defer the notice to a later turn and preserve the required sign-off/u)
    assert.doesNotMatch(notice, /end your reply|ask nothing|never as its own decision group/u)
  }
})

test("a session with no operator, or a store that is decided or held, never reads the record", async () => {
  const root = await desk()
  const calls = []
  const consentMentionedFn = (...args) => { calls.push(args); return true }
  const headless = await boot(root, { env: { DESK: root, DESK_FACTORY_HEADLESS: "1" }, consentMentionedFn })
  assert.ok(!headless.instructions.some(isConsent))
  for (const consent of ["yes", "no", "held", "unreadable"]) {
    const decided = await boot(root, { consentMentionedFn, factoryStatusFn: () => ({ ...UNDECIDED(), consent, store: consent === "held" ? null : UNDECIDED().store }) })
    assert.ok(!decided.instructions.some(isConsent), consent)
  }
  assert.ok(!(await boot(root, { consentMentionedFn, factoryStatusFn: () => null })).instructions.some(isConsent))
  assert.deepEqual(calls, [])
  const asked = await boot(root, { consentMentionedFn })
  assert.match(asked.instructions.at(-1), /do not raise it again/u)
  assert.deepEqual(calls, [[resolveDeskStateDir({ env: { DESK: root }, homeDir: root }), "ourostack/factory-intake"]])
})
