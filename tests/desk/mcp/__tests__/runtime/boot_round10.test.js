// Round 10 boot fixes: boot text never cuts a task's next step or blocker, the push route line names the account, a
// task_update that leaves next_step alone says so, and a failed Desk call leaves no empty folder behind.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { TASKS_SHOWN_CAP, TEXT_CEILING, ceiling, formatBootText, pushRoute } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { activeTasks, nextStepOf } from "../../../../../plugins/desk/mcp/src/desk/active-tasks.js"
import { task_archive, task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { withCreatedDirs } from "../../../../../plugins/desk/mcp/src/util/created-dirs.js"
import { resolveWriteTarget } from "../../../../../plugins/desk/mcp/src/util/paths.js"

// ── Boot text prints the next step and the blocker whole ────────────────

const task = (extra) => ({ slug: "a-task", title: "a-task", status: "processing", updated: "2026-09-28T00:00:00Z", handle: "task-1", ...extra })
const textFor = (...tasks) => formatBootText({ status: "ready", active_tasks: { task_count: tasks.length, tracks: [{ track: "ops", tasks }] } })

test("a long next step is printed whole, never cut", () => {
  const long = `${"wire the check into RainDelayPolicy.shouldDelay() and then ".repeat(8)}run test_rain_delay_boundary`
  const text = textFor(task({ next_step: long }))
  assert.ok(text.includes(`\n  next: ${long}\n`))
  assert.doesNotMatch(text, /\.\.\.\n/u)
})

test("a task whose card records no next step says so, instead of leaving the agent to fill it in", () => {
  assert.match(textFor(task({ status: "drafting", next_step: null })), /drafting \(1\)\n- ops\/a-task \(updated 2026-09-28\)\n  next: no next step recorded\n/u)
  assert.match(textFor(task({ next_step: "" })), /next: no next step recorded/u)
})

test("a blocked task prints the card's blocker reason, then its next step when it has one", () => {
  const both = textFor(task({ status: "blocked", blocker: "Waiting on the ops team's paging-service key.", next_step: "Wire alert delivery once it arrives." }))
  assert.match(both, /BLOCKED \(1\): [^\n]*\n- ops\/a-task \(updated 2026-09-28\)\n  blocker: Waiting on the ops team's paging-service key\.\n  next: Wire alert delivery once it arrives\.\n/u)
  assert.match(textFor(task({ status: "blocked", blocker: "the key", next_step: null })), /\n  blocker: the key\n$/u)
})

test("a blocked task with no blocker falls back to its next step, and with neither says so", () => {
  assert.match(textFor(task({ status: "blocked", blocker: null, next_step: "Ask ops." })), /\n  blocker: no blocker recorded; next: Ask ops\.\n/u)
  assert.match(textFor(task({ status: "blocked" })), /\n  blocker: no blocker or next step recorded\n/u)
  assert.match(textFor(task({ status: "blocked", blocker: "", next_step: "" })), /blocker: no blocker or next step recorded/u)
})

test("the task list is capped by count, and says how many it left out", () => {
  const many = Array.from({ length: TASKS_SHOWN_CAP + 3 }, (_, index) => task({ slug: `t${index}`, title: `t${index}`, next_step: `step ${index} ${"x".repeat(300)}` }))
  const text = textFor(...many)
  assert.equal((text.match(/^- ops\/t\d+ /gmu) ?? []).length, TASKS_SHOWN_CAP)
  assert.ok(text.includes(`step 0 ${"x".repeat(300)}\n`), "the tasks that are shown are whole")
  assert.match(text, /\n\.\.\.and 3 more active tasks \(all of them are in `active_tasks` with `--json`\)\n/u)
  assert.doesNotMatch(textFor(...many.slice(0, TASKS_SHOWN_CAP)), /more active tasks/u)
})

// ── The card's blocker, as active_tasks reads it ────────────────────────

async function cards(bodies) {
  const root = await mkTempRoot("desk-blocker-")
  for (const [slug, body] of Object.entries(bodies)) {
    await fs.mkdir(path.join(root, "ops", slug), { recursive: true })
    await fs.writeFile(path.join(root, "ops", slug, "task.md"), `---\ntitle: ${slug}\nstatus: blocked\nupdated: "2026-09-22T00:00:00Z"\n---\n\n${body}`)
  }
  return Object.fromEntries(activeTasks(root).tracks[0].tasks.map((entry) => [entry.slug, entry.blocker]))
}

test("active_tasks reads the blocker from a section, a labelled line or a label with the reason below it", async () => {
  const blockers = await cards({
    heading: "## Blocker\n\nWaiting on the ops team to provision the key;\ncannot wire alert delivery without it.\n\n## Next\n",
    waiting: "## Waiting on\n\nLegal sign-off.\n",
    bold: "Intro.\n\n**Blocker:** the vendor API is down\nuntil Friday.\n\n- other\n",
    plain: "Waiting on: design review\n",
    boldNoColon: "**Blocked by** the freeze\n",
    below: "**Blocker:**\n\nThe key is missing.\n",
    emptyHeading: "## Blocker\n\n## Other\n\nBlocker: second try\n",
    secret: "Blocker: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 expired\n",
    none: "Just a body.\n",
    stopsAtList: "Blocker: needs a key\n- a list item\n",
    emptyAll: "**Blocker:**\n",
  })
  assert.equal(blockers.heading, "Waiting on the ops team to provision the key; cannot wire alert delivery without it.")
  assert.equal(blockers.waiting, "Legal sign-off.")
  assert.equal(blockers.bold, "the vendor API is down until Friday.")
  assert.equal(blockers.plain, "design review")
  assert.equal(blockers.boldNoColon, "the freeze")
  assert.equal(blockers.below, "The key is missing.")
  assert.equal(blockers.emptyHeading, "second try")
  assert.doesNotMatch(blockers.secret, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/u)
  assert.equal(blockers.none, null)
  assert.equal(blockers.stopsAtList, "needs a key")
  assert.equal(blockers.emptyAll, null)
})

// ── The push route names the account, and the fork ──────────────────────

test("pushRoute names the account, the fork it pushes to, and the active account when that is a different one", () => {
  assert.equal(pushRoute({ store: "acme/widgets", account: "arimendelow", route: "fork", accounts: [{ account: "arimendelow_microsoft" }] }), "push as arimendelow via fork arimendelow/widgets. The active gh account is arimendelow_microsoft; Desk routes this repo's pushes through the fork and did not check that account's own access.")
  assert.equal(pushRoute({ store: "acme/widgets", account: "ari", route: "fork", accounts: [{ account: "ari" }] }), "push as ari via fork ari/widgets")
  assert.equal(pushRoute({ store: "acme/widgets", account: "ari", route: "direct", accounts: [{ account: "work" }] }), "push as ari (route direct). The active gh account is work; Desk routes this repo's pushes through ari and did not check that account's own access.")
  assert.equal(pushRoute({ store: "acme/widgets", account: "ari", accounts: [] }), "push as ari")
  assert.equal(pushRoute({ account: "ari", route: "fork" }), "push as ari via fork ari's fork of ")
  assert.equal(pushRoute({ store: "weird", account: "ari", route: "fork" }), "push as ari via fork ari's fork of weird")
})

test("boot text prints a fork route once, on its task, with the account to push as and the one to leave out of notes", () => {
  const text = formatBootText({
    status: "ready",
    active_tasks: { task_count: 1, tracks: [{ track: "lighthouse", tasks: [task({ slug: "push-check", title: "push-check", next_step: "push it" })] }] },
    push_accounts: [{ track: "lighthouse", slug: "push-check", repo: "anthropics/claude-code", store: "anthropics/claude-code", result: "account_found", account: "arimendelow", route: "fork", accounts: [{ account: "arimendelow_microsoft" }, { account: "arimendelow" }] }],
  })
  assert.match(text, /\n  push: anthropics\/claude-code: push as arimendelow via fork arimendelow\/claude-code\. The active gh account is arimendelow_microsoft; Desk routes this repo's pushes through the fork and did not check that account's own access\. Push your branch to the fork and open the pull request from it; never push to anthropics\/claude-code itself\. For git and gh calls use `GH_TOKEN=\$\(gh auth token --user arimendelow\)`, and name arimendelow, never arimendelow_microsoft, as the push account in any note\. Say this route in one line when you report on the task\. Desk resolved this route, so say it rather than re-checking it with gh\. Using the token inside the git or gh call as above is fine; never print, count or test it on its own, and if a gh call fails, report the error as it is\.\n/u)
  assert.equal(text.split("anthropics/claude-code").length - 1, 2, "the route is told once: on the task, naming the store twice")
  assert.doesNotMatch(text, /Push routes:/u)
})

const VERSION_OK = "gh version 2.54.0 (2024-07-31)\n"
const NO_PUSH = { full_name: "acme/widgets", private: false, allow_forking: true, default_branch: "main", permissions: { push: false, pull: true } }
const PUSH = { ...NO_PUSH, permissions: { push: true, pull: true } }
function fakeGh({ accounts, repos }) {
  return async (args, { token } = {}) => {
    if (args[0] === "--version") return { code: 0, stdout: VERSION_OK, stderr: "" }
    if (args[0] === "auth" && args[1] === "status") {
      const block = ({ login, active }) => `  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: ${active}\n`
      return { code: 0, stdout: `github.com\n${accounts.map(block).join("\n")}`, stderr: "" }
    }
    if (args[0] === "auth" && args[1] === "token") return { code: 0, stdout: `token-${args[3]}\n`, stderr: "" }
    if (args[0] === "api") {
      const login = typeof token === "string" ? token.replace(/^token-/u, "") : null
      const answer = repos[login]
      if (typeof answer === "number") return { code: 1, stdout: "{}", stderr: `gh: Not Found (HTTP ${answer})\n` }
      return { code: 0, stdout: JSON.stringify(answer), stderr: "" }
    }
    return { code: 1, stdout: "", stderr: "unexpected call" }
  }
}

async function bootWith(gh) {
  const root = await mkTempRoot("desk-boot-round10-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  await fs.mkdir(path.join(root, "ops", "one"), { recursive: true })
  await fs.writeFile(path.join(root, "ops", "one", "task.md"), `---\nschema_version: 1\ntitle: One\nstatus: processing\ncreated: '2026-01-01T00:00:00Z'\nupdated: '2026-01-02T00:00:00Z'\ntrack: ops\nrepos:\n  - name: acme/widgets\n    local_path: ""\n    mode: remote\n---\n\nBody.\n`)
  return bootOnce({ env: { DESK: root }, cwd: root, homeDir: root, gh, jq: async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" }), syncFn: async () => ({ state: "synced" }), factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }) })
}

test("bootOnce: a fork route with a different active account says to push as the fork account and never to write the active one", async () => {
  const gh = fakeGh({ accounts: [{ login: "work", active: true }, { login: "ari", active: false }], repos: { work: 404, ari: NO_PUSH } })
  const result = await bootWith(gh)
  const line = result.instructions.find((entry) => entry.startsWith("Push route for acme/widgets"))
  assert.match(line, /: push as \S+ via fork \S+\/widgets\. The active gh account is work; Desk routes this repo's pushes through the fork and its own access check could not see the repository\. Account \S+ cannot push to it directly\. Push your branch/u)
  assert.match(line, /Push as \S+ \(`GH_TOKEN=\$\(gh auth token --user \S+\)` for the git or gh call\), and write \S+, never work, as the push account in any note\./u)
})

test("bootOnce: the text boot prints a fork route on its task and not among the instructions; --json keeps the instruction", async () => {
  const result = await bootWith(fakeGh({ accounts: [{ login: "work", active: true }, { login: "ari", active: false }], repos: { work: 404, ari: NO_PUSH } }))
  assert.ok(result.instructions.some((entry) => entry.startsWith("Push route for acme/widgets")))
  assert.ok(!result.text_instructions.some((entry) => /Push route|push as/u.test(entry)))
  const text = formatBootText(result)
  assert.equal(text.split("push as ari via fork ari/widgets").length, 2, "told once")
  assert.match(text, /\n- ops\/one "One" \(updated 2026-01-02\)\n  next: no next step recorded\n  push: acme\/widgets: push as ari via fork ari\/widgets\./u)
  assert.doesNotMatch(text, /Push routes:|no GitHub remote/u)
})

test("boot text names each signed-in account's reason when none can push, and a direct route by another account", () => {
  const entry = (extra) => ({ track: "ops", slug: "a-task", repo: "acme/widgets", store: "acme/widgets", ...extra })
  const text = formatBootText({
    status: "ready",
    active_tasks: { task_count: 1, tracks: [{ track: "ops", tasks: [task({ slug: "a-task", title: "a-task", next_step: "n" })] }] },
    push_accounts: [entry({ result: "no_account_can_deliver", accounts: [{ account: "work", reason: "managed_account" }, { account: "ari", reason: "store_not_visible" }] }), entry({ repo: "acme/direct", store: "acme/direct", result: "account_found", account: "ari", route: "direct", accounts: [{ account: "work" }, { account: "ari" }] })],
  })
  assert.match(text, /\n  push: acme\/widgets: no signed-in account can push \(work: managed_account; ari: store_not_visible\)\. Do not push; ask the operator which account to use, or fork\. Say this route in one line when you report on the task\.\n/u)
  assert.match(text, /\n  push: acme\/direct: push as ari \(route direct\)\. The active gh account is work; .* For git and gh calls use `GH_TOKEN=\$\(gh auth token --user ari\)`, and name ari, never work, as the push account in any note\. Say this route in one line when you report on the task\. Desk resolved this route, so say it rather than re-checking it with gh\. Using the token inside the git or gh call as above is fine; never print, count or test it on its own, and if a gh call fails, report the error as it is\.\n/u)
  assert.doesNotMatch(text, /never push to acme\/direct itself/u, "only a fork route says never push to the store")
})

test("bootOnce: a fork route by the active account adds no active-account sentence", async () => {
  const result = await bootWith(fakeGh({ accounts: [{ login: "ari", active: true }], repos: { ari: NO_PUSH } }))
  const line = result.instructions.find((entry) => entry.startsWith("Push route for acme/widgets"))
  assert.match(line, /push as ari via fork ari\/widgets; account ari cannot push/u)
  assert.doesNotMatch(line, /active gh account|, never ari,/u)
})

test("bootOnce: a direct push by the active account still adds no route line", async () => {
  const result = await bootWith(fakeGh({ accounts: [{ login: "ari", active: true }], repos: { ari: PUSH } }))
  assert.ok(!result.instructions.some((line) => /Push route/u.test(line)))
})

// ── task_update shows an untouched next step ────────────────────────────

async function deskWithTask(body = "**Next step:** wire the check.\n") {
  const root = await mkTempRoot("desk-round10-update-")
  await task_create({ deskRoot: root, input: { track: "t", slug: "s", title: "S", body } })
  return root
}

test("task_update with a note and no next_step shows the current next step and says it was not touched", async () => {
  const root = await deskWithTask()
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "s", note: "wired it" } })
  assert.equal(result.next_step, "wire the check.")
  assert.equal(result.next_step_note, "next_step unchanged — update it if this work changed it")
})

test("task_update with a status change and no next_step shows the step too, and null when the card has none", async () => {
  const root = await deskWithTask("No step here.\n")
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "s", frontmatter: { status: "processing" } } })
  assert.equal(result.next_step, null)
  assert.match(result.next_step_note, /^next_step unchanged/u)
})

