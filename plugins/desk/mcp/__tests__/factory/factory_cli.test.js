// The factory.js CLI: its first subcommand, `consent`. Direct calls to the
// exported functions exercise every branch in-process; a couple of real
// subprocess invocations prove the shebang, argv/env defaults and the actual
// process exit code, against a throwaway HOME/XDG_STATE_HOME only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  SUPPORTED_COMMANDS,
  deskVersion,
  isMainModule,
  main,
  parseOptions,
  runBuildCommand,
  runConsentCommand,
  runDeriveCommand,
  runFinalizeCommand,
  runFlushCommand,
  runEvaluateAcceptCommand,
  runEvaluateCommand,
  runJobLinkCommand,
  runStatusCommand,
  runValidatePrCommand,
} from "../../scripts/factory.js"
import { jobId } from "../../src/factory/binding.js"
import { factoryStateRoot, readConsent, setConsent, updateJobsIndex, writeLocalFacts } from "../../src/factory/outbox.js"

const SCRIPT = fileURLToPath(new URL("../../scripts/factory.js", import.meta.url))
const FIXTURE_STORE = fileURLToPath(new URL("fixtures/store", import.meta.url))

async function scratch(run) {
  const rawBase = mkdtempSync(path.join(os.tmpdir(), "desk-factory-cli-"))
  const base = await fs.realpath(rawBase)
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  try {
    return await run(env)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

// validate-pr asks Git for its version, the head's own merge commits and the
// merge result's tree before it lists changes. `mergeGit` answers those three
// for a fake Git and passes every other call to `handler`.
const MERGE_TREE = "e".repeat(40)
function mergeGit(handler, { version = "git version 2.54.0\n", merges = "", tree = () => `${MERGE_TREE}\n` } = {}) {
  return (gitArgs, options) => {
    if (gitArgs[0] === "version") return version
    if (gitArgs[0] === "rev-list") return merges
    if (gitArgs[0] === "merge-tree") return tree(gitArgs)
    return handler(gitArgs, options)
  }
}

// ---------------------------------------------------------------------------
// parseOptions.
// ---------------------------------------------------------------------------

test("parseOptions reads --flag value pairs into a map", () => {
  assert.deepEqual([...parseOptions(["--store", "a/b", "--contribute", "yes"]).entries()], [["store", "a/b"], ["contribute", "yes"]])
})

test("parseOptions rejects a non-string flag, a flag with no leading --, a bare --, and a dangling flag with no value", () => {
  assert.equal(parseOptions([42, "x"]), null)
  assert.equal(parseOptions(["store", "x"]), null)
  assert.equal(parseOptions(["--", "x"]), null)
  assert.equal(parseOptions(["--store"]), null)
  assert.equal(parseOptions(["--store", "a/b", "--store", "c/d"]), null)
})

test("status returns local factory health without exposing marker paths or secrets", () => scratch(async (env) => {
  let output = ""
  assert.equal(await main({ argv: ["status"], env, write: (text) => { output += text }, logError: () => assert.fail("status must succeed") }), 0)
  const result = JSON.parse(output)
  assert.equal(result.markers, 0)
  assert.equal(result.finalize, 0)
  assert.equal(output.includes(env.HOME), false)
}))

test("derive refuses an arbitrary marker path without echoing it", () => scratch(async (env) => {
  let output = ""
  assert.equal(await main({ argv: ["derive", "--marker", "/private/sentinel.json"], env, write: (text) => { output += text }, logError: () => assert.fail("invalid marker is a structured outcome") }), 0)
  assert.deepEqual(JSON.parse(output), { result: "invalid", store: null })
}))

test("derive and status reject malformed options and out-of-budget quiet waits", () => scratch(async (env) => {
  for (const argv of [[], ["--marker"], ["--other", "x"], ["--marker", "x", "--other", "y"]]) {
    await assert.rejects(runDeriveCommand({ argv, env }), /Usage:/u)
  }
  for (const wait of ["-1", "NaN", "30001", "9999999"]) {
    await assert.rejects(runDeriveCommand({ argv: ["--marker", "x", "--wait-quiet", wait], env }), /wait-quiet must/u)
  }
  assert.deepEqual(await runDeriveCommand({ argv: ["--marker", "x", "--wait-quiet", "0"], env }), { result: "invalid", store: null })
  await assert.rejects(runStatusCommand({ argv: ["extra"], env }), /Usage:/u)
}))

test("build writes the deterministic report tree and job-link returns the accepted URL", () => scratch(async (env) => {
  const store = path.join(env.HOME, "store")
  const out = path.join(store, "_out")
  cpSync(FIXTURE_STORE, store, { recursive: true })
  assert.deepEqual(await runBuildCommand({ argv: ["--store", store, "--out", out] }), { jobs: 2, sessions: 4 })
  assert.equal(JSON.parse(readFileSync(path.join(out, "jobs", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"), "utf8")).job, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  assert.deepEqual(await runJobLinkCommand({ argv: ["--store", "ourostack/factory", "--desk-remote", "git@github.com:OuroStack/Desk.git", "--person-prefix", "", "--track", "factory", "--slug", "store-pipeline"] }), {
    link: "https://github.com/ourostack/factory/blob/reports/jobs/3e7101c7c7d8774223be31b99495dd7f.md",
  })
  assert.deepEqual(await runJobLinkCommand({ argv: ["--store", "ourostack/factory", "--desk-remote", "git@github.com:OuroStack/Desk.git", "--track", "factory", "--slug", "store-pipeline"] }), {
    link: "https://github.com/ourostack/factory/blob/reports/jobs/3e7101c7c7d8774223be31b99495dd7f.md",
  })
  await assert.rejects(runBuildCommand({ argv: ["--store", store] }), /Usage: factory\.js build/u)
  await assert.rejects(runJobLinkCommand({ argv: ["--store", "ourostack/factory"] }), /Usage: factory\.js job-link/u)
}))

test("validate-pr reads base and head as Git data, enforces facts for contributors, and marks maintainer changes", () => scratch(async (env) => {
  const repo = path.join(env.HOME, "store")
  const facts = path.join(repo, "facts")
  await fs.mkdir(facts, { recursive: true })
  const fixtureName = "claude-code-11111111-1111-4111-8111-111111111111.json"
  const fixture = readFileSync(path.join(FIXTURE_STORE, "facts", fixtureName), "utf8")
  await fs.writeFile(path.join(facts, fixtureName), fixture)
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo })
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo })
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo })
  execFileSync("git", ["add", "facts"], { cwd: repo })
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo })
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()

  const updated = JSON.parse(fixture)
  updated.session.duration_ms += 1
  await fs.writeFile(path.join(facts, fixtureName), `${JSON.stringify(updated)}\n`)
  execFileSync("git", ["add", "facts"], { cwd: repo })
  execFileSync("git", ["commit", "-q", "-m", "facts"], { cwd: repo })
  const factsHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", base, "--head", factsHead, "--author-association", "CONTRIBUTOR"], cwd: repo }), {
    ok: true,
    maintenance: false,
    errors: [],
  })

  const marker = path.join(env.HOME, "executed")
  await fs.writeFile(path.join(repo, "candidate.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`)
  execFileSync("git", ["add", "candidate.js"], { cwd: repo })
  execFileSync("git", ["commit", "-q", "-m", "candidate"], { cwd: repo })
  const maintenanceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", factsHead, "--head", maintenanceHead, "--author-association", "OWNER"], cwd: repo }), {
    ok: true,
    maintenance: true,
    errors: [],
  })
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", factsHead, "--head", maintenanceHead, "--author-association", "NONE"], cwd: repo }), {
    ok: false,
    maintenance: false,
    errors: [{ code: "path", path: "changes.0" }],
  })
  assert.equal(existsSync(marker), false)
}))

