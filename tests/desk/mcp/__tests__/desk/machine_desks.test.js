// Every session can name the other desks on this machine and where they are, from the operator's desk registry
// (`~/ms-desk/_meta/desks.md`). This was once agent-run prose in session-start; it is now Desk's own data, in the
// boot text and in desk_status, so a session in one desk never guesses a path to, or clones, another.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { readMachineDesks, resolveMachineDesk, machineDesksLine, parseDeskRegistry } from "../../../../../plugins/desk/mcp/src/desk/machine-desks.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { otherDeskContaining, otherDeskOwning } from "../../../../../plugins/desk/mcp/src/util/desk-owner.js"
import { removeTree } from "../_remove_tree.js"

const REGISTRY = `# Desks

## Solo desks

| desk | local path | repo | account | launch |
|------|-----------|------|---------|--------|
| **work-default** | \`~/ms-desk\` | \`acme_microsoft/desk\` | EMU | \`ms-desk:worker\` |
| **personal** | \`~/personal-desk\` | \`ari/desk\` | personal | \`desk:worker\` |
| **gone** | \`~/gone-desk\` | \`ari/gone\` | personal | \`desk:worker\` |

## Crew desks

| crew | local path | repo | your alias | launch |
|------|-----------|------|-----------|--------|
| **cit** | \`~/CIT-workspace\` | \`acme/CIT\` | \`ari\` | \`ms-desk:worker\` |
`

async function machine() {
  const home = await mkTempRoot("machine-desks-")
  for (const dir of ["ms-desk/_meta", "personal-desk/_meta", "CIT-workspace/_meta"]) await fs.mkdir(path.join(home, dir), { recursive: true })
  await fs.writeFile(path.join(home, "ms-desk", "_meta", "desks.md"), REGISTRY)
  await fs.mkdir(path.join(home, ".config", "desk"), { recursive: true })
  await fs.writeFile(path.join(home, ".config", "desk", "registry-path"), "~/ms-desk/_meta/desks.md\n")
  return home
}

test("the registry names every desk with path, owner and remote, and says which are on this machine", async () => {
  const home = await machine()
  const desks = readMachineDesks({ homeDir: home, root: path.join(home, "CIT-workspace"), env: {} })
  assert.deepEqual(desks.map((desk) => desk.name), ["work-default", "personal", "gone", "cit"])
  const personal = desks.find((desk) => desk.name === "personal")
  assert.equal(personal.path, path.join(home, "personal-desk"))
  assert.equal(personal.owner, "ari")
  assert.equal(personal.remote, "ari/desk")
  assert.equal(desks.find((desk) => desk.name === "gone").present, false)
  assert.deepEqual(desks.filter((desk) => desk.current).map((desk) => desk.name), ["cit"])
})

test("a machine nobody recorded a registry for lists nothing, whatever folders exist", async () => {
  const home = await machine()
  await removeTree(path.join(home, ".config"))
  assert.deepEqual(readMachineDesks({ homeDir: home, env: {} }), [])
})

test("a crew roster is not read as a registry, and a machine with no registry has no list", async () => {
  const home = await mkTempRoot("machine-desks-none-")
  assert.deepEqual(readMachineDesks({ homeDir: home, env: {} }), [])
  assert.deepEqual(parseDeskRegistry("| alias | identity |\n|---|---|\n| ari | a@b.c |\n"), [])
})

test("a spoke desk's pointer leads to the hub's registry", async () => {
  const home = await machine()
  await removeTree(path.join(home, ".config"))
  await fs.mkdir(path.join(home, "hub", "_meta"), { recursive: true })
  await fs.writeFile(path.join(home, "hub", "_meta", "desks.md"), REGISTRY)
  await fs.writeFile(path.join(home, "personal-desk", "_meta", "desks.md"), "> **Canonical registry → `~/hub/_meta/desks.md`**\n")
  const desks = readMachineDesks({ homeDir: home, root: path.join(home, "personal-desk"), env: {} })
  assert.equal(desks.some((desk) => desk.name === "cit"), true)
})

test("a request for another desk resolves by name, repo or owner to its local path and never says to clone", async () => {
  const home = await machine()
  const desks = readMachineDesks({ homeDir: home, env: {} })
  for (const wanted of ["personal", "personal desk", "ari/desk", "personal-desk"]) assert.equal(resolveMachineDesk(wanted, desks).desk.path, path.join(home, "personal-desk"))
  assert.equal(resolveMachineDesk("acme_microsoft", desks).desk.name, "work-default")
  const absent = resolveMachineDesk("gone", desks)
  assert.match(absent.problem, /not on this machine.*register-desk.*do not clone/u)
  const unknown = resolveMachineDesk("eng-system", desks)
  assert.match(unknown.problem, /register-desk; do not clone/u)
})

test("the boot line names the other desks and their paths, not the current one or a missing one", async () => {
  const home = await machine()
  const desks = readMachineDesks({ homeDir: home, root: path.join(home, "CIT-workspace"), env: {} })
  const line = machineDesksLine(desks, { homeDir: home })
  assert.match(line, /^Other desks on this machine \(read them there, never clone\): work-default ~\/ms-desk; personal ~\/personal-desk\./u)
  assert.equal(line.includes("cit "), false)
  assert.equal(line.includes("gone"), false)
  assert.equal(machineDesksLine([], { homeDir: home }), null)
  const text = formatBootText({ status: "ready", machine_desks: desks, root: { path: path.join(home, "CIT-workspace") } })
  assert.equal(text.includes("personal ~/personal-desk") || text.includes(path.join(home, "personal-desk")), true)
  assert.equal(formatBootText({ status: "ready" }).includes("Other desks on this machine"), false)
})