test("task_update that sets next_step, or changes neither status nor note, adds no reminder", async () => {
  const root = await deskWithTask()
  const set = await task_update({ deskRoot: root, input: { track: "t", slug: "s", note: "did it", next_step: "open the PR" } })
  assert.equal(Object.hasOwn(set, "next_step"), false)
  assert.equal(Object.hasOwn(set, "next_step_note"), false)
  const other = await task_update({ deskRoot: root, input: { track: "t", slug: "s", body_append: "More." } })
  assert.equal(Object.hasOwn(other, "next_step_note"), false)
})

test("nextStepOf is exported for the response and returns the whole step", () => {
  assert.equal(nextStepOf("x\n\n**Next step:** a\nb.\n"), "a b.")
  assert.equal(nextStepOf("none"), null)
})

// ── A failed call leaves no empty folder ────────────────────────────────

const tree = async (root) => (await fs.readdir(root, { recursive: true })).sort()

test("a task_update on a task that does not exist, for a person with no folder yet, creates no desks/<alias> folder", async () => {
  const root = await mkTempRoot("desk-round10-person-")
  const before = await tree(root)
  await assert.rejects(task_update({ deskRoot: root, person: "newcomer", input: { track: "t", slug: "missing", note: "x" } }), /task does not exist/u)
  assert.deepEqual(await tree(root), before)
})