test("validate-pr marks non-fact files under facts/ and maintainer removals as maintenance, and refuses a head whose merge conflicts", () => scratch(async (env) => {
  const repo = path.join(env.HOME, "store")
  const facts = path.join(repo, "facts")
  await fs.mkdir(facts, { recursive: true })
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
  const names = ["claude-code-11111111-1111-4111-8111-111111111111.json", "copilot-cli-22222222-2222-4222-8222-222222222222.json"]
  for (const name of names) await fs.writeFile(path.join(facts, name), readFileSync(path.join(FIXTURE_STORE, "facts", name), "utf8"))
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  git("add", "facts")
  git("commit", "-q", "-m", "base")
  const forkPoint = git("rev-parse", "HEAD")

  // A pull request updates the first facts file...
  git("checkout", "-q", "-b", "update")
  const updated = JSON.parse(readFileSync(path.join(facts, names[0]), "utf8"))
  updated.session.duration_ms += 1
  await fs.writeFile(path.join(facts, names[0]), `${JSON.stringify(updated)}\n`)
  git("commit", "-q", "-am", "update")
  const updateHead = git("rev-parse", "HEAD")
  // ...while main has since removed it: the merge cannot land, so it is refused.
  git("checkout", "-q", "main")
  git("rm", "-q", path.join("facts", names[0]))
  git("commit", "-q", "-m", "remove on main")
  const movedBase = git("rev-parse", "HEAD")
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", movedBase, "--head", updateHead, "--author-association", "NONE"], cwd: repo }), {
    ok: false,
    maintenance: false,
    errors: [{ code: "merge_conflict", path: "head" }],
  })

  git("checkout", "-q", "-b", "notes", forkPoint)
  await fs.writeFile(path.join(facts, "notes.txt"), "maintainer notes")
  git("add", "facts")
  git("commit", "-q", "-m", "notes")
  const notesHead = git("rev-parse", "HEAD")
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.deepEqual(await runValidatePrCommand({ argv: ["--base", forkPoint, "--head", notesHead, "--author-association", association], cwd: repo }), {
      ok: true,
      maintenance: true,
      errors: [],
    })
  }
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", forkPoint, "--head", notesHead, "--author-association", "CONTRIBUTOR"], cwd: repo }), {
    ok: false,
    maintenance: false,
    errors: [{ code: "path", path: "changes.0" }],
  })

  git("checkout", "-q", "-b", "cleanup", forkPoint)
  git("rm", "-q", path.join("facts", names[1]))
  git("commit", "-q", "-m", "cleanup")
  const cleanupHead = git("rev-parse", "HEAD")
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", forkPoint, "--head", cleanupHead, "--author-association", "OWNER"], cwd: repo }), {
    ok: true,
    maintenance: true,
    errors: [],
  })
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", forkPoint, "--head", cleanupHead, "--author-association", "NONE"], cwd: repo }), {
    ok: false,
    maintenance: false,
    errors: [{ code: "removal", path: `facts/${names[1]}` }],
  })
}))

