// A session that started on release N follows release N+1 without a restart: the hooks it registered run N+1's scripts, a skill it
// loads is followed by N+1's text, and Desk's tools swap in between calls (runtime_swap.test.js, stale_desk_refresh.test.js).
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk/hooks")
const SHA = "a".repeat(40)
const SKILL_INPUT = JSON.stringify({ toolName: "skill", toolArgs: { skill: "using-desk" } })

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

// Agency's layout: a session that loaded Desk and Crew at their versions N, and a cache holding what Agency fetched since.
async function session({ released = true } = {}) {
  const home = await mkTempRoot("desk-live-update-")
  const plugins = path.join(home, ".local", "agency", "plugins")
  const root = path.join(plugins, "sessions", "agency-plugin-abc.p1", "root-0")
  const desk = path.join(root, "desk")
  cpSync(HOOKS, path.join(desk, "hooks"), { recursive: true })
  write(path.join(desk, "plugin.json"), JSON.stringify({ name: "desk", version: "3.2.100" }))
  write(path.join(desk, "skills", "using-desk", "SKILL.md"), "---\nname: using-desk\n---\nversion N text")
  write(path.join(root, "crew", "plugin.json"), JSON.stringify({ name: "crew", version: "0.2.0" }))
  write(path.join(root, "crew", "skills", "crew-lead", "SKILL.md"), "crew N text")
  const entries = {}
  const fetched = (dir, name, version, files) => {
    write(path.join(plugins, "cache", "entries", dir, "plugin.json"), JSON.stringify({ name, version }))
    for (const [rel, text] of Object.entries(files)) write(path.join(plugins, "cache", "entries", dir, rel), text)
    entries[`copilot:github:ourostack/desk:plugins/${name}@release`] = { spec: `copilot:github:ourostack/desk:plugins/${name}@release`, dir_name: dir, fetched_at: 1, resolved_sha: SHA }
  }
  if (released) {
    fetched("desk2", "desk", "3.2.101", {
      "skills/using-desk/SKILL.md": "---\nname: using-desk\n---\nversion N+1 text",
      "docs/x.md": "docs",
      "hooks/copilot-boot-prompt.cjs": "process.stdout.write(JSON.stringify({ additionalContext: `N+1 hook ran from ${process.env.PLUGIN_ROOT}` }))\n",
    })
    fetched("crew2", "crew", "0.2.1", { "skills/crew-lead/SKILL.md": "crew N+1 text" })
  }
  write(path.join(plugins, "cache", "cache_index.json"), JSON.stringify({ entries }))
  return { home, desk, plugins }
}

const run = (s, script, input, env = {}) =>
  spawnSync(process.execPath, [path.join(s.desk, "hooks", script)], { input, encoding: "utf8", env: { PATH: process.env.PATH, PLUGIN_ROOT: s.desk, HOME: s.home, XDG_CACHE_HOME: path.join(s.home, ".cache"), ...env } })

test("a session started on N hands the agent N+1's skill text once N+1 is released, with no restart", async () => {
  const before = await session({ released: false })
  assert.equal(run(before, "copilot-skill-current.cjs", SKILL_INPUT).stdout.trim(), "{}", "nothing newer, nothing to add")

  const s = await session()
  const out = JSON.parse(run(s, "copilot-skill-current.cjs", SKILL_INPUT).stdout)
  assert.match(out.additionalContext, /desk skill "using-desk" has a newer release \(3\.2\.101\)/u)
  assert.match(out.additionalContext, /version N\+1 text/u)
  assert.ok(out.additionalContext.includes(path.join(s.plugins, "cache", "entries", "desk2")), "names where N+1's docs are")
  assert.doesNotMatch(out.additionalContext, /version N text/u)

  const other = JSON.parse(run(s, "copilot-skill-current.cjs", JSON.stringify({ toolName: "skill", toolArgs: JSON.stringify({ skill: "crew:crew-lead" }) })).stdout)
  assert.match(other.additionalContext, /crew N\+1 text/u, "another plugin's skill follows its release too")

  for (const input of [JSON.stringify({ toolName: "skill", toolArgs: { skill: "nonesuch" } }), JSON.stringify({ toolName: "bash", toolArgs: {} }), "not json"]) {
    assert.equal(run(s, "copilot-skill-current.cjs", input).stdout.trim(), "{}")
  }
  assert.equal(run(s, "copilot-skill-current.cjs", SKILL_INPUT, { DESK_HOOKS_CURRENT: "0" }).stdout.trim() === "{}", false, "the skill helper does not depend on the switch")
})

test("a hook the session registered at N runs N+1's script, and N's own when nothing newer is on disk or the switch is off", async () => {
  const s = await session()
  const ran = JSON.parse(run(s, "copilot-boot-prompt.cjs", "{}").stdout)
  assert.equal(ran.additionalContext, `N+1 hook ran from ${path.join(s.plugins, "cache", "entries", "desk2")}`)

  assert.equal(run(s, "copilot-boot-prompt.cjs", "{}", { DESK_HOOKS_CURRENT: "0" }).stdout.trim(), "{}", "off: N's own script runs")
  const before = await session({ released: false })
  assert.equal(run(before, "copilot-boot-prompt.cjs", "{}").stdout.trim(), "{}", "nothing newer: N's own script runs")
  assert.equal(run(s, "copilot-session-start.cjs", "{}", { DESK_HOOK_DELEGATED: "1" }).status, 0, "a delegated run never delegates again")
})
