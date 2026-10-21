import { strict as assert } from "node:assert"
import { test } from "node:test"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { isDeskWorkspace } from "../../../../../plugins/desk/mcp/src/util/paths.js"
import { DESK_GITIGNORE, initDesk, main, parseArgs, runIfMain } from "../../../../../plugins/desk/mcp/scripts/desk-init.js"

const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/desk-init.js", import.meta.url))

// The isolated test HOME has no Git identity, so every commit names one through the environment.
const identity = { GIT_AUTHOR_NAME: "Test Owner", GIT_AUTHOR_EMAIL: "owner@example.test", GIT_COMMITTER_NAME: "Test Owner", GIT_COMMITTER_EMAIL: "owner@example.test" }
const gitEnv = { ...process.env, ...identity }

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: gitEnv }).trim()
const commitCount = (root) => Number(git(root, "rev-list", "--count", "HEAD"))
const listing = (root) => readdirSync(root).sort()

function captured() {
  const out = []
  return { write: (text) => out.push(text), json: () => JSON.parse(out.join("").trim()) }
}

test("init writes the template and one commit", async () => {
  const root = path.join(await mkTempRoot("desk-init-fresh-"), "desk")
  const io = captured()
  const code = await main({ argv: ["--root", root, "--owner", "Ada Lovelace"], env: gitEnv, cwd: "/", write: io.write })
  assert.equal(code, 0)
  assert.equal(isDeskWorkspace(root), true)
  assert.equal(readFileSync(path.join(root, "_meta", ".gitkeep"), "utf8"), "")
  assert.equal(readFileSync(path.join(root, "_archive", ".gitkeep"), "utf8"), "")
  assert.deepEqual(readFileSync(path.join(root, ".gitignore"), "utf8").split("\n").filter(Boolean), DESK_GITIGNORE)
  assert.match(readFileSync(path.join(root, "README.md"), "utf8"), /^# Ada Lovelace's desk\n/)
  assert.equal(commitCount(root), 1)
  assert.equal(git(root, "status", "--porcelain"), "")
  const result = io.json()
  assert.equal(result.status, "created")
  assert.equal(result.commit, git(root, "rev-parse", "HEAD"))
  assert.deepEqual(result.files, [".gitignore", "README.md", "_archive/.gitkeep", "_meta/.gitkeep"])
  // Output names only desk-relative paths, never the root.
  assert.equal(JSON.stringify(result).includes(root), false)
})

test("the gitignore keeps the anchored patterns the bootstrap skill documents", () => {
  assert.deepEqual(DESK_GITIGNORE, [
    ".state/", ".machine-local.yml", "~$*",
    "/*.txt", "/*/*.txt", "/*.png", "/*/*.png", "/*.jpg", "/*/*.jpg", "/*.log", "/*/*.log",
    "undefined/", "_cache/",
  ])
})

test("init refuses an existing desk without writing", async () => {
  const root = await mkTempRoot("desk-init-existing-")
  mkdirSync(path.join(root, "_meta"))
  mkdirSync(path.join(root, "_archive"))
  const before = listing(root)
  const io = captured()
  const code = await main({ argv: ["--root", root], env: gitEnv, cwd: "/", write: io.write })
  assert.equal(code, 2)
  assert.deepEqual(io.json(), { status: "refused", reason: "already_a_desk" })
  assert.deepEqual(listing(root), before)
  assert.equal(existsSync(path.join(root, ".git")), false)
})

test("init refuses a crew workspace and a half-made desk without writing", async () => {
  const crew = await mkTempRoot("desk-init-crew-")
  mkdirSync(path.join(crew, "_meta"))
  mkdirSync(path.join(crew, "desks"))
  assert.deepEqual(initDesk({ root: crew, env: gitEnv }), { status: "refused", reason: "already_a_desk" })
  for (const only of ["_meta", "_archive"]) {
    const root = await mkTempRoot(`desk-init-partial-${only}-`)
    mkdirSync(path.join(root, only))
    assert.deepEqual(initDesk({ root, env: gitEnv }), { status: "refused", reason: "desk_folders_present" })
    assert.deepEqual(listing(root), [only])
  }
})

test("a repo that is not a desk yet keeps its history, README and unrelated changes", async () => {
  const root = await mkTempRoot("desk-init-repo-")
  execFileSync("git", ["init", "-q", root])
  writeFileSync(path.join(root, "README.md"), "# Existing\n")
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n_cache/")
  git(root, "add", "README.md", ".gitignore")
  git(root, "commit", "-q", "-m", "existing")
  writeFileSync(path.join(root, "notes.md"), "draft\n")
  git(root, "add", "notes.md")
  const result = initDesk({ root, env: gitEnv })
  assert.equal(result.status, "created")
  assert.deepEqual(result.files, [".gitignore", "_archive/.gitkeep", "_meta/.gitkeep"])
  assert.equal(readFileSync(path.join(root, "README.md"), "utf8"), "# Existing\n")
  const ignore = readFileSync(path.join(root, ".gitignore"), "utf8")
  assert.ok(ignore.startsWith("node_modules/\n_cache/\n"), "existing entries stay first and the missing newline is added")
  assert.equal(ignore.split("\n").filter((line) => line === "_cache/").length, 1, "an entry already present is not repeated")
  for (const entry of DESK_GITIGNORE) assert.ok(ignore.split("\n").includes(entry), entry)
  assert.equal(commitCount(root), 2)
  // The staged unrelated file is not swept into the desk commit.
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [".gitignore", "_archive/.gitkeep", "_meta/.gitkeep"])
  assert.equal(git(root, "status", "--porcelain"), "A  notes.md")
})