const LABEL_1111 = "labels/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/11111111-1111-4111-8111-111111111111.json"
const LABEL_2222 = "labels/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/22222222-2222-4222-8222-222222222222.json"

function label2222() {
  const value = JSON.parse(readFileSync(path.join(FIXTURE_STORE, LABEL_1111), "utf8"))
  value.job = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  value.session = "22222222-2222-4222-8222-222222222222"
  value.stretches = [{ start_ms: 0, end_ms: 10000, class: "muda", waste: "waiting", mura: false, muri: false, evidence: [[2500, 3500], [4000, 4500]] }]
  return `${JSON.stringify(value)}\n`
}

test("validate-pr gates labels as data against the facts the merge would leave in the store", () => scratch(async (env) => {
  const repo = path.join(env.HOME, "store")
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
  const write = async (relative, text) => {
    await fs.mkdir(path.dirname(path.join(repo, relative)), { recursive: true })
    await fs.writeFile(path.join(repo, relative), text)
  }
  const facts1111 = "facts/claude-code-11111111-1111-4111-8111-111111111111.json"
  const facts2222 = "facts/copilot-cli-22222222-2222-4222-8222-222222222222.json"
  await write(facts1111, readFileSync(path.join(FIXTURE_STORE, facts1111), "utf8"))
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  git("add", "facts")
  git("commit", "-q", "-m", "base")
  const forkPoint = git("rev-parse", "HEAD")
  const validate = (base, head, association = "CONTRIBUTOR") => runValidatePrCommand({ argv: ["--base", base, "--head", head, "--author-association", association], cwd: repo })

  // A contributor's labels file for a session whose facts are already on main.
  git("checkout", "-q", "-b", "label-1111")
  await write(LABEL_1111, readFileSync(path.join(FIXTURE_STORE, LABEL_1111), "utf8"))
  git("add", "labels")
  git("commit", "-q", "-m", "label")
  const label1111Head = git("rev-parse", "HEAD")
  assert.deepEqual(await validate(forkPoint, label1111Head), { ok: true, maintenance: false, errors: [] })

  // Labels whose facts arrive in the same pull request.
  git("checkout", "-q", "-b", "with-facts", forkPoint)
  await write(facts2222, readFileSync(path.join(FIXTURE_STORE, facts2222), "utf8"))
  await write(LABEL_2222, label2222())
  git("add", "facts", "labels")
  git("commit", "-q", "-m", "facts and label")
  assert.deepEqual(await validate(forkPoint, git("rev-parse", "HEAD")), { ok: true, maintenance: false, errors: [] })

  // Labels whose facts are nowhere yet are refused...
  git("checkout", "-q", "-b", "label-only", forkPoint)
  await write(LABEL_2222, label2222())
  git("add", "labels")
  git("commit", "-q", "-m", "label only")
  const labelOnlyHead = git("rev-parse", "HEAD")
  assert.deepEqual(await validate(forkPoint, labelOnlyHead), { ok: false, maintenance: false, errors: [{ code: "facts_missing", path: LABEL_2222 }] })
  // ...and pass once main has the facts, even though the branch predates them.
  git("checkout", "-q", "main")
  await write(facts2222, readFileSync(path.join(FIXTURE_STORE, facts2222), "utf8"))
  git("add", "facts")
  git("commit", "-q", "-m", "facts on main")
  const movedBase = git("rev-parse", "HEAD")
  assert.deepEqual(await validate(movedBase, labelOnlyHead), { ok: true, maintenance: false, errors: [] })

  // A maintainer who removes the facts in the same pull request leaves the labels without them.
  git("checkout", "-q", "-b", "remove-facts", movedBase)
  git("rm", "-q", facts2222)
  await write(LABEL_2222, label2222())
  git("add", "labels")
  git("commit", "-q", "-m", "remove facts, add label")
  assert.deepEqual(await validate(movedBase, git("rev-parse", "HEAD"), "OWNER"), { ok: false, maintenance: false, errors: [{ code: "facts_missing", path: LABEL_2222 }] })

  // A replacement reads the previous labels at the base: a newer rubric passes, an older evaluator does not.
  const replace = async (branch, mutate) => {
    git("checkout", "-q", "-b", branch, label1111Head)
    const value = JSON.parse(readFileSync(path.join(FIXTURE_STORE, LABEL_1111), "utf8"))
    mutate(value)
    await write(LABEL_1111, `${JSON.stringify(value)}\n`)
    git("commit", "-q", "-am", branch)
    return git("rev-parse", "HEAD")
  }
  assert.deepEqual(await validate(label1111Head, await replace("relabel", (value) => { value.evaluator.rubric = "2" })), { ok: true, maintenance: false, errors: [] })
  assert.deepEqual(await validate(label1111Head, await replace("downgrade", (value) => { value.evaluator.plugin_version = "3.2.0-alpha.1" })), {
    ok: false,
    maintenance: false,
    errors: [{ code: "evaluator_downgrade", path: LABEL_1111 }],
  })

  // Removing labels is maintenance for a maintainer and refused for anyone else.
  git("checkout", "-q", "-b", "drop-label", label1111Head)
  git("rm", "-q", LABEL_1111)
  git("commit", "-q", "-m", "drop label")
  const dropHead = git("rev-parse", "HEAD")
  assert.deepEqual(await validate(label1111Head, dropHead, "MEMBER"), { ok: true, maintenance: true, errors: [] })
  assert.deepEqual(await validate(label1111Head, dropHead, "NONE"), { ok: false, maintenance: false, errors: [{ code: "removal", path: LABEL_1111 }] })

  // A labels file that is not valid JSON data is refused without being echoed or run.
  git("checkout", "-q", "-b", "bad-label", forkPoint)
  const marker = path.join(env.HOME, "executed")
  await write(LABEL_1111, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ghp_SENTINEL")`)
  git("add", "labels")
  git("commit", "-q", "-m", "bad label")
  const bad = await validate(forkPoint, git("rev-parse", "HEAD"))
  assert.deepEqual(bad, { ok: false, maintenance: false, errors: [{ code: "json", path: LABEL_1111 }] })
  assert.equal(JSON.stringify(bad).includes("ghp_"), false)
  assert.equal(existsSync(marker), false)
}))

test("validate-pr reads a labeled session's facts in the merge result when the pull request changes them and at base otherwise", async () => {
  const shaA = "a".repeat(40)
  const shaB = "b".repeat(40)
  const shaC = "c".repeat(40)
  const facts1111 = "facts/claude-code-11111111-1111-4111-8111-111111111111.json"
  const facts2222 = "facts/copilot-cli-22222222-2222-4222-8222-222222222222.json"
  const bytes = {
    [facts1111]: readFileSync(path.join(FIXTURE_STORE, facts1111)),
    [facts2222]: readFileSync(path.join(FIXTURE_STORE, facts2222)),
    [LABEL_1111]: readFileSync(path.join(FIXTURE_STORE, LABEL_1111)),
    [LABEL_2222]: Buffer.from(label2222()),
  }
  const calls = []
  const result = await runValidatePrCommand({
    argv: ["--base", shaA, "--head", shaB, "--author-association", "NONE"],
    git: mergeGit((gitArgs) => {
      calls.push(gitArgs.join(" "))
      if (gitArgs[0] === "diff") return `A\0${LABEL_1111}\0M\0${facts2222}\0A\0${LABEL_2222}\0`
      if (gitArgs[0] === "ls-tree") {
        // Git lists only what exists; a stray name it could never return is ignored.
        return gitArgs.includes(facts1111) ? `${facts1111}\0facts/other.json\0` : `${facts2222}\0`
      }
      return bytes[gitArgs[1].slice(41)]
    }),
  })
  assert.deepEqual(result, { ok: true, maintenance: false, errors: [] })
  assert.deepEqual(calls, [
    `diff --name-status -z --no-renames ${shaA} ${MERGE_TREE}`,
    `show ${MERGE_TREE}:${LABEL_1111}`,
    `ls-tree -z --name-only ${shaA} -- ${facts1111} facts/copilot-cli-11111111-1111-4111-8111-111111111111.json`,
    `show ${shaA}:${facts1111}`,
    `show ${MERGE_TREE}:${facts2222}`,
    `show ${shaA}:${facts2222}`,
    `show ${MERGE_TREE}:${LABEL_2222}`,
    `ls-tree -z --name-only ${shaA} -- facts/claude-code-22222222-2222-4222-8222-222222222222.json`,
    `show ${MERGE_TREE}:${facts2222}`,
  ])
})

test("validate-pr asks Git nothing about base facts when the pull request touches every facts path of a labeled session", async () => {
  const facts1111 = "facts/claude-code-11111111-1111-4111-8111-111111111111.json"
  const copilot1111 = "facts/copilot-cli-11111111-1111-4111-8111-111111111111.json"
  const bytes = { [facts1111]: readFileSync(path.join(FIXTURE_STORE, facts1111)), [LABEL_1111]: readFileSync(path.join(FIXTURE_STORE, LABEL_1111)) }
  const calls = []
  const result = await runValidatePrCommand({
    argv: ["--base", "a".repeat(40), "--head", "b".repeat(40), "--author-association", "NONE"],
    git: mergeGit((gitArgs) => {
      calls.push(gitArgs[0])
      if (gitArgs[0] === "diff") return `A\0${facts1111}\0D\0${copilot1111}\0A\0${LABEL_1111}\0`
      return bytes[gitArgs[1].slice(41)]
    }),
  })
  assert.deepEqual(result, { ok: false, maintenance: false, errors: [{ code: "removal", path: copilot1111 }] })
  assert.deepEqual(calls, ["diff", "show", "show", "show"])
})

test("validate-pr reads the landed bytes from the merge result and the previous bytes at the base", async () => {
  const shaA = "a".repeat(40)
  const shaB = "b".repeat(40)
  const names = ["claude-code-11111111-1111-4111-8111-111111111111.json", "copilot-cli-22222222-2222-4222-8222-222222222222.json"]
  const bytes = Object.fromEntries(names.map((name) => [`facts/${name}`, readFileSync(path.join(FIXTURE_STORE, "facts", name))]))
  const args = ["--base", shaA, "--head", shaB, "--author-association", "NONE"]
  const revisions = []
  const calls = []
  const result = await runValidatePrCommand({
    argv: args,
    git: mergeGit((gitArgs) => {
      if (gitArgs[0] === "diff") {
        assert.deepEqual(gitArgs, ["diff", "--name-status", "-z", "--no-renames", shaA, MERGE_TREE])
        return names.map((name) => `M\0facts/${name}\0`).join("")
      }
      const [revision, filePath] = gitArgs[1].split(":")
      revisions.push(revision)
      return bytes[filePath]
    }, {
      merges: "",
      tree: (gitArgs) => {
        calls.push(gitArgs)
        return `${MERGE_TREE}\n`
      },
    }),
  })
  assert.deepEqual(result, { ok: true, maintenance: false, errors: [] })
  assert.deepEqual(calls, [["merge-tree", "--write-tree", "--no-messages", shaA, shaB]])
  assert.deepEqual(revisions, [MERGE_TREE, shaA, MERGE_TREE, shaA])

  await assert.rejects(
    runValidatePrCommand({ argv: args, git: mergeGit(() => "", { tree: () => "not a tree\n" }) }),
    /Git data could not be read/u,
  )
})

test("validate-pr refuses head merge commits, merge conflicts, a missing merge-tree and Git older than 2.38", async () => {
  const args = ["--base", "a".repeat(40), "--head", "b".repeat(40), "--author-association", "OWNER"]
  const untouched = () => assert.fail("no change list is read")
  assert.deepEqual(await runValidatePrCommand({ argv: args, git: mergeGit(untouched, { merges: `${"c".repeat(40)}\n` }) }), {
    ok: false,
    maintenance: false,
    errors: [{ code: "unexpected_merge", path: "head" }],
  })
  const failing = (status) => () => {
    const error = new Error("git failed")
    error.status = status
    throw error
  }
  assert.deepEqual(await runValidatePrCommand({ argv: args, git: mergeGit(untouched, { tree: failing(1) }) }), {
    ok: false,
    maintenance: false,
    errors: [{ code: "merge_conflict", path: "head" }],
  })
  for (const status of [129, null]) {
    await assert.rejects(runValidatePrCommand({ argv: args, git: mergeGit(untouched, { tree: failing(status) }) }), /merge_tree_unavailable/u)
  }
  for (const version of ["git version 2.37.9\n", "git version 1.99.0\n", "not git\n"]) {
    await assert.rejects(runValidatePrCommand({ argv: args, git: mergeGit(untouched, { version }) }), /git_too_old/u)
  }
  assert.deepEqual(await runValidatePrCommand({ argv: args, git: mergeGit(() => "", { version: "git version 3.0.0\n" }) }), {
    ok: true,
    maintenance: false,
    errors: [],
  })
  // A Git that cannot even start reports the generic error.
  await assert.rejects(runValidatePrCommand({ argv: args, cwd: path.join(os.tmpdir(), "desk-factory-missing-cwd-8b1d") }), /Git data could not be read/u)
})

test("validate-pr handles added, removed, unknown, invalid-path, malformed, oversized, and Git-error inputs without loading unsafe paths", async () => {
  const shaA = "a".repeat(40)
  const shaB = "b".repeat(40)
  const validPath = "facts/claude-code-11111111-1111-4111-8111-111111111111.json"
  const validBytes = readFileSync(path.join(FIXTURE_STORE, validPath), "utf8")
  const args = ["--base", shaA, "--head", shaB, "--author-association", "NONE"]

  let calls = 0
  let result = await runValidatePrCommand({
    argv: args,
    git: mergeGit((gitArgs, options) => {
      calls += 1
      if (gitArgs[0] === "diff") return `A\0${validPath}\0`
      assert.equal(options.encoding, null)
      return Buffer.from(validBytes)
    }),
  })
  assert.deepEqual(result, { ok: true, maintenance: false, errors: [] })
  assert.equal(calls, 2)

  for (const [status, code] of [["D", "removal"], ["X", "status"]]) {
    result = await runValidatePrCommand({ argv: args, git: mergeGit(() => `${status}\0${validPath}\0`) })
    assert.deepEqual(result, { ok: false, maintenance: false, errors: [{ code, path: validPath }] })
  }

  calls = 0
  result = await runValidatePrCommand({
    argv: args,
    git: mergeGit((gitArgs) => {
      calls += 1
      assert.equal(gitArgs[0], "diff")
      return "A\0facts/nested/SENTINEL.js\0"
    }),
  })
  assert.deepEqual(result, { ok: false, maintenance: false, errors: [{ code: "path", path: "changes.0" }] })
  assert.equal(calls, 1)

  await assert.rejects(
    runValidatePrCommand({ argv: args, git: mergeGit(() => "A\0") }),
    /change list is malformed/u,
  )
  const many = Array.from({ length: 501 }, (_, index) => `A\0outside-${index}\0`).join("")
  assert.deepEqual(await runValidatePrCommand({ argv: args, git: mergeGit(() => many) }), {
    ok: false,
    maintenance: false,
    errors: [{ code: "too_many_changes", path: "changes" }],
  })
  await assert.rejects(
    runValidatePrCommand({ argv: [...args, "--extra", "x"], git: () => "" }),
    /unknown option/u,
  )
  await assert.rejects(
    runValidatePrCommand({ argv: args, cwd: os.tmpdir() }),
    /Git data could not be read/u,
  )
})

test("validate-pr rejects malformed options and main exits one while still printing stable validation JSON", () => scratch(async (env) => {
  for (const argv of [
    ["--base", "x"],
    ["--base", "x".repeat(40), "--head", "y", "--author-association", "NONE"],
    ["--base", "a".repeat(40), "--head", "b".repeat(40), "--author-association", "bad"],
  ]) {
    await assert.rejects(runValidatePrCommand({ argv }), /Usage: factory\.js validate-pr/u)
  }
  let output = ""
  let logged = ""
  const code = await main({
    argv: ["validate-pr", "--base", "x", "--head", "y", "--author-association", "NONE"],
    env,
    write: (text) => { output += text },
    logError: (text) => { logged += text },
  })
  assert.equal(code, 1)
  assert.equal(output, "")
  assert.match(logged, /base and head/u)

  output = ""
  logged = ""
  const validPath = "facts/claude-code-11111111-1111-4111-8111-111111111111.json"
  const invalidCode = await main({
    argv: ["validate-pr", "--base", "a".repeat(40), "--head", "b".repeat(40), "--author-association", "NONE"],
    env,
    git: mergeGit(() => `D\0${validPath}\0`),
    write: (text) => { output += text },
    logError: (text) => { logged += text },
  })
  assert.equal(invalidCode, 1)
  assert.deepEqual(JSON.parse(output), { ok: false, maintenance: false, errors: [{ code: "removal", path: validPath }] })
  assert.equal(logged, "")
}))

// ---------------------------------------------------------------------------
// runConsentCommand.
// ---------------------------------------------------------------------------

test("runConsentCommand sets consent and returns the store's record", () => scratch(async (env) => {
  const result = await runConsentCommand({ argv: ["--store", "ourostack/factory", "--contribute", "yes"], env })
  assert.equal(result.store, "ourostack/factory")
  assert.equal(result.contribute, true)
  assert.match(result.intake_id, /^[0-9a-f]{16}$/u)
  assert.deepEqual((await readConsent(env)).stores["ourostack/factory"].intake_id, result.intake_id)
}))

test("runConsentCommand accepts an optional --account", () => scratch(async (env) => {
  const result = await runConsentCommand({ argv: ["--store", "ourostack/factory", "--contribute", "yes", "--account", "arimendelow"], env })
  assert.equal(result.account, "arimendelow")
}))

test("runConsentCommand rejects malformed argv, a missing --store, and a --contribute that isn't yes/no", () => scratch(async (env) => {
  await assert.rejects(() => runConsentCommand({ argv: ["--store"], env }), /Usage: factory\.js consent/u)
  await assert.rejects(() => runConsentCommand({ argv: ["--contribute", "yes"], env }), /Usage: factory\.js consent/u)
  await assert.rejects(() => runConsentCommand({ argv: ["--store", "a/b", "--contribute", "maybe"], env }), /Usage: factory\.js consent/u)
}))

test("runConsentCommand rejects an unknown option", () => scratch(async (env) => {
  await assert.rejects(
    () => runConsentCommand({ argv: ["--store", "a/b", "--contribute", "yes", "--extra", "x"], env }),
    /unknown option --extra/u,
  )
}))

// ---------------------------------------------------------------------------
// main: dispatch, exit codes, and the consent round trip.
// ---------------------------------------------------------------------------

test("main dispatches consent, prints one JSON line, and returns exit code 0", () => scratch(async (env) => {
  let written = ""
  const code = await main({ argv: ["consent", "--store", "ourostack/factory", "--contribute", "yes"], env, write: (text) => { written += text }, logError: () => assert.fail("should not log an error") })
  assert.equal(code, 0)
  const parsed = JSON.parse(written)
  assert.equal(parsed.store, "ourostack/factory")
  assert.equal(parsed.contribute, true)
}))

test("main returns exit code 1 and logs one line for an unknown subcommand", () => scratch(async (env) => {
  let logged = ""
  const code = await main({ argv: ["bogus"], env, write: () => assert.fail("should not write"), logError: (text) => { logged += text } })
  assert.equal(code, 1)
  assert.match(logged, /unknown subcommand "bogus"/u)
}))

test("main returns exit code 1 and logs the usage message for a malformed consent call", () => scratch(async (env) => {
  let logged = ""
  const code = await main({ argv: ["consent"], env, write: () => assert.fail("should not write"), logError: (text) => { logged += text } })
  assert.equal(code, 1)
  assert.match(logged, /Usage: factory\.js consent/u)
}))

test("main reports an unknown subcommand as an empty string when argv is empty", () => scratch(async (env) => {
  let logged = ""
  const code = await main({ argv: [], env, write: () => assert.fail("should not write"), logError: (text) => { logged += text } })
  assert.equal(code, 1)
  assert.match(logged, /unknown subcommand ""/u)
}))

// ---------------------------------------------------------------------------
// isMainModule.
// ---------------------------------------------------------------------------

test("isMainModule is true only when argv[1]'s file URL matches import.meta.url", () => {
  assert.equal(isMainModule("file:///a/b.js", "/a/b.js"), true)
  assert.equal(isMainModule("file:///a/b.js", "/a/other.js"), false)
  assert.equal(isMainModule("file:///a/b.js", undefined), false)
})

// ---------------------------------------------------------------------------
// The real CLI: a subprocess round trip against a throwaway state root.
// ---------------------------------------------------------------------------

function runCli(args, env) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env })
}

