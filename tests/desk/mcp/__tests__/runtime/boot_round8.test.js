// Round 8 boot fixes: a missing clone says exactly what to run or what to ask, and a card's repo `url` is the source.
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
  const root = await mkTempRoot("desk-boot-round8-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  const dir = path.join(root, "ops", "flash-valves")
  await fs.mkdir(dir, { recursive: true })
  const card = ["schema_version: 1", "title: Flash valves", "status: processing", "created: '2026-01-01T00:00:00Z'", "updated: '2026-01-02T00:00:00Z'", "track: ops", `repos:\n${repoLines}`].join("\n")
  await fs.writeFile(path.join(dir, "task.md"), `---\n${card}\n---\n\nBody.\n`)
  return root
}

function bootNamed(root, states) {
  return bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, taskQuery: "flash-valves",
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    repoFn: () => ({ states, pending: [] }),
  })
}

const missingLine = (result) => result.instructions.find((line) => line.includes("is not at its recorded path"))
const state = (extra) => ({ track: "ops", slug: "flash-valves", repo: "valve-firmware", local_path: "~/code/valve-firmware", present: false, ...extra })

test("a missing clone whose card records a url gets the exact git clone command", async () => {
  const root = await deskWithTask("  - name: valve-firmware\n    local_path: ~/code/valve-firmware\n    mode: local\n    url: https://example.com/acme/valve-firmware.git")
  const line = missingLine(await bootNamed(root, [state({ url: "https://example.com/acme/valve-firmware.git" })]))
  assert.match(line, /clone it with `git clone -- https:\/\/example\.com\/acme\/valve-firmware\.git ~\/code\/valve-firmware`/u)
})

test("a missing clone of an owner/repo name gets gh repo clone", async () => {
  const root = await deskWithTask("  - name: acme/widgets\n    local_path: ~/code/widgets\n    mode: local")
  const line = missingLine(await bootNamed(root, [state({ repo: "acme/widgets", local_path: "~/code/widgets" })]))
  assert.match(line, /`gh repo clone acme\/widgets ~\/code\/widgets`/u)
})

test("a missing clone with no url and no owner/repo name says exactly what to ask and where to save the answer", async () => {
  const root = await deskWithTask("  - name: valve-firmware\n    local_path: ~/code/valve-firmware\n    mode: local")
  const line = missingLine(await bootNamed(root, [state({})]))
  assert.match(line, /the card records no usable clone url for it/u)
  assert.match(line, /Do not invent the repo or any progress in it/u)
  assert.match(line, /"Where is valve-firmware cloned, or what URL should I clone it from\?"/u)
  assert.match(line, /task_update/u)
  const unnamed = missingLine(await bootNamed(root, [state({ repo: null })]))
  assert.match(unnamed, /card records no usable clone url/u)
})

test("repoStates reports a card's clone url on a missing clone, without credentials embedded in it", () => {
  const spawnGit = (cmd, args) => (args.includes("fetch") ? { status: 0, stdout: "" } : { status: 128, stdout: "" })
  const card = (url) => ({ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "r", local_path: "/clones/r", mode: "local", url }] } })
  const urlOf = (url) => repoStates({ cards: [card(url)], spawnGit, now: () => 0, deadline: 60000 }).states[0].url
  assert.equal(urlOf("https://example.com/a/r.git"), "https://example.com/a/r.git")
  assert.equal(urlOf("https://user:secret@example.com/a/r.git"), "https://example.com/a/r.git")
  assert.equal(urlOf("  "), undefined)
  assert.equal(urlOf(42), undefined)
})

test("a repos url must be a string", () => {
  const base = { schema_version: 1, title: "t", status: "processing", created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z", track: "x" }
  assert.deepEqual(cardProblems({ ...base, repos: [{ name: "r", local_path: "", mode: "remote", url: "https://example.com/r.git" }] }), [])
  assert.deepEqual(cardProblems({ ...base, repos: [{ name: "r", local_path: "", mode: "remote", url: 5 }] }), ["repos[0].url is not a string"])
})

test("a clone url must be strict https, ssh or scp-style: anything else is dropped and the agent is told to ask", () => {
  const spawnGit = (cmd, args) => (args.includes("fetch") ? { status: 0, stdout: "" } : { status: 128, stdout: "" })
  const urlOf = (url) => repoStates({ cards: [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "r", local_path: "/c/r", mode: "local", url }] } }], spawnGit, now: () => 0, deadline: 60000 }).states[0].url
  for (const good of ["https://example.com/a/r.git", "ssh://git@example.com:2222/a/r.git", "ssh://example.com/a/r", "git@example.com:a/r.git", "https://example.com:8443/a/r.git"]) assert.equal(urlOf(good), good, good)
  for (const bad of ["--upload-pack=touch /tmp/x", "-oProxyCommand=x", "https://example.com/a b", "https://example.com/a;rm -rf ~", "https://example.com/$(id)", "https://example.com/`id`", "https://example.com/a|b", "http://example.com/a/r.git", "file:///etc/passwd", "git@example.com:a/r.git;x", "ext::sh -c id", "https://", ""]) assert.equal(urlOf(bad), undefined, bad)
})

test("the clone command quotes both arguments and ends option parsing", async () => {
  const root = await deskWithTask("  - name: valve-firmware\n    local_path: ~/code/my valves\n    mode: local")
  const line = missingLine(await bootNamed(root, [state({ local_path: "~/code/my valves", url: "https://example.com/a/r.git" })]))
  assert.match(line, /`git clone -- https:\/\/example\.com\/a\/r\.git ~\/'code\/my valves'`/u)
  const gh = missingLine(await bootNamed(root, [state({ repo: "acme/widgets", local_path: "/c/it's" })]))
  assert.match(gh, /`gh repo clone acme\/widgets '\/c\/it'\\''s'`/u)
})

test("shellQuote leaves plain words bare and wraps everything else as one word", () => {
  assert.equal(shellQuote("/a/b-c_d.e"), "/a/b-c_d.e")
  assert.equal(shellQuote(""), "''")
  assert.equal(shellQuote("a b"), "'a b'")
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(shellQuote("$(id)"), "'$(id)'")
  assert.equal(shellQuotePath("~/code/a b"), "~/'code/a b'")
  assert.equal(shellQuotePath("~/code/a"), "~/code/a")
  assert.equal(shellQuotePath("/x y"), "'/x y'")
})