test("a gitignore that already holds every entry is left alone", async () => {
  const root = await mkTempRoot("desk-init-ignore-complete-")
  writeFileSync(path.join(root, ".gitignore"), `${DESK_GITIGNORE.join("\n")}\n`)
  const result = initDesk({ root, env: gitEnv })
  assert.deepEqual(result.files, ["README.md", "_archive/.gitkeep", "_meta/.gitkeep"])
  assert.match(readFileSync(path.join(root, "README.md"), "utf8"), /^# Desk\n/)
})

test("root defaults to DESK, then the working directory", async () => {
  const fromEnv = await mkTempRoot("desk-init-env-")
  const io = captured()
  assert.equal(await main({ argv: [], env: { ...gitEnv, DESK: fromEnv }, cwd: "/", write: io.write }), 0)
  assert.equal(isDeskWorkspace(fromEnv), true)
  const fromCwd = await mkTempRoot("desk-init-cwd-")
  const env = { ...gitEnv }
  delete env.DESK
  assert.equal(await main({ argv: [], env, cwd: fromCwd, write: captured().write }), 0)
  assert.equal(isDeskWorkspace(fromCwd), true)
})

test("in a hosted realm Git runs from the desk without its path on the command line", async () => {
  const root = realpathSync(await mkTempRoot("desk-init-hosted-"))
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ args, cwd: options.cwd })
    return spawnSync(command, args, options)
  }
  const env = { ...gitEnv, DESK_ISOLATED_HOSTED: "1", DESK: root }
  assert.equal(initDesk({ root, env, spawn }).status, "created")
  assert.ok(calls.length > 0)
  for (const call of calls) {
    assert.equal(call.cwd, root)
    assert.equal(call.args.some((arg) => arg.includes(root)), false, call.args.join(" "))
  }
})

test("a hosted root outside the realm desk is refused before anything is written", async () => {
  const desk = await mkTempRoot("desk-init-realm-")
  const other = await mkTempRoot("desk-init-other-")
  const io = captured()
  const code = await main({ argv: ["--root", other], env: { ...gitEnv, DESK_ISOLATED_HOSTED: "1", DESK: desk }, cwd: "/", write: io.write })
  assert.equal(code, 1)
  const result = io.json()
  assert.equal(result.status, "error")
  assert.equal(result.step, "git")
  assert.equal(JSON.stringify(result).includes(other), false)
  assert.deepEqual(listing(other), [])
})

test("a commit that Git refuses reports the step without the root's path", async () => {
  const root = await mkTempRoot("desk-init-noid-")
  const env = { ...process.env, GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "", EMAIL: "" }
  // Point Git at a real path inside the root so a careless message would name it.
  const io = captured()
  const code = await main({ argv: ["--root", root], env: { ...env, GIT_CONFIG_GLOBAL: path.join(root, "missing.gitconfig") }, cwd: "/", write: io.write })
  assert.equal(code, 1)
  const result = io.json()
  assert.equal(result.status, "error")
  assert.equal(result.step, "commit")
  assert.equal(JSON.stringify(result).includes(realpathSync(root)), false)
  assert.equal(JSON.stringify(result).includes(root), false)
})