test("the CLI consent round trip: yes mints an intake_id, a later no keeps it, both visible in the written consent.json", () => scratch(async (env) => {
  const fullEnv = { ...process.env, ...env }
  const yesOut = JSON.parse(runCli(["consent", "--store", "ourostack/factory", "--contribute", "yes"], fullEnv))
  assert.equal(yesOut.contribute, true)
  assert.match(yesOut.intake_id, /^[0-9a-f]{16}$/u)

  const noOut = JSON.parse(runCli(["consent", "--store", "ourostack/factory", "--contribute", "no", "--account", "arimendelow"], fullEnv))
  assert.equal(noOut.contribute, false)
  assert.equal(noOut.intake_id, yesOut.intake_id)
  assert.equal(noOut.account, "arimendelow")

  assert.equal((await readConsent(env)).stores["ourostack/factory"].intake_id, yesOut.intake_id)
}))

test("the real CLI exits non-zero and prints one line to stderr for a bad invocation", () => scratch(async (env) => {
  const fullEnv = { ...process.env, ...env }
  try {
    execFileSync(process.execPath, [SCRIPT, "consent"], { encoding: "utf8", env: fullEnv, stdio: ["ignore", "pipe", "pipe"] })
    assert.fail("expected a non-zero exit")
  } catch (error) {
    assert.equal(error.status, 1)
    assert.match(error.stderr.toString(), /Usage: factory\.js consent/u)
  }
}))

