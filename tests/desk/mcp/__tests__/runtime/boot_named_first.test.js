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

test("a boot degraded by a failed sync adds the wording rule to the closing rule, text only; a synced boot does not", async () => {
  const root = await desk(["flash-valves"])
  const failed = await boot(root, null, { syncFn: async () => ({ state: "unresolved", cause: "remote_unreachable" }) })
  const rule = failed.text_instructions.find((line) => line.startsWith("In every reply:"))
  assert.match(formatBootText(failed), /Desk boot: degraded \(sync failed/u)
  assert.ok(rule.includes('Desk could not sync: report it as "Desk could not sync with origin (<reason>); working from local state" and never use "synced" for it.'), rule)
  assert.ok(!failed.instructions.some((line) => line.includes("never use \"synced\"")), "JSON instructions are unchanged")
  const ok = await boot(root, null)
  assert.ok(!ok.text_instructions.some((line) => line.includes("never use \"synced\"")))
  const unrun = await boot(root, null, { syncFn: async () => null })
  assert.ok(unrun.text_instructions.some((line) => line.includes("never use \"synced\"")), "a sync that did not run is a failed sync too")
})