test("a refused task_create (a bad name) for a person with no folder yet creates nothing, and a good one creates the folder with the write", async () => {
  const root = await mkTempRoot("desk-round10-person-")
  const before = await tree(root)
  await assert.rejects(task_create({ deskRoot: root, person: "newcomer", input: { track: "t", slug: "Bad Name!", title: "T" } }))
  assert.deepEqual(await tree(root), before)
  await task_create({ deskRoot: root, person: "newcomer", input: { track: "t", slug: "good", title: "T" } })
  assert.ok((await tree(root)).includes(path.join("desks", "newcomer", "t", "good", "task.md")))
})

test("resolveWriteTarget names a missing person root's target without creating it", async () => {
  const root = await mkTempRoot("desk-round10-resolve-")
  const target = await resolveWriteTarget({ deskRoot: root, person: "x", segments: ["t", "task.md"] })
  assert.equal(target, path.join(root, "desks", "x", "t", "task.md"))
  assert.deepEqual(await tree(root), [])
})

test("withCreatedDirs keeps the folders when the work succeeds, removes the ones it made when it throws, and leaves a folder that held something", async () => {
  const root = await mkTempRoot("desk-round10-dirs-")
  const kept = await withCreatedDirs(path.join(root, "a", "b"), async () => "ok")
  assert.equal(kept, "ok")
  assert.deepEqual(await tree(root), ["a", path.join("a", "b")])
  await assert.rejects(withCreatedDirs(path.join(root, "c", "d"), async () => { throw new Error("boom") }), /boom/u)
  assert.deepEqual(await tree(root), ["a", path.join("a", "b")])
  await assert.rejects(withCreatedDirs(path.join(root, "a", "b"), async () => { throw new Error("again") }), /again/u)
  assert.deepEqual(await tree(root), ["a", path.join("a", "b")], "a folder that already existed is never removed")
  await assert.rejects(withCreatedDirs(path.join(root, "a", "e", "f"), async () => {
    await fs.writeFile(path.join(root, "a", "e", "f", "kept.txt"), "x")
    throw new Error("late")
  }), /late/u)
  assert.ok((await tree(root)).includes(path.join("a", "e", "f", "kept.txt")), "a folder with a file in it stays")
})