// ---------------------------------------------------------------------------
// flush and finalize.
// ---------------------------------------------------------------------------

test("flush and finalize are advertised, so the end-of-turn hook starts finalize", () => {
  assert.ok(SUPPORTED_COMMANDS.includes("flush"))
  assert.ok(SUPPORTED_COMMANDS.includes("finalize"))
})

test("flush --store runs one delivery attempt through the injected runner and prints its stable code", () => scratch(async (env) => {
  let output = ""
  const runner = () => assert.fail("no consent, no gh")
  assert.equal(await main({ argv: ["flush", "--store", "ourostack/factory"], env, runner, write: (text) => { output += text }, logError: () => assert.fail("flush must succeed") }), 0)
  assert.deepEqual(JSON.parse(output), { result: "not_opted_in" })
  assert.deepEqual(await runFlushCommand({ argv: ["--store", "ourostack/factory"], env }), { result: "not_opted_in" })
  for (const argv of [[], ["--store"], ["--store", "a/b", "--other", "x"], ["--other", "x"]]) {
    await assert.rejects(runFlushCommand({ argv, env, runner }), /Usage: factory\.js flush/u)
  }
}))

test("finalize takes one to eight distinct jobs and reports each job's outcome", () => scratch(async (env) => {
  const a = "a".repeat(32)
  const b = "b".repeat(32)
  let output = ""
  assert.equal(await main({ argv: ["finalize", "--job", a, "--job", b], env, runner: () => assert.fail("no state"), write: (text) => { output += text }, logError: () => assert.fail("finalize must succeed") }), 0)
  assert.deepEqual(JSON.parse(output), { jobs: { [a]: { result: "retained", reason: "no_state" }, [b]: { result: "retained", reason: "no_state" } } })
  assert.deepEqual(await runFinalizeCommand({ argv: ["--job", a], env }), { jobs: { [a]: { result: "retained", reason: "no_state" } } })
  const nine = Array.from({ length: 9 }, (_, index) => ["--job", index.toString(16).repeat(32)]).flat()
  for (const argv of [[], ["--job"], ["--job", "xyz"], ["--job", a, "--job", a], ["--other", a], nine]) {
    await assert.rejects(runFinalizeCommand({ argv, env }), /Usage: factory\.js finalize/u)
  }
}))