test("a path inside a registered crew desk is recognised as another desk's", async () => {
  const home = await machine()
  const here = path.join(home, "personal-desk")
  const found = otherDeskContaining(here, path.join(home, "CIT-workspace", "desks", "ari", "x.md"), { homeDir: home, spawn: () => ({ status: 1 }) })
  assert.equal(found.root, path.join(home, "CIT-workspace"))
})

// The regression that started this: a Crew session booted in its own folder and never heard of the personal desk.
test("a session booted in a crew desk lists the personal desk's path in its boot text", async () => {
  const home = await machine()
  const gh = async (args) => (args[0] === "--version" ? { code: 0, stdout: "gh version 2.54.0\n", stderr: "" } : args[0] === "auth" ? { code: 0, stdout: "github.com\n  - Active account: ari\n", stderr: "" } : { code: 1, stdout: "", stderr: "" })
  const root = path.join(home, "CIT-workspace")
  const result = await bootOnce({
    env: { DESK: root, DESK_PERSON: "ari" }, cwd: root, homeDir: home, gh, jq: async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" }),
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    repoFn: () => ({ states: [], pending: [] }), lastSyncFn: () => "2026-09-30T10:00:00.000Z",
  })
  assert.equal(result.machine_desks.some((desk) => desk.path === path.join(home, "personal-desk")), true)
  assert.match(formatBootText(result), /Other desks on this machine .*personal \S*personal-desk/u)
})

test("odd registries and requests: owner-only and ambiguous matches, unknown names, bare rows, an explicit registry file, paths outside home", async () => {
  const home = await machine()
  const odd = "| desk | local path | repo |\n|---|---|---|\n| | `~/x` | a/b |\n| bare | | a/b |\n| solo-one | `~` | nobody |\n| short |\n| twin-a | `~/twin-a` | pair/a |\n| twin-b | /somewhere/twin-b | pair/b |\n"
  await fs.writeFile(path.join(home, "odd.md"), odd)
  const desks = readMachineDesks({ homeDir: home, env: { DESK_REGISTRY: path.join(home, "odd.md") } })
  assert.deepEqual(desks.slice(0, 3).map((desk) => [desk.name, desk.owner, "launch" in desk]), [["solo-one", "nobody", false], ["twin-a", "pair", false], ["twin-b", "pair", false]])
  assert.equal(resolveMachineDesk("personal", desks).desk.owner, "ari")
  assert.match(resolveMachineDesk("pair", desks).problem, /names 2 registered desks.*name one by its desk name/u)
  assert.match(resolveMachineDesk(undefined, desks).problem, /No desk named "undefined"/u)
  assert.match(resolveMachineDesk("anything", []).problem, /no desks are registered on this machine/u)
  const line = machineDesksLine([{ name: "far", path: "/somewhere/far", present: true, current: false }], { homeDir: home })
  assert.match(line, /far \/somewhere\/far\./u)
  assert.deepEqual(readMachineDesks({ homeDir: home, env: { DESK_REGISTRY: path.join(home, "missing.md") } }).filter((desk) => desk.name === "solo-one"), [])
})

test("a desk named both by its home folder and by the registry counts once, and the defaults read the real machine without failing", async () => {
  const home = await machine()
  await fs.mkdir(path.join(home, "ms-desk", "_archive"), { recursive: true })
  const found = otherDeskContaining(path.join(home, "personal-desk"), path.join(home, "ms-desk", "x.md"), { homeDir: home, spawn: () => ({ status: 1 }) })
  assert.equal(found.root, path.join(home, "ms-desk"))
  assert.equal(otherDeskContaining(path.join(home, "personal-desk"), "/nowhere/x.md", { homeDir: home, spawn: () => ({ status: 1 }) }), null)
  await fs.mkdir(path.join(home, "ms-desk", "work-track"), { recursive: true })
  assert.equal(otherDeskOwning(path.join(home, "personal-desk"), path.join("work-track", "a.md"), { homeDir: home, spawn: () => ({ status: 1 }) }).root, path.join(home, "ms-desk"))
  await fs.mkdir(path.join(home, "personal-desk", "work-track"), { recursive: true })
  assert.equal(otherDeskOwning(path.join(home, "personal-desk"), path.join("work-track", "a.md"), { homeDir: home, spawn: () => ({ status: 1 }) }), null)
  await removeTree(path.join(home, "personal-desk", "work-track"))
  assert.equal(otherDeskOwning(path.join(home, "personal-desk"), "no-such-track", { homeDir: home, spawn: () => ({ status: 1 }) }), null)
  const twice = readMachineDesks({ homeDir: home, env: { DESK_REGISTRY: path.join(home, "ms-desk", "_meta", "desks.md") } })
  assert.deepEqual(twice.map((desk) => desk.name), ["work-default", "personal", "gone", "cit"])
  assert.equal(Array.isArray(readMachineDesks()), true)
  assert.equal(parseDeskRegistry("no table here"). length, 0)
  const alone = machineDesksLine([{ name: "x", path: path.join(os.homedir(), "x"), present: true, current: false }])
  assert.match(alone, /x ~\/x\./u)
})
