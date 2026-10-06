// Round S2: a named task leads in full and the rest are one line; a failed sync is worded as one; no mode line for a missing repo.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const gh = async (args) => (args[0] === "--version" ? { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" } : args[0] === "auth" && args[1] === "status" ? { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" } : { code: 1, stdout: "", stderr: "x" })

async function desk(slugs) {
  const root = await mkTempRoot("desk-boot-named-first-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  for (const [index, slug] of slugs.entries()) {
    const dir = path.join(root, "ops", slug)
    await fs.mkdir(dir, { recursive: true })
    const status = index === 1 ? "blocked" : index === 2 ? "drafting" : "processing"
    const card = ["schema_version: 1", `title: ${slug}`, `status: ${status}`, "created: '2026-01-01T00:00:00Z'", `updated: '2026-01-0${index + 2}T00:00:00Z'`, "track: ops", "repos:\n  - name: valve-firmware\n    local_path: ~/code/valve-firmware\n    mode: local"].join("\n")
    await fs.writeFile(path.join(dir, "task.md"), `---\n${card}\n---\n\n**Next step:** do ${slug}.\n`)
  }
  return root
}
const boot = (root, taskQuery, extra = {}) => bootOnce({ env: { DESK: root }, cwd: root, homeDir: root, gh, jq, taskQuery, syncFn: async () => ({ state: "synced" }), factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }), repoFn: () => ({ states: [], pending: [] }), ...extra })