// ---------------------------------------------------------------------------
// evaluate and evaluate-accept.
// ---------------------------------------------------------------------------

const LOCAL_GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("fixtures/local-golden.json", import.meta.url)), "utf8"))
const LABELS_GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("fixtures/labels-golden.json", import.meta.url)), "utf8"))
const EVAL_SESSION = LOCAL_GOLDEN.session.id

// Local facts of the golden session bound to `job`, in a consented store's outbox.
async function seedJob(env, job) {
  const facts = structuredClone(LOCAL_GOLDEN)
  facts.jobs[2].job = job
  facts.jobs.sort((a, b) => (a.job < b.job ? -1 : 1))
  await setConsent(env, { store: "ourostack/factory", contribute: true })
  await writeLocalFacts(env, "ourostack/factory", facts)
  await updateJobsIndex(env, job, `claude-code-${EVAL_SESSION}.json`)
}

test("deskVersion is the installed plugin's version", () => {
  assert.equal(deskVersion(), JSON.parse(readFileSync(fileURLToPath(new URL("../../../plugin.json", import.meta.url)), "utf8")).version)
})

test("evaluate computes the task's job as the task tools do and prepares its briefs", () => scratch(async (env) => {
  const desk = path.join(env.HOME, "desk")
  await fs.mkdir(desk)
  const job = jobId({ deskRemote: `local:${desk}`, personPrefix: "", track: "factory", slug: "evaluator" })
  assert.deepEqual(await runEvaluateCommand({ argv: ["--pending"], env, pluginVersion: "3.2.0-alpha.40" }), { jobs: [] })
  assert.deepEqual(await runEvaluateCommand({ argv: ["--desk", desk, "--task", "factory/evaluator"], env, pluginVersion: "3.2.0-alpha.40" }), { result: "not_opted_in", job, briefs: [] })
  await seedJob(env, job)
  let output = ""
  assert.equal(await main({ argv: ["evaluate", "--desk", desk, "--task", "factory/evaluator"], env, write: (text) => { output += text }, logError: () => assert.fail("evaluate must succeed") }), 0)
  const prepared = JSON.parse(output)
  assert.equal(prepared.result, "ready")
  assert.equal(prepared.briefs.length, 1)
  const brief = JSON.parse(readFileSync(prepared.briefs[0], "utf8"))
  assert.equal(brief.job, job)
  assert.equal(brief.evaluator.plugin_version, deskVersion())

  const crew = jobId({ deskRemote: `local:${desk}`, personPrefix: "desks/ari", track: "factory", slug: "evaluator" })
  assert.equal((await runEvaluateCommand({ argv: ["--desk", desk, "--task", "desks/ari/factory/evaluator"], env })).job, crew)
  assert.equal((await runEvaluateCommand({ argv: ["--desk", desk, "--task", "desks/ ari /factory/evaluator"], env })).job, crew)
  assert.deepEqual((await runEvaluateCommand({ argv: ["--pending"], env })).jobs.map((entry) => entry.job).sort(), [crew, job].sort())
}))

