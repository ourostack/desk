// An operator with a personal desk and a work desk on one machine: the session's repository owner picks the desk, a save aimed at
// the other desk fails loudly instead of reporting "nothing_to_commit", and reads name the desk they searched.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import * as os from "node:os"
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolveDeskRootWithSource } from "../../../../plugins/desk/mcp/src/util/paths.js"
import { desk_save } from "../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { deskStartupDirection } from "../../../../plugins/desk/mcp/src/util/startup-direction.js"
import { desk_search, desk_recall } from "../../../../plugins/desk/mcp/src/tools/search.js"

const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })

function mkDesk(home, folder, remote) {
  const root = path.join(home, folder)
  mkdirSync(path.join(root, "_meta"), { recursive: true })
  mkdirSync(path.join(root, "_archive"), { recursive: true })
  git(root, "init", "-q")
  git(root, "config", "user.email", "t@example.com")
  git(root, "config", "user.name", "T")
  git(root, "remote", "add", "origin", remote)
  writeFileSync(path.join(root, "README.md"), "desk\n")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "init")
  return root
}

function mkWorld() {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "desk-owner-")))
  const personal = mkDesk(home, "personal-desk", "https://arimendelow@github.com/arimendelow/desk.git")
  const work = mkDesk(home, "ms-desk", "https://arimendelow_microsoft@github.com/arimendelow_microsoft/desk.git")
  mkdirSync(path.join(personal, "ouro-ui"), { recursive: true })
  writeFileSync(path.join(personal, "ouro-ui", "notes.md"), "old\n")
  git(personal, "add", "-A")
  git(personal, "commit", "-q", "-m", "track")
  const repo = (name, remote) => {
    const dir = path.join(home, name)
    mkdirSync(dir, { recursive: true })
    git(dir, "init", "-q")
    git(dir, "remote", "add", "origin", remote)
    return dir
  }
  return { home, personal, work, ouro: repo("ouro-ui", "https://github.com/ourostack/ouro-ui.git"), cit: repo("CIT", "git@github.com:gim-home/CIT.git") }
}

function restoreHome([home, profile]) {
  for (const [key, value] of [["HOME", home], ["USERPROFILE", profile]]) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const resolve = (w, folder) => resolveDeskRootWithSource({ homeDir: w.home, env: {}, cwd: w.home, hostProjectRoot: folder, deskPluginRoot: w.home })

test("a session in a personal repository binds the personal desk, one in a Microsoft repository the work desk", () => {
  const w = mkWorld()
  assert.deepEqual([resolve(w, w.ouro).root, resolve(w, w.ouro).source], [w.personal, "repo_owner_desk"])
  assert.equal(resolve(w, w.cit).root, w.work)
})

test("a folder with no recognised repository owner does not bind a desk by owner", () => {
  const w = mkWorld()
  const plain = path.join(w.home, "plain")
  mkdirSync(plain)
  assert.throws(() => resolve(w, plain), { code: "DESK_ROOT_NOT_FOUND" })
})

test("desk_save refuses a path that belongs to another desk, naming that desk and the call to use", async () => {
  const w = mkWorld()
  for (const input of [
    { paths: ["ouro-ui/notes.md"], message: "m" },
    { paths: [path.join(w.personal, "ouro-ui", "notes.md")], message: "m" },
    { files: [{ path: "ouro-ui/new.md", content: "x\n" }], message: "m" },
  ]) {
    const home = [process.env.HOME, process.env.USERPROFILE]
    process.env.HOME = process.env.USERPROFILE = w.home
    try {
      await assert.rejects(
        desk_save({ deskRoot: w.work, input, schedulePush: () => {} }),
        (error) => error.code === "desk_save_path_belongs_to_another_desk" && error.message.includes(w.personal) && error.message.includes("--root " + w.personal) && error.message.includes("arimendelow/desk"),
      )
    } finally {
      restoreHome(home)
    }
  }
})

test("desk_save still reports nothing_to_commit for an unknown path in its own desk", async () => {
  const w = mkWorld()
  const home = [process.env.HOME, process.env.USERPROFILE]
  process.env.HOME = process.env.USERPROFILE = w.home
  try {
    const result = await desk_save({ deskRoot: w.personal, input: { paths: ["nowhere/x.md"], message: "m" }, schedulePush: () => {} })
    assert.equal(result.status, "nothing_to_commit")
  } finally {
    restoreHome(home)
  }
})

test("desk_search and desk_recall say which desk they searched", async () => {
  const w = mkWorld()
  const queryRouter = { lexical: async () => ({ results: [] }), semantic: async () => ({ results: [] }) }
  for (const result of [
    await desk_search({ deskRoot: w.personal, input: { query: "x" }, queryRouter }),
    await desk_recall({ deskRoot: w.personal, input: { topic: "x" }, queryRouter }),
  ]) assert.deepEqual(result.desk_searched, { root: w.personal, name: "arimendelow/desk" })
})

test("two personal desks, or a repository owner nobody claims, bind no desk by owner", () => {
  const w = mkWorld()
  mkdirSync(path.join(w.home, "desk", "_meta"), { recursive: true })
  mkdirSync(path.join(w.home, "desk", "_archive"), { recursive: true })
  assert.equal(resolve(w, w.ouro).source, "home_fallback")
  const stranger = path.join(w.home, "stranger")
  mkdirSync(stranger)
  git(stranger, "init", "-q")
  git(stranger, "remote", "add", "origin", "https://github.com/someone-else/repo.git")
  assert.notEqual(resolve(w, stranger).source, "repo_owner_desk")
})

test("the startup line says a desk bound by repository owner is the one matching the repository", () => {
  assert.match(deskStartupDirection({ root: "/h/personal-desk", source: "repo_owner_desk" }), /matching the session's repository owner/u)
})