test("a task_archive whose rename fails leaves no empty _archive folder", async () => {
  const root = await deskWithTask()
  const before = await tree(root)
  const realRename = fs.rename
  fs.rename = async () => { throw new Error("rename failed") }
  try {
    await assert.rejects(task_archive({ deskRoot: root, input: { track: "t", slug: "s", outcome: "cancelled" } }), /rename failed/u)
  } finally {
    fs.rename = realRename
  }
  assert.deepEqual(await tree(root), before)
})

test("two concurrent calls into a new folder: the one that made it fails, the other still finds it, and the folder stays", async () => {
  const root = await mkTempRoot("desk-round10-race-")
  const target = path.join(root, "new", "dest")
  let releaseFirst
  let releaseSecond
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const secondGate = new Promise((resolve) => { releaseSecond = resolve })
  const first = withCreatedDirs(target, async () => { await firstGate; throw new Error("first failed") })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = withCreatedDirs(target, async () => { await secondGate; return (await fs.stat(target)).isDirectory() })
  await new Promise((resolve) => setTimeout(resolve, 10))
  releaseFirst()
  await assert.rejects(first, /first failed/u)
  assert.ok((await fs.stat(target)).isDirectory(), "the folder the second call is using survives the first call's failure")
  releaseSecond()
  assert.equal(await second, true)
  assert.ok((await fs.stat(target)).isDirectory(), "and stays after the second succeeds")
})