test("a root that is a file is an error", async () => {
  const dir = await mkTempRoot("desk-init-file-")
  const file = path.join(dir, "desk")
  writeFileSync(file, "")
  const result = initDesk({ root: file, env: gitEnv })
  assert.deepEqual(result, { status: "error", step: "root", message: "the desk root is not a folder" })
})

test("arguments are parsed strictly", () => {
  assert.deepEqual(parseArgs(["--root", "a", "--owner", "B"]), { root: "a", owner: "B" })
  assert.deepEqual(parseArgs(["--help"]), { help: true })
  assert.deepEqual(parseArgs([]), {})
  for (const bad of [["--root"], ["--owner"], ["--bogus"], ["stray"], ["--owner", "two\nlines"], ["--owner", "x".repeat(101)], ["--owner", " "], ["--root", ""]]) {
    assert.ok(parseArgs(bad).usage, bad.join(" "))
  }
})

test("usage errors and --help", async () => {
  const io = captured()
  assert.equal(await main({ argv: ["--bogus"], env: gitEnv, cwd: "/", write: io.write }), 64)
  assert.equal(io.json().status, "usage")
  const help = []
  assert.equal(await main({ argv: ["--help"], env: gitEnv, cwd: "/", write: (text) => help.push(text) }), 0)
  assert.match(help.join(""), /^Usage: desk-init\.js/)
})

test("the script runs as a command", async () => {
  const root = path.join(await mkTempRoot("desk-init-cli-"), "desk")
  const run = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8", env: gitEnv })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(JSON.parse(run.stdout).status, "created")
  const again = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8", env: gitEnv })
  assert.equal(again.status, 2)
  assert.equal(JSON.parse(again.stdout).reason, "already_a_desk")
})

test("the script runs through the hosted built-in loader", async () => {
  const root = realpathSync(await mkTempRoot("desk-init-builtin-"))
  const env = { ...gitEnv, DESK_ISOLATED_HOSTED: "1", DESK: root, DESK_BUILTIN_SCRIPT: pathToFileURL(script).href }
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval", 'process.argv.splice(1, 0, "desk-builtin"); await import(process.env.DESK_BUILTIN_SCRIPT)', "--"], { encoding: "utf8", env, cwd: root })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(JSON.parse(run.stdout).status, "created")
  assert.equal(isDeskWorkspace(root), true)
})

test("a failed git init or git add reports its step without the root's path", async () => {
  for (const step of ["init", "add"]) {
    const root = await mkTempRoot(`desk-init-fail-${step}-`)
    const spawn = (command, args, options) => args.includes(step)
      ? { status: 128, stdout: "", stderr: `fatal: cannot ${step} in ${root}\nsecond line\n` }
      : spawnSync(command, args, options)
    const result = initDesk({ root, env: gitEnv, spawn })
    assert.deepEqual(result, { status: "error", step, message: `fatal: cannot ${step} in .` })
  }
})

test("importing the script without a script argument does not run it", async () => {
  const cwd = await mkTempRoot("desk-init-import-")
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(script).href)})`], { encoding: "utf8", env: gitEnv, cwd })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, "")
  assert.deepEqual(listing(cwd), [])
})

test("runIfMain runs only as the entry point and sets the exit code", async () => {
  const moduleUrl = pathToFileURL(script).href
  const out = captured()
  const calls = []
  const run = async (options) => {
    calls.push(options)
    options.write("ran\n")
    return 2
  }
  try {
    assert.equal(await runIfMain({ moduleUrl, argv: [process.execPath], env: {}, cwd: "/", out, run }), false)
    assert.equal(await runIfMain({ moduleUrl, argv: [process.execPath, fileURLToPath(import.meta.url)], env: {}, cwd: "/", out, run }), false)
    assert.equal(calls.length, 0)
    assert.equal(await runIfMain({ moduleUrl, argv: [process.execPath, "desk-builtin", "--owner", "A"], env: { DESK_ISOLATED_HOSTED: "1", DESK_BUILTIN_SCRIPT: moduleUrl }, cwd: "/x", out, run }), true)
    assert.deepEqual(calls[0].argv, ["--owner", "A"])
    assert.equal(calls[0].cwd, "/x")
    assert.equal(process.exitCode, 2)
    const root = path.join(await mkTempRoot("desk-init-entry-"), "desk")
    const real = captured()
    assert.equal(await runIfMain({ moduleUrl, argv: [process.execPath, script, "--root", root], env: gitEnv, cwd: "/", out: real }), true)
    assert.equal(process.exitCode, 0)
    assert.equal(real.json().status, "created")
  } finally {
    process.exitCode = undefined
  }
})