test("evaluate uses the desk's origin remote when it has one", () => scratch(async (env) => {
  const desk = path.join(env.HOME, "desk")
  await fs.mkdir(desk)
  execFileSync("git", ["init", "-q", desk])
  execFileSync("git", ["-C", desk, "remote", "add", "origin", "https://github.com/example/desk.git"])
  const job = jobId({ deskRemote: "https://github.com/example/desk.git", personPrefix: "", track: "factory", slug: "evaluator" })
  assert.equal((await runEvaluateCommand({ argv: ["--desk", desk, "--task", "factory/evaluator"], env })).job, job)
}))

test("evaluate refuses malformed options, a relative or missing desk and a malformed task", () => scratch(async (env) => {
  const desk = path.join(env.HOME, "desk")
  await fs.mkdir(desk)
  for (const argv of [
    [],
    ["--desk"],
    ["--desk", desk],
    ["--desk", desk, "--task", "factory/evaluator", "--extra", "x"],
    ["--desk", "relative", "--task", "factory/evaluator"],
    ["--desk", desk, "--other", "factory/evaluator"],
    ["--desk", desk, "--task", "factory"],
    ["--desk", desk, "--task", "a/b/c"],
    ["--desk", desk, "--task", "desks/ari/factory"],
    ["--desk", desk, "--task", "factory/_archive"],
    ["--desk", desk, "--task", "desks/../factory/evaluator"],
  ]) {
    await assert.rejects(runEvaluateCommand({ argv, env }), /Usage: factory\.js evaluate/u)
  }
  await assert.rejects(runEvaluateCommand({ argv: ["--desk", path.join(env.HOME, "absent"), "--task", "factory/evaluator"], env }), /desk folder could not be read/u)
}))