test("a parent folder is kept while another in-flight call works under it, and removed once nothing does", async () => {
  const root = await mkTempRoot("desk-round10-race2-")
  let releaseChild
  const childGate = new Promise((resolve) => { releaseChild = resolve })
  const child = withCreatedDirs(path.join(root, "a", "b"), async () => { await childGate })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await assert.rejects(withCreatedDirs(path.join(root, "a"), async () => { throw new Error("parent failed") }), /parent failed/u)
  assert.ok((await fs.stat(path.join(root, "a", "b"))).isDirectory())
  let releaseOther
  const other = withCreatedDirs(path.join(root, "unrelated"), async () => { await new Promise((resolve) => { releaseOther = resolve }) })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await assert.rejects(withCreatedDirs(path.join(root, "x", "y"), async () => { throw new Error("alone") }), /alone/u)
  await assert.rejects(fs.stat(path.join(root, "x")), { code: "ENOENT" }, "an unrelated in-flight folder does not keep it")
  releaseOther()
  releaseChild()
  await Promise.all([child, other])
})

// ── Review: ceiling, blocker forms, sort order, terminal status ─────────

test("a next step or blocker over the ceiling is cut at a word boundary, keeps identifiers and code spans whole, and points at the card", () => {
  assert.equal(ceiling("short"), "short")
  assert.equal(ceiling("a".repeat(TEXT_CEILING)), "a".repeat(TEXT_CEILING))
  const words = `${"word ".repeat(150)}RainDelayPolicy.shouldDelay()`
  const cut = ceiling(words)
  assert.ok(cut.endsWith(" ... (see card)"))
  assert.ok(cut.length <= TEXT_CEILING + 20)
  assert.doesNotMatch(cut, /\bwor\b|\bwo\b/u)
  const span = `${"x ".repeat(295)}\`some identifier with spaces\` and more words after it`
  assert.ok(!ceiling(span).includes("`"), "an open code span is dropped whole, never split")
  const bigWord = `${"y".repeat(700)} tail`
  assert.equal(ceiling(bigWord), `${"y".repeat(700)} ... (see card)`)
  assert.equal(ceiling("z".repeat(700)), "z".repeat(700) + " ... (see card)".replace(/^/u, "") )
  const printed = textFor(task({ status: "blocked", blocker: `${"reason ".repeat(120)}end`, next_step: `${"step ".repeat(200)}end` }))
  assert.equal((printed.match(/\(see card\)/gu) ?? []).length, 2)
  assert.match(textFor(task({ status: "blocked", blocker: null, next_step: "n ".repeat(400) })), /no blocker recorded; next: .* \.\.\. \(see card\)/u)
})