test("with one task named, the text shows that task's block in full and one line for the rest; --json keeps every task", async () => {
  const root = await desk(["flash-valves", "relay-check", "soil-dashboard", "water-api"])
  const result = await boot(root, "flash-valves")
  const text = formatBootText(result)
  assert.deepEqual([...text.matchAll(/^- ops\/(\S+)/gmu)].map((match) => match[1]), ["flash-valves"])
  assert.match(text, /\n  next: do flash-valves\./u)
  assert.match(text, /\nOther active tasks: 3 \(say 'where were we' to list them\)/u)
  for (const other of ["relay-check", "soil-dashboard", "water-api"]) assert.ok(!text.includes(other), other)
  assert.ok(!/^BLOCKED \(/mu.test(text) && !/^drafting \(/mu.test(text), "no blocked or drafting lists")
  assert.equal(result.active_tasks.task_count, 4)
  assert.equal(result.active_tasks.tracks.flatMap((track) => track.tasks).length, 4)
})

test("with no name, an unmatched name or an ambiguous one, the text keeps the full lists", async () => {
  const root = await desk(["flash-valves", "relay-check", "soil-dashboard", "water-api"])
  for (const query of [null, "no-such-task-here", "ops"]) {
    const text = formatBootText(await boot(root, query))
    assert.ok(!text.includes("Other active tasks"), String(query))
    for (const slug of ["flash-valves", "relay-check", "soil-dashboard", "water-api"]) assert.ok(text.includes(`ops/${slug}`), `${query}: ${slug}`)
  }
})

test("a named task that is the only active task prints no 'Other active tasks' line", async () => {
  const root = await desk(["flash-valves"])
  const text = formatBootText(await boot(root, "flash-valves"))
  assert.ok(!text.includes("Other active tasks"))
  assert.ok(text.includes("ops/flash-valves"))
})

test("no instruction in a named boot refers to a task list that is no longer printed", async () => {
  const root = await desk(["flash-valves", "relay-check"])
  const result = await boot(root, "flash-valves")
  for (const line of result.text_instructions) assert.ok(!/Active tasks|active_tasks|status block from/u.test(line.replace("skipping the status block", "").replace("skip the status block", "")), line)
  assert.ok(!formatBootText(result).includes("report every task under"))
})

test("a missing repo prints no mode line: boot says 'not at <path>' and never repeats the card's mode: local", async () => {
  const root = await desk(["flash-valves", "relay-check"])
  const result = await boot(root, "flash-valves", { repoFn: () => ({ states: [{ track: "ops", slug: "flash-valves", repo: "valve-firmware", local_path: "~/code/valve-firmware", present: false }], pending: [] }) })
  const text = formatBootText(result)
  assert.match(text, /- valve-firmware \(ops\/flash-valves\): not at ~\/code\/valve-firmware/u)
  assert.ok(!/mode:/u.test(text.split("Instructions, in order:")[0]), "no mode line before the instructions")
})

test("a boot degraded by a failed sync tells the reply to open with the sync sentence, in the closing rule of the plain-text boot (the text both hosts read); a synced boot does not", async () => {
  const root = await desk(["flash-valves"])
  const failed = await boot(root, null, { syncFn: async () => ({ state: "unresolved", cause: "unreachable" }) })
  const rule = failed.text_instructions.find((line) => line.startsWith("In every reply:"))
  assert.match(formatBootText(failed), /Desk boot: degraded \(sync failed/u)
  assert.ok(rule.includes('Desk could not sync: open your reply with "Desk could not sync with origin (remote unreachable); working from local state" before anything else, and never use "synced" for it.'), rule)
  assert.ok(!rule.includes("<reason>"), "the real reason, never a placeholder")
  assert.ok(!failed.instructions.some((line) => line.includes("never use \"synced\"")), "JSON instructions are unchanged")
  const ok = await boot(root, null)
  assert.ok(!ok.text_instructions.some((line) => line.includes("never use \"synced\"")))
  const unrun = await boot(root, null, { syncFn: async () => null })
  assert.ok(unrun.text_instructions.some((line) => line.includes("never use \"synced\"")), "a sync that did not run is a failed sync too")
})

test("every repo path boot prints is already expanded against the real HOME, with the card's own spelling after it, so an agent never expands ~ itself", async () => {
  const root = await desk(["flash-valves", "relay-check"])
  const home = path.join(root, "a-home-that-is-not-the-users")
  const present = path.join(home, "code", "valve-firmware")
  const absent = "~/code/not-cloned"
  await fs.mkdir(present, { recursive: true })
  const { spawnSync } = await import("node:child_process")
  spawnSync("git", ["init", "-q", present])
  const card = path.join(root, "ops", "flash-valves", "task.md")
  const text = await fs.readFile(card, "utf8")
  await fs.writeFile(card, text.replace("mode: local", `mode: local\n  - name: not-cloned\n    local_path: ${absent}\n    mode: local`))
  const result = await bootOnce({ env: { DESK: root }, cwd: root, homeDir: home, gh, jq, taskQuery: "flash-valves", syncFn: async () => ({ state: "synced" }), factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }) })
  const states = Object.fromEntries(result.repo_states.map((state) => [state.repo, state]))
  assert.equal(states["valve-firmware"].path, present)
  assert.equal(states["not-cloned"].path, path.join(home, "code", "not-cloned"))
  const printed = formatBootText(result)
  assert.ok(printed.includes(`- valve-firmware (ops/flash-valves): ${present} (~/code/valve-firmware), branch`), printed)
  assert.ok(printed.includes(`not at ${path.join(home, "code", "not-cloned")} (~/code/not-cloned)`), printed)
  assert.ok(!/not at ~\//u.test(printed), "no bare ~ path in the repo lines")
  const lines = [...result.instructions, ...result.text_instructions].filter((line) => line.includes("not-cloned") || line.includes("not at its recorded path"))
  assert.ok(lines.length > 0)
  for (const line of lines) assert.ok(!line.includes("recorded path ~/"), line)
  assert.ok(lines.some((line) => line.includes(`${path.join(home, "code", "not-cloned")} (~/code/not-cloned)`)))
  assert.ok(lines.some((line) => line.includes(`gh repo clone`) ? line.includes(path.join(home, "code", "not-cloned")) : true))
})

test("a missing repo with no clone source asks with the expanded path, and clones to it", async () => {
  const root = await desk(["flash-valves"])
  const home = path.join(root, "other-home")
  const result = await bootOnce({ env: { DESK: root }, cwd: root, homeDir: home, gh, jq, taskQuery: "flash-valves", syncFn: async () => ({ state: "synced" }), factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }) })
  const first = result.text_instructions[0]
  // The expanded path is the machine's own spelling, so it carries the native separator.
  const expanded = path.join(home, "code", "valve-firmware")
  assert.ok(first.includes(`is not at its recorded path ${expanded} (~/code/valve-firmware)`), first)
  assert.ok(first.includes(`clone valve-firmware to ${expanded} (or record the path they give)`), first)
})

test("the sync rule carries the summary's own reason for each failure, and for a pull that worked but left the desk's changes in conflict", async () => {
  const root = await desk(["flash-valves"])
  const rule = async (sync) => (await boot(root, null, { syncFn: async () => sync })).text_instructions.find((line) => line.startsWith("In every reply:"))
  assert.match(await rule({ state: "unresolved", cause: "auth_failed" }), /Desk could not sync with origin \(remote refused this host's credentials\); working from local state/u)
  assert.match(await rule({ state: "unresolved", cause: "diverged" }), /\(the desk and its remote have diverged\)/u)
  const conflict = await rule({ state: "unresolved", reason: "autostash_pop_conflict", conflicted: ["a/task.md"] })
  assert.match(conflict, /Desk pulled but could not finish syncing: open your reply with "Desk pulled from origin, but the desk's uncommitted local changes conflict with what came in \(conflicted: a\/task\.md\); nothing was pushed; resolve them before changing the desk" before anything else, and never use "synced" for it\./u)
})