test("evaluate-accept checks the evaluator's answer and moves accepted labels into the outbox", () => scratch(async (env) => {
  const job = LABELS_GOLDEN.job
  await seedJob(env, job)
  const { prepareEvaluation } = await import("../../src/factory/evaluate-run.js")
  const [briefFile] = (await prepareEvaluation(env, { job, pluginVersion: LABELS_GOLDEN.evaluator.plugin_version })).briefs
  const brief = JSON.parse(readFileSync(briefFile, "utf8"))
  // No marker names this session's log, so the labels rest on the facts alone.
  const labels = { ...LABELS_GOLDEN, unavailable: ["session_log_missing"] }
  await fs.writeFile(brief.output, JSON.stringify({ ...labels, note: "SENTINEL" }))
  let output = ""
  assert.equal(await main({ argv: ["evaluate-accept", "--job", job], env, write: (text) => { output += text }, logError: () => assert.fail("evaluate-accept must succeed") }), 0)
  assert.equal(output.includes("SENTINEL"), false)
  assert.deepEqual(JSON.parse(output).sessions, [{ session: EVAL_SESSION, result: "rejected", errors: [{ code: "unknown_key", path: "" }] }])
  await fs.writeFile(brief.output, JSON.stringify(labels))
  assert.deepEqual(await runEvaluateAcceptCommand({ argv: ["--job", job], env, pluginVersion: LABELS_GOLDEN.evaluator.plugin_version }), { job, sessions: [{ session: EVAL_SESSION, result: "accepted" }], request: "cleared" })
  const root = await factoryStateRoot(env)
  assert.ok(existsSync(path.join(root, "labels", "ourostack__factory", job, `${EVAL_SESSION}.json`)))
  for (const argv of [[], ["--job", "SENTINEL"], ["--other", "x"], ["--job", job, "--extra", "x"]]) {
    await assert.rejects(runEvaluateAcceptCommand({ argv, env }), (error) => /Usage: factory\.js evaluate-accept/u.test(error.message) && !error.message.includes("SENTINEL"))
  }
}))