test("blocked tasks come first, then the most recently updated, before the cap applies", () => {
  const rows = [
    ...Array.from({ length: TASKS_SHOWN_CAP }, (_, index) => task({ slug: `new${index}`, title: `new${index}`, updated: `2026-09-${String(10 + index).padStart(2, "0")}T00:00:00Z`, next_step: "n" })),
    task({ slug: "old-blocked", title: "old-blocked", status: "blocked", updated: "2026-01-01T00:00:00Z", blocker: "the key" }),
    task({ slug: "no-date", title: "no-date", updated: undefined, next_step: "n" }),
  ]
  const text = formatBootText({ status: "ready", active_tasks: { task_count: rows.length, tracks: [{ track: "ops", tasks: rows }] } })
  const order = [...text.matchAll(/^- ops\/(\S+)/gmu)].map((match) => match[1])
  assert.equal(order[0], "old-blocked")
  assert.equal(order[1], `new${TASKS_SHOWN_CAP - 1}`, "then newest first")
  assert.ok(!order.includes("no-date"), "an undated task sorts last and falls under the cap")
  assert.match(text, /and 2 more active tasks/u)
})

test("active_tasks reads the blocker from a Blockers list, a list item, a quote and a wrapped line, skips fences and 'none'", async () => {
  const blockers = await cards({
    list: "## Blockers\n\n- Waiting on the key\n  from the ops team\n- Legal review\n- n/a\n\n## Other\n",
    numbered: "## Blockers\n\n1. Design\n2. Budget\n",
    allNone: "## Blockers\n\n- none\n",
    listItem: "- **Blocker:** the vendor is down\n- other\n",
    quote: "> Blocker: waiting on QA\n> still waiting\n",
    stopsAtLabel: "**Blocker:** needs a key\n**Owner:** ops\n",
    fenced: "```\n**Blocker:** inside a fence\n```\nBlocker: the real one\n",
    tilde: "~~~md\n## Blockers\n- no\n~~~\n",
    none: "Blocker: none\n",
    na: "**Blocker:** N/A.\n",
    sectionPara: "## Blocker\n\nA paragraph\nthat wraps.\n\n**Owner:** x\n",
    sectionLabelFirst: "## Blocker\n\n**Owner:** x\n",
    sectionEmpty: "## Blocker\n",
    nothingThenReal: "Blocker: none\n\nWaiting on: the key\n",
  })
  assert.equal(blockers.list, "Waiting on the key from the ops team; Legal review")
  assert.equal(blockers.numbered, "Design; Budget")
  assert.equal(blockers.allNone, null)
  assert.equal(blockers.listItem, "the vendor is down")
  assert.equal(blockers.quote, "waiting on QA still waiting")
  assert.equal(blockers.stopsAtLabel, "needs a key")
  assert.equal(blockers.fenced, "the real one")
  assert.equal(blockers.tilde, null)
  assert.equal(blockers.none, null)
  assert.equal(blockers.na, null)
  assert.equal(blockers.sectionPara, "A paragraph that wraps.")
  assert.equal(blockers.sectionLabelFirst, null)
  assert.equal(blockers.sectionEmpty, null)
  assert.equal(blockers.nothingThenReal, "the key")
})

test("a next step stops at the next labelled field and ignores a fenced marker", () => {
  assert.equal(nextStepOf("**Next step:** wire it\nthen test it\n**Owner:** ops\n"), "wire it then test it")
  assert.equal(nextStepOf("```\n**Next step:** inside\n```\n**Next step:** real\n"), "real")
  assert.equal(nextStepOf("```\n**Next step:** never closed\n"), null)
  assert.equal(nextStepOf("~~~\ncode\n~~~\n**Next step:** after\n"), "after")
  assert.equal(nextStepOf("````\n```\n**Next step:** deep\n````\n**Next step:** out\n"), "out")
})

test("task_update into a terminal status adds no next-step reminder", async () => {
  const root = await deskWithTask()
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "s", note: "abandoned", frontmatter: { status: "cancelled" } } })
  assert.equal(Object.hasOwn(result, "next_step_note"), false)
  assert.equal(Object.hasOwn(result, "next_step"), false)
})
