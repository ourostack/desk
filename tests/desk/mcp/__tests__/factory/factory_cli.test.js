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
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  KEYED_LINK_NOTE,
  SUPPORTED_COMMANDS,
  deskVersion,
  isMainModule,
  runIfMain,
  main,
  parseOptions,
  runBuildCommand,
  runKaizenCheckCommand,
  runAndonCommand,
  runConsentCommand,
  runDeriveCommand,
  runFinalizeCommand,
  runFlushCommand,
  runEvaluateAcceptCommand,
  runEvaluateCommand,
  runJobLinkCommand,
  runStatusCommand,
  runValidatePrCommand,
} from "../../../../../plugins/desk/mcp/scripts/factory.js"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { factoryStateRoot, readConsent, readMachineSecret, setConsent, updateStatus, writeLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { STOP_FACTS_BINDING_VERSION } from "../../../../../plugins/desk/mcp/src/factory/evaluate-run.js"
import { keyedJobId } from "../../../../../plugins/desk/mcp/src/factory/publish.js"
import { indexJob } from "./_index_helper.js"
import { osEnv } from "../_os_env.js"

const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/factory.js", import.meta.url))
const FIXTURE_STORE = fileURLToPath(new URL("fixtures/store", import.meta.url))

async function scratch(run) {
  const rawBase = mkdtempSync(path.join(os.tmpdir(), "desk-factory-cli-"))
  const base = await fs.realpath(rawBase)
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
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

  test("validate-pr classifies triage as authenticated data and pins current API actor", async () => {
    const base = "a".repeat(40), head = "b".repeat(40)
    const batchPath = "triage/0123456789abcdef.json"
    const value = JSON.parse(readFileSync(new URL("./fixtures/v12-triage.json", import.meta.url))).public
    const argv = ["--base",base,"--head",head,"--author-association","OWNER","--repo","example/project","--pr","1"]
    const git = mergeGit((args) => {
      if (args[0] === "diff") return `A\0${batchPath}\0`
      if (args[0] === "ls-tree") return args[2] === base ? "" : `100644 blob ${"c".repeat(40)}\t${batchPath}\0`
      if (args[0] === "show") return Buffer.from(JSON.stringify(value))
      assert.fail(`unexpected Git call: ${args}`)
    })
    const runner = (permission, changed = false, unavailable = false) => {
      let reads = 0
      return async (args) => {
        assert.equal(args[0], "api")
        if (args[1] === "repos/example/project/pulls/1") return { code: 0, stdout: JSON.stringify({ head: { sha: head }, user: { login: changed && reads++ > 0 ? "other-synthetic" : "synthetic-actor" } }) }
        assert.equal(args[1], "repos/example/project/collaborators/synthetic-actor/permission")
        return unavailable ? { code:1, stdout:"private error" } : { code:0, stdout:JSON.stringify({ permission }) }
      }
    }
    assert.deepEqual(await runValidatePrCommand({ argv, git, runner: runner("write") }), { ok:true, errors:[], maintenance:false })
    const unassociated = [...argv]; unassociated[5] = "NONE"
    assert.deepEqual(await runValidatePrCommand({ argv:unassociated, git, runner:runner("admin") }), { ok:true,errors:[],maintenance:false })
    for (const permission of ["read","triage"]) {
      const result = await runValidatePrCommand({ argv, git, runner: runner(permission) })
      assert.deepEqual(result, { ok:false, errors:[{ code:"triage_untrusted_producer",path:batchPath }], maintenance:false })
    }
    for (const options of [{ runner:runner("write",true) }, { runner:runner("write",false,true) }, { argv:argv.slice(0,6) }]) {
      const result = await runValidatePrCommand({ argv, git, ...options })
      assert.equal(result.ok, false); assert.equal(result.maintenance, false)
      assert.ok(result.errors.some((e) => e.code === "triage_authority_check_unavailable"))
    }
  })

  test("validate-pr reads regular triage modes and refuses symlinks without reading their target", async () => {
    const base = "a".repeat(40), head = "b".repeat(40), batchPath = "triage/0123456789abcdef.json"
    const argv = ["--base",base,"--head",head,"--author-association","OWNER","--repo","example/project","--pr","1"]
    for (const mode of ["120000", "160000", "000000"]) {
      const git = mergeGit((args) => {
        if (args[0] === "diff") return `A\0${batchPath}\0`
        if (args[0] === "ls-tree") return args[2] === base ? "" : `${mode} blob ${"c".repeat(40)}\t${batchPath}\0`
        assert.fail("must not read invalid triage mode contents")
      })
      const runner = async (args) => ({ code:0, stdout: JSON.stringify(args[1].endsWith("/permission") ? { permission:"admin" } : { head:{sha:head},user:{login:"synthetic-actor"} }) })
      const result = await runValidatePrCommand({ argv, git, runner })
      assert.equal(result.ok, false); assert.equal(result.maintenance, false)
      assert.ok(result.errors.some((e) => e.code === "triage_immutable"))
    }
  })

// ---------------------------------------------------------------------------
// parseOptions.
// ---------------------------------------------------------------------------

test("triage real Git additions are data but replacement removal rename copy and mode changes are immutable", () => scratch(async (env) => {
  const repo = path.join(env.HOME, "triage-repo")
  await fs.mkdir(repo)
  const git = (...args) => execFileSync("git", args, { cwd:repo,encoding:"utf8",stdio:["ignore","pipe","pipe"] }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Synthetic Fixture")
  git("config", "user.email", "synthetic@example.invalid")
  await fs.writeFile(path.join(repo,"README.md"), "synthetic")
  git("add","README.md"); git("commit","-m","base")
  const base = git("rev-parse","HEAD")
  const rel = "triage/0123456789abcdef.json", file = path.join(repo,rel)
  await fs.mkdir(path.dirname(file))
  const value = JSON.parse(readFileSync(new URL("./fixtures/v12-triage.json",import.meta.url))).public
  await fs.writeFile(file, JSON.stringify(value))
  git("add",rel); git("commit","-m","add batch")
  const added = git("rev-parse","HEAD")
  const validate = (base,head,permission = "write") => runValidatePrCommand({
    cwd:repo, argv:["--base",base,"--head",head,"--author-association","OWNER","--repo","example/project","--pr","1"],
    runner:async (args) => ({code:0,stdout:JSON.stringify(args[1].endsWith("/permission") ? {permission} : {head:{sha:head},user:{login:"synthetic-actor"}})}),
  })
  assert.deepEqual(await validate(base,added), {ok:true,errors:[],maintenance:false})
  assert.equal((await validate(base,added,"read")).ok,false)
  const refuse = async (parent,head) => {
    const result = await validate(parent,head)
    assert.equal(result.ok,false)
    assert.equal(result.maintenance,false)
    assert.ok(result.errors.some((e) => e.code === "triage_immutable"),JSON.stringify(result))
  }
  value.rows[0].revision = 2
  await fs.writeFile(file,JSON.stringify(value)); git("add",rel); git("commit","-m","higher revision at existing batch")
  await refuse(added,git("rev-parse","HEAD"))
  git("reset","--hard",added)
  await fs.unlink(file); git("add",rel); git("commit","-m","remove")
  await refuse(added,git("rev-parse","HEAD"))
  git("reset","--hard",added)
  await fs.rename(file,path.join(repo,"triage/1111111111111111.json"))
  git("add","triage"); git("commit","-m","rename")
  await refuse(added,git("rev-parse","HEAD"))
  git("reset","--hard",added)
  await fs.copyFile(file,path.join(repo,"triage/1111111111111111.json"))
  git("add","triage"); git("commit","-m","copy")
  await refuse(added,git("rev-parse","HEAD"))
  git("reset","--hard",added)
  // Portable Git mode change, without relying on Windows chmod semantics.
  git("update-index","--chmod=+x",rel); git("commit","-m","mode change")
  await refuse(added,git("rev-parse","HEAD"))
  git("reset","--hard",added)
  if (process.platform !== "win32") {
    await fs.unlink(file); await fs.symlink("../README.md",file)
    git("add",rel); git("commit","-m","type change")
    await refuse(added,git("rev-parse","HEAD"))
  }
}))

test("similar_new_batch_with_higher_revision_is_added_without_mutating_historical_batch", () => scratch(async (env) => {
  const repo = path.join(env.HOME, "triage-correction-repo")
  await fs.mkdir(repo)
  const git = (...args) => execFileSync("git",args,{cwd:repo,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim()
  git("init","-b","main"); git("config","user.name","Synthetic Fixture"); git("config","user.email","synthetic@example.invalid")
  const value = JSON.parse(readFileSync(new URL("./fixtures/v12-triage.json",import.meta.url))).public
  const oldPath = `triage/${value.batch}.json`, oldBytes = `${JSON.stringify(value)}\n`
  await fs.mkdir(path.join(repo,"triage"))
  await fs.writeFile(path.join(repo,oldPath),oldBytes)
  git("add","triage"); git("commit","-m","historical batch")
  const base = git("rev-parse","HEAD"), oldBlob = git("rev-parse",`${base}:${oldPath}`)
  value.batch = "1111111111111111"; value.rows[0].revision = 2
  const newPath = `triage/${value.batch}.json`
  await fs.writeFile(path.join(repo,newPath),`${JSON.stringify(value)}\n`)
  git("add","triage"); git("commit","-m","new immutable correction batch")
  const head = git("rev-parse","HEAD")
  // Reproduce the review's default-similarity copy heuristic with actual Git.
  assert.match(git("diff","--name-status","--find-renames","--find-copies","--find-copies-harder",base,head), /^C\d+\s/u)
  assert.equal(git("rev-parse",`${head}:${oldPath}`),oldBlob)
  assert.equal(await fs.readFile(path.join(repo,oldPath),"utf8"),oldBytes)
  const result = await runValidatePrCommand({
    cwd:repo,argv:["--base",base,"--head",head,"--author-association","OWNER","--repo","example/project","--pr","1"],
    runner:async (args) => ({code:0,stdout:JSON.stringify(args[1].endsWith("/permission") ? {permission:"write"} : {head:{sha:head},user:{login:"synthetic-actor"}})}),
  })
  assert.deepEqual(result,{ok:true,errors:[],maintenance:false})
}))

test("triage API malformed permission exceptions and changed head stay unavailable", async () => {
  const base = "a".repeat(40), head = "b".repeat(40), rel = "triage/0123456789abcdef.json"
  const value = JSON.parse(readFileSync(new URL("./fixtures/v12-triage.json",import.meta.url))).public
  const argv = ["--base",base,"--head",head,"--author-association","OWNER","--repo","example/project","--pr","1"]
  const git = mergeGit((args) => {
    if (args[0] === "diff") return `A\0${rel}\0`
    if (args[0] === "ls-tree") return args[2] === base ? "" : `100644 blob ${"c".repeat(40)}\t${rel}\0`
    if (args[0] === "show") return Buffer.from(JSON.stringify(value))
    assert.fail(`unexpected ${args}`)
  })

  for (const failure of ["throw","malformed","unknown_permission","changed_head","missing_actor"]) {
    let reads = 0
    const runner = async (args) => {
      if (failure === "throw") throw new Error("PRIVATE_SYNTHETIC_API_ERROR")
      if (failure === "malformed") return {code:0,stdout:"not JSON"}
      if (args[1].endsWith("/permission")) return {code:0,stdout:JSON.stringify({permission: failure === "unknown_permission" ? "OWNER" : "write"})}
      return {code:0,stdout:JSON.stringify({head:{sha:failure === "changed_head" && reads++ > 0 ? base : head},user:failure === "missing_actor" ? {} : {login:"synthetic-actor"}})}
    }
    const result = await runValidatePrCommand({argv,git,runner})
    assert.equal(result.ok,false,failure)
    assert.ok(result.errors.some((e) => e.code === "triage_authority_check_unavailable"))
    assert.equal(JSON.stringify(result).includes("PRIVATE_SYNTHETIC"),false)
  }
})

  test("triage supplementary diff refuses malformed entries and unknown normalized status", async () => {
    const base="a".repeat(40),head="b".repeat(40),rel="triage/0123456789abcdef.json"
    const argv=["--base",base,"--head",head,"--author-association","OWNER"]
    for(const malformed of ["A\0",`R100\0${rel}\0`]) {
      const git=mergeGit((args)=> {
        if(args[0]==="diff")return args.includes("--no-renames")?`A\0${rel}\0`:malformed
        assert.fail("malformed diff must stop before blob reads")
      })
      await assert.rejects(runValidatePrCommand({argv,git}),/Git change list is malformed/u)
    }
    for(const diff of ["",`X\0${rel}\0`,`A\0README.md\0`,`C100\0README.md\0copied.md\0`,`R100\0README.md\0${rel}\0`,`R100\0${rel}\0README.md\0`]) {
      const git=mergeGit((args)=>{
        if(args[0]==="diff")return args.includes("--no-renames")?`A\0${rel}\0`:diff
        if(args[0]==="ls-tree")return ""
        assert.fail("untrusted unknown/rename paths must not read blobs")
      })
      const result=await runValidatePrCommand({argv,git})
      assert.equal(result.ok,false);assert.equal(result.maintenance,false)
      assert.ok(result.errors.some((e)=>e.code==="triage_immutable"))
    }
  })

  test("triage API missing current permission and invalid request identity are unavailable", async () => {
    const base="a".repeat(40),head="b".repeat(40),rel="triage/0123456789abcdef.json"
    const value=JSON.parse(readFileSync(new URL("./fixtures/v12-triage.json",import.meta.url))).public
    const argv=["--base",base,"--head",head,"--author-association","OWNER","--repo","example/project","--pr","1"]
    const git=mergeGit((args)=>{
      if(args[0]==="diff")return `A\0${rel}\0`
      if(args[0]==="ls-tree")return args[2]===base?"":`100644 blob ${"c".repeat(40)}\t${rel}\0`
      if(args[0]==="show")return Buffer.from(JSON.stringify(value))
      assert.fail(`unexpected ${args}`)
    })
    for(const failure of ["pr_failed","permission_throw","permission_bad_json","bad_repo","bad_pr","absent_pr"]) {
      const options=[...argv]
      if(failure==="bad_repo")options[7]="bad/repo/path"
      if(failure==="bad_pr")options[9]="0"
      if(failure==="absent_pr")options[9]=""
      const runner=async(args)=>{
        if(!args[1].endsWith("/permission"))return failure==="pr_failed"?{code:1,stdout:"PRIVATE_ERROR"}:{code:0,stdout:JSON.stringify({head:{sha:head},user:{login:"synthetic-actor"}})}
        if(failure==="permission_throw")throw new Error("PRIVATE_ERROR")
        return {code:0,stdout:"not JSON"}
      }
      const result=await runValidatePrCommand({argv:options,git,runner,env:{}})
      assert.equal(result.ok,false)
      assert.ok(result.errors.some((e)=>e.code==="triage_authority_check_unavailable"),failure)
      assert.equal(JSON.stringify(result).includes("PRIVATE_ERROR"),false)
    }
  })

  test("triage existing nonregular prior path cannot be falsely submitted as a new batch", async () => {
    const base="a".repeat(40),head="b".repeat(40),rel="triage/0123456789abcdef.json"
    const argv=["--base",base,"--head",head,"--author-association","OWNER"]
    const git=mergeGit((args)=>{
      if(args[0]==="diff")return `A\0${rel}\0`
      if(args[0]==="ls-tree")return `120000 blob ${"c".repeat(40)}\t${rel}\0`
      assert.fail("must never follow previous or new symlink target")
    })
    const result=await runValidatePrCommand({argv,git})
    assert.equal(result.ok,false)
    assert.ok(result.errors.some((e)=>e.code==="triage_immutable"))
  })

  test("triage default trusted API runner uses injected fixture environment rather than association", () => scratch(async(env)=>{
    const base="a".repeat(40),head="b".repeat(40),rel="triage/0123456789abcdef.json"
    const value=JSON.parse(readFileSync(new URL("./fixtures/v12-triage.json",import.meta.url))).public
    const bin=path.join(env.HOME,"bin");await fs.mkdir(bin)
    const calls=path.join(bin,"calls.jsonl")
    // ghRunner deliberately spawns without a shell: Windows needs a native
    // executable, not a shebang or .cmd. Only the stand-in gh process preloads
    // this API fixture; the default production runner is not replaced.
    cpSync(process.execPath,path.join(bin,process.platform==="win32"?"gh.exe":"gh"))
    const preload=path.join(bin,"gh-fixture.cjs")
    await fs.writeFile(preload,`const endpoint=process.argv[2];require("node:fs").appendFileSync(${JSON.stringify(calls)},JSON.stringify({endpoint,token:process.env.GH_TOKEN})+"\\n");process.stdout.write(JSON.stringify(endpoint.endsWith("/permission")?{permission:"write"}:{head:{sha:"${head}"},user:{login:"synthetic-actor"}}));process.exit(0);\n`)
    const git=mergeGit((args)=>{
      if(args[0]==="diff")return `A\0${rel}\0`
      if(args[0]==="ls-tree")return args[2]===base?"":`100644 blob ${"c".repeat(40)}\t${rel}\0`
      if(args[0]==="show")return Buffer.from(JSON.stringify(value))
      assert.fail(`unexpected ${args}`)
    })
    const result=await runValidatePrCommand({argv:["--base",base,"--head",head,"--author-association","NONE","--repo","example/project","--pr","1"],git,env:{...env,PATH:`${bin}${path.delimiter}${process.env.PATH}`,GH_TOKEN:"synthetic-test-token",NODE_OPTIONS:`${process.env.NODE_OPTIONS??""} --require ${JSON.stringify(preload)}`.trim()}})
    assert.deepEqual(result,{ok:true,errors:[],maintenance:false})
    assert.equal(existsSync(calls),true,"the real default runner must reach the fixture executable")
    assert.deepEqual(readFileSync(calls,"utf8").trim().split("\n").map((line)=>JSON.parse(line)),[
      {endpoint:"repos/example/project/pulls/1",token:"synthetic-test-token"},
      {endpoint:"repos/example/project/collaborators/synthetic-actor/permission",token:"synthetic-test-token"},
      {endpoint:"repos/example/project/pulls/1",token:"synthetic-test-token"},
    ])
  }))
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
  assert.equal(result.orphan_pass, "orphan pass: no record yet")
}))

test("status prints one line for the orphan pass: what it did, or the class it failed with", () => scratch(async (env) => {
  const { writeStatus } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  const run = async () => {
    let output = ""
    assert.equal(await main({ argv: ["status"], env, write: (text) => { output += text }, logError: () => assert.fail("status must succeed") }), 0)
    return JSON.parse(output).orphan_pass
  }
  await writeStatus(env, { orphans: { started_at: "2026-10-06T00:00:00.000Z", ran_at: "2026-10-06T00:00:05.000Z", examined: 2, unexamined: 1, pending: 0, frozen: { no_facts: 1 }, last_wrap_at: null, sweeps_in_walk: 1 } })
  assert.equal(await run(), "orphan pass: ran 2026-10-06T00:00:05.000Z, examined 2, unexamined 1, pending 0, frozen 1, last full walk never, 1 sweeps into the walk")
  await writeStatus(env, { orphans: { started_at: "2026-10-06T00:00:00.000Z", ran_at: "2026-10-06T00:00:05.000Z", last_wrap_at: null, sweeps_in_walk: 1, failed: "pass_failed" } })
  assert.equal(await run(), "orphan pass: failed (pass_failed), last full walk never")
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

/** Records `repo` as a private desk in the factory state's visibility cache, so job-link names its plain job ID. */
async function knownPrivate(env, repo) {
  await fs.writeFile(path.join(await factoryStateRoot(env), "visibility.json"), JSON.stringify({ [repo]: { visibility: "private", checked_at: new Date().toISOString() } }))
}

test("build writes the deterministic report tree and job-link returns the accepted URL", () => scratch(async (env) => {
  const store = path.join(env.HOME, "store")
  const out = path.join(store, "_out")
  cpSync(FIXTURE_STORE, store, { recursive: true })
  assert.deepEqual(await runBuildCommand({ argv: ["--store", store, "--out", out] }), { jobs: 2, sessions: 4 })
  assert.equal(JSON.parse(readFileSync(path.join(out, "jobs", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"), "utf8")).job, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  await knownPrivate(env, "ourostack/desk")
  assert.deepEqual(await runJobLinkCommand({ env, argv: ["--store", "ourostack/factory", "--desk-remote", "git@github.com:OuroStack/Desk.git", "--person-prefix", "", "--track", "factory", "--slug", "store-pipeline"] }), {
    link: "https://github.com/ourostack/factory/blob/reports/jobs/3e7101c7c7d8774223be31b99495dd7f.md",
  })
  assert.deepEqual(await runJobLinkCommand({ env, argv: ["--store", "ourostack/factory", "--desk-remote", "git@github.com:OuroStack/Desk.git", "--track", "factory", "--slug", "store-pipeline"] }), {
    link: "https://github.com/ourostack/factory/blob/reports/jobs/3e7101c7c7d8774223be31b99495dd7f.md",
  })
  await assert.rejects(runBuildCommand({ argv: ["--store", store] }), /Usage: factory\.js build/u)
  await assert.rejects(runJobLinkCommand({ argv: ["--store", "ourostack/factory"] }), /Usage: factory\.js job-link/u)
}))

test("job-link --this-machine names where this machine's sessions are reported: the plain job on a private desk, the keyed one elsewhere", () => scratch(async (env) => {
  const argv = (remote) => ["--store", "ourostack/factory", "--desk-remote", remote, "--track", "factory", "--this-machine", "--slug", "store-pipeline"]
  await knownPrivate(env, "ourostack/desk")
  assert.deepEqual(await runJobLinkCommand({ env, argv: argv("git@github.com:OuroStack/Desk.git") }), {
    link: "https://github.com/ourostack/factory/blob/reports/jobs/3e7101c7c7d8774223be31b99495dd7f.md",
    keyed: false,
  })
  // A desk whose visibility is not known (absent or expired): no link that might be wrong, keyed or plain.
  const remote = "git@github.com:someone/public-desk.git"
  assert.deepEqual(await runJobLinkCommand({ env, argv: ["--store", "ourostack/factory", "--desk-remote", remote, "--track", "factory", "--slug", "store-pipeline"] }), { link: null, reason: "visibility_not_known" })
  assert.deepEqual(await runJobLinkCommand({ env, argv: argv(remote) }), { link: null, reason: "visibility_not_known" })
  const expired = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  await fs.writeFile(path.join(await factoryStateRoot(env), "visibility.json"), JSON.stringify({ "ourostack/desk": { visibility: "private", checked_at: expired }, "someone/public-desk": { visibility: "public", checked_at: new Date().toISOString() } }))
  assert.deepEqual(await runJobLinkCommand({ env, argv: argv("git@github.com:OuroStack/Desk.git") }), { link: null, reason: "visibility_not_known" })
  // A desk known public on a machine that has published nothing keyed: no secret, so no link, and none is created.
  const secretFile = path.join(await factoryStateRoot(env), "machine-secret")
  assert.equal(existsSync(secretFile), false)
  assert.deepEqual(await runJobLinkCommand({ env, argv: argv(remote) }), { link: null, reason: "no_machine_secret" })
  assert.equal(existsSync(secretFile), false, "job-link never creates the machine secret")
  // Once the machine has its secret, the operator gets this machine's keyed report, with the note that keeps it private.
  const secret = await readMachineSecret(env)
  const keyed = keyedJobId(jobId({ deskRemote: remote, personPrefix: "", track: "factory", slug: "store-pipeline" }), secret)
  assert.deepEqual(await runJobLinkCommand({ env, argv: argv(remote) }), { link: `https://github.com/ourostack/factory/blob/reports/jobs/${keyed}.md`, keyed: true, note: KEYED_LINK_NOTE })
  assert.match(KEYED_LINK_NOTE, /never put it on the task card, in a pull request or anywhere public/u)
  // The flag takes no value of its own, and the usage line names it.
  await assert.rejects(runJobLinkCommand({ env, argv: ["--this-machine"] }), /--this-machine\]/u)
}))

test("job-link resolves the card's birth path first when --desk is given, so a renamed card's link matches the job the task tools already agree on (ourostack/desk#76)", () => scratch(async (env) => {
  const desk = path.join(env.HOME, "job-link-desk")
  const git = (...args) => execFileSync("git", args, { cwd: desk, encoding: "utf8" })
  await fs.mkdir(path.join(desk, "track", "origin-slug"), { recursive: true })
  await fs.writeFile(path.join(desk, "track", "origin-slug", "task.md"), "---\nstatus: drafting\n---\n\n# A task\n")
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  git("add", "-A")
  git("commit", "-q", "-m", "create")
  await fs.rm(path.join(desk, "track", "origin-slug"), { recursive: true })
  await fs.mkdir(path.join(desk, "track", "new-slug"), { recursive: true })
  await fs.writeFile(path.join(desk, "track", "new-slug", "task.md"), "---\nstatus: drafting\n---\n\n# A task\n")
  git("add", "-A")
  git("commit", "-q", "-m", "rename the slug")

  const remote = "git@github.com:OuroStack/Desk.git"
  const birthJob = jobId({ deskRemote: remote, personPrefix: "", track: "track", slug: "origin-slug" })
  const currentJob = jobId({ deskRemote: remote, personPrefix: "", track: "track", slug: "new-slug" })
  assert.notEqual(birthJob, currentJob)

  await knownPrivate(env, "ourostack/desk")
  const withoutDesk = await runJobLinkCommand({ env, argv: ["--store", "ourostack/factory", "--desk-remote", remote, "--track", "track", "--slug", "new-slug"] })
  assert.equal(withoutDesk.link, `https://github.com/ourostack/factory/blob/reports/jobs/${currentJob}.md`, "without --desk, the given (current) path is hashed as-is")

  const withDesk = await runJobLinkCommand({ env, argv: ["--store", "ourostack/factory", "--desk-remote", remote, "--desk", desk, "--track", "track", "--slug", "new-slug"] })
  assert.equal(withDesk.link, `https://github.com/ourostack/factory/blob/reports/jobs/${birthJob}.md`, "with --desk, the card's birth path is resolved and hashed instead")

  await assert.rejects(runJobLinkCommand({ argv: ["--store", "ourostack/factory", "--desk-remote", remote, "--desk", "relative", "--track", "track", "--slug", "new-slug"] }), /Usage: factory\.js job-link/u, "--desk must be absolute")
  await assert.rejects(runJobLinkCommand({ argv: ["--store", "ourostack/factory", "--desk-remote", remote, "--desk", path.join(env.HOME, "no-such-desk"), "--track", "track", "--slug", "new-slug"] }), /the desk folder could not be read/u)
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

test("validate-pr marks non-fact files under facts/ as maintenance, validates a delete of a facts file for a maintainer only, and refuses a head whose merge conflicts", () => scratch(async (env) => {
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
  // Deleting a facts file is a retraction: it validates like any change at that path for a maintainer and is not maintenance; anyone else's is refused.
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.deepEqual(await runValidatePrCommand({ argv: ["--base", forkPoint, "--head", cleanupHead, "--author-association", association], cwd: repo }), {
      ok: true,
      maintenance: false,
      errors: [],
    })
  }
  for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"]) {
    assert.deepEqual(await runValidatePrCommand({ argv: ["--base", forkPoint, "--head", cleanupHead, "--author-association", association], cwd: repo }), {
      ok: false,
      maintenance: false,
      errors: [{ code: "removal", path: `facts/${names[1]}` }],
    })
  }

  // A maintainer's removal of a non-data file stays maintenance, and a mixed PR of adds plus valid removals is accepted.
  git("checkout", "-q", "-b", "mixed", forkPoint)
  git("rm", "-q", path.join("facts", names[1]))
  await fs.writeFile(path.join(repo, "README.md"), "maintainer readme")
  git("add", "README.md")
  git("commit", "-q", "-m", "mixed")
  const mixedHead = git("rev-parse", "HEAD")
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", forkPoint, "--head", mixedHead, "--author-association", "OWNER"], cwd: repo }), { ok: true, maintenance: true, errors: [] })
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", forkPoint, "--head", mixedHead, "--author-association", "NONE"], cwd: repo }), {
    ok: false, maintenance: false, errors: [{ code: "path", path: "changes.0" }, { code: "removal", path: `facts/${names[1]}` }],
  })
  git("checkout", "-q", "-b", "mixed-data", forkPoint)
  git("rm", "-q", path.join("facts", names[1]))
  const added = JSON.parse(readFileSync(path.join(facts, names[0]), "utf8"))
  const newName = "claude-code-33333333-3333-4333-8333-333333333333.json"
  added.session.id = "33333333-3333-4333-8333-333333333333"
  await fs.writeFile(path.join(facts, newName), `${JSON.stringify(added)}\n`)
  git("add", "facts")
  git("commit", "-q", "-m", "mixed data")
  const mixedData = git("rev-parse", "HEAD")
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", forkPoint, "--head", mixedData, "--author-association", "MEMBER"], cwd: repo }), { ok: true, maintenance: false, errors: [] })
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

  // Removing labels is a retraction: it validates for a maintainer and is refused for anyone else.
  git("checkout", "-q", "-b", "drop-label", label1111Head)
  git("rm", "-q", LABEL_1111)
  git("commit", "-q", "-m", "drop label")
  const dropHead = git("rev-parse", "HEAD")
  assert.deepEqual(await validate(label1111Head, dropHead, "MEMBER"), { ok: true, maintenance: false, errors: [] })
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
    `ls-tree -z --name-only ${shaA} -- ${facts1111} facts/copilot-cli-11111111-1111-4111-8111-111111111111.json facts/codex-cli-11111111-1111-4111-8111-111111111111.json`,
    `show ${shaA}:${facts1111}`,
    `show ${MERGE_TREE}:${facts2222}`,
    `show ${shaA}:${facts2222}`,
    `show ${MERGE_TREE}:${LABEL_2222}`,
    `ls-tree -z --name-only ${shaA} -- facts/claude-code-22222222-2222-4222-8222-222222222222.json facts/codex-cli-22222222-2222-4222-8222-222222222222.json`,
    `show ${MERGE_TREE}:${facts2222}`,
  ])
})

test("validate-pr asks Git nothing about base facts when the pull request touches every facts path of a labeled session", async () => {
  const facts1111 = "facts/claude-code-11111111-1111-4111-8111-111111111111.json"
  const copilot1111 = "facts/copilot-cli-11111111-1111-4111-8111-111111111111.json"
  const codex1111 = "facts/codex-cli-11111111-1111-4111-8111-111111111111.json"
  const bytes = { [facts1111]: readFileSync(path.join(FIXTURE_STORE, facts1111)), [LABEL_1111]: readFileSync(path.join(FIXTURE_STORE, LABEL_1111)) }
  const calls = []
  const result = await runValidatePrCommand({
    argv: ["--base", "a".repeat(40), "--head", "b".repeat(40), "--author-association", "NONE"],
    git: mergeGit((gitArgs) => {
      calls.push(gitArgs[0])
      if (gitArgs[0] === "diff") return `A\0${facts1111}\0D\0${copilot1111}\0D\0${codex1111}\0A\0${LABEL_1111}\0`
      return bytes[gitArgs[1].slice(41)]
    }),
  })
  assert.deepEqual(result, { ok: false, maintenance: false, errors: [{ code: "removal", path: copilot1111 }, { code: "removal", path: codex1111 }] })
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

  result = await runValidatePrCommand({ argv: args, git: mergeGit(() => `D\0${validPath}\0`) })
  assert.deepEqual(result, { ok: false, maintenance: false, errors: [{ code: "removal", path: validPath }] })
  result = await runValidatePrCommand({ argv: args.map((arg) => (arg === "NONE" ? "OWNER" : arg)), git: mergeGit(() => `D\0${validPath}\0`) })
  assert.deepEqual(result, { ok: true, maintenance: false, errors: [] })
  result = await runValidatePrCommand({ argv: args, git: mergeGit(() => `X\0${validPath}\0`) })
  assert.deepEqual(result, { ok: false, maintenance: false, errors: [{ code: "status", path: validPath }] })

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
    git: mergeGit(() => `X\0${validPath}\0`),
    write: (text) => { output += text },
    logError: (text) => { logged += text },
  })
  assert.equal(invalidCode, 1)
  assert.deepEqual(JSON.parse(output), { ok: false, maintenance: false, errors: [{ code: "status", path: validPath }] })
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
  const module = path.resolve("/a/b.js")
  assert.equal(isMainModule(pathToFileURL(module).href, module), true)
  assert.equal(isMainModule(pathToFileURL(module).href, path.resolve("/a/other.js")), false)
  assert.equal(isMainModule(pathToFileURL(module).href, undefined), false)
})

// ---------------------------------------------------------------------------
// The real CLI: a subprocess round trip against a throwaway state root.
// ---------------------------------------------------------------------------

function runCli(args, env) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env })
}

test("the CLI consent round trip: yes mints an intake_id, a later no keeps it, both visible in the written consent.json", () => scratch(async (env) => {
  // NODE_OPTIONS stripped: this real CLI subprocess is not anything whose own coverage this suite needs to
  // measure, so it has no reason to inherit the coverage runner's instrumentation registration.
  const fullEnv = { ...process.env, ...env }
  delete fullEnv.NODE_OPTIONS
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
  // NODE_OPTIONS stripped: this real CLI subprocess is not anything whose own coverage this suite needs to
  // measure, so it has no reason to inherit the coverage runner's instrumentation registration.
  const fullEnv = { ...process.env, ...env }
  delete fullEnv.NODE_OPTIONS
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

test("finalize starts the loop worker when the evaluator step is due, after every job, and a kick that fails changes nothing printed", () => scratch(async (env) => {
  const a = "a".repeat(32)
  const kicks = []
  assert.deepEqual(await runFinalizeCommand({ argv: ["--job", a], env, kick: async (given) => { kicks.push(given) } }), { jobs: { [a]: { result: "retained", reason: "no_state" } } })
  assert.deepEqual(kicks, [env])
  assert.deepEqual(await runFinalizeCommand({ argv: ["--job", a], env, kick: async () => { throw new Error("SENTINEL kick") } }), { jobs: { [a]: { result: "retained", reason: "no_state" } } })
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
  // The job's binding holds the main worker for the whole session, so its own part is known and the session is briefed.
  facts.jobs[2].agents = [0]
  facts.jobs[2].segments = [{ start_ms: 0, end_ms: Date.parse(facts.session.ended_at) - Date.parse(facts.session.started_at) }]
  facts.jobs.sort((a, b) => (a.job < b.job ? -1 : 1))
  await setConsent(env, { store: "ourostack/factory", contribute: true })
  await writeLocalFacts(env, "ourostack/factory", facts)
  await indexJob(env, job, `claude-code-${EVAL_SESSION}.json`)
  // Derived with stop facts, as this machine derives today.
  await updateStatus(env, (current) => ({ ...current, derivations: { ...current.derivations, [`claude-code-${EVAL_SESSION}.json`]: { store: "ourostack/factory", binding_version: STOP_FACTS_BINDING_VERSION } } }))
}

test("deskVersion is the installed plugin's version", () => {
  assert.equal(deskVersion(), JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../plugins/desk/plugin.json", import.meta.url)), "utf8")).version)
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

test("evaluate computes the task's job from its birth path, not its current one (ourostack/desk#76)", () => scratch(async (env) => {
  const desk = path.join(env.HOME, "desk")
  const git = (...args) => execFileSync("git", args, { cwd: desk, encoding: "utf8" }).trim()
  await fs.mkdir(path.join(desk, "factory", "origin-evaluator"), { recursive: true })
  await fs.writeFile(path.join(desk, "factory", "origin-evaluator", "task.md"), "---\nstatus: drafting\n---\n\n# Evaluator task, unique body for the birth-path CLI fixture.\n")
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  git("add", "-A")
  git("commit", "-q", "-m", "create the evaluator task")
  await fs.rename(path.join(desk, "factory", "origin-evaluator"), path.join(desk, "factory", "renamed-evaluator"))
  git("add", "-A")
  git("commit", "-q", "-m", "rename the evaluator task")
  const birthJob = jobId({ deskRemote: `local:${desk}`, personPrefix: "", track: "factory", slug: "origin-evaluator" })
  const result = await runEvaluateCommand({ argv: ["--desk", desk, "--task", "factory/renamed-evaluator"], env, pluginVersion: "3.2.0-alpha.40" })
  assert.equal(result.job, birthJob, "the CLI's evaluate subcommand hashes the birth path, agreeing with the task tools")
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
  const { prepareEvaluation } = await import("../../../../../plugins/desk/mcp/src/factory/evaluate-run.js")
  const [briefFile] = (await prepareEvaluation(env, { job, pluginVersion: LABELS_GOLDEN.evaluator.plugin_version })).briefs
  const brief = JSON.parse(readFileSync(briefFile, "utf8"))
  // No marker names this session's log, so the labels rest on the facts alone.
  // The current labels form: labels /3 under rubric 4, with no stop classified.
  const labels = { ...LABELS_GOLDEN, schema: "desk.factory.labels/3", evaluator: { ...LABELS_GOLDEN.evaluator, rubric: "4" }, stops: [], unavailable: ["session_log_missing"] }
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

test("kaizen-check reads the store's jobs, checks each open card through gh with GH_TOKEN and prints each card's status", () => scratch(async (env) => {
  const store = path.join(env.HOME, "store")
  cpSync(FIXTURE_STORE, store, { recursive: true })
  const card = "```yaml\nkaizen: 1\nsignal: tool_retries\njob_class: any\nplugin: desk\nversion: 3.2.0\nhypothesis: { measure: tool_retries, direction: down }\n```\n"
  const calls = []
  const runner = async (args, options) => {
    calls.push({ args, token: options.token, input: options.input })
    const route = args[args.indexOf("X-GitHub-Api-Version: 2022-11-28") + 1]
    if (route.startsWith("repos/ourostack/factory/issues?")) return { code: 0, stdout: JSON.stringify([{ number: 4, title: "Card", body: card, labels: [{ name: "kaizen" }], state: "open", user: { login: "someone" } }]), stderr: "" }
    if (route.startsWith("repos/ourostack/factory/issues/4/comments?")) return { code: 0, stdout: "[]", stderr: "" }
    return { code: 0, stdout: "{}", stderr: "" }
  }
  const tokenEnv = { ...env, GH_TOKEN: "ghs_SENTINEL" }
  const result = await runKaizenCheckCommand({ argv: ["--store", store, "--repo", "ourostack/factory"], env: tokenEnv, runner })
  assert.deepEqual(result, { cards: [{ number: 4, status: "too_few_jobs", comment: "created", labels: [] }], failed: 0 })
  assert.ok(calls.every((call) => call.token === "ghs_SENTINEL" && !call.args.includes("ghs_SENTINEL")))
  assert.match(JSON.parse(calls.at(-1).input).body, /Kaizen check: not enough independent jobs yet/u)
  const withAuthor = await runKaizenCheckCommand({ argv: ["--store", store, "--repo", "ourostack/factory", "--author", "someone"], env: tokenEnv, runner })
  assert.equal(withAuthor.cards[0].number, 4)
  await assert.rejects(runKaizenCheckCommand({ argv: ["--store", store], env: tokenEnv, runner }), /Usage: factory\.js kaizen-check/u)
  await assert.rejects(runKaizenCheckCommand({ argv: ["--store", store, "--repo", "ourostack/factory", "--extra", "x"], env: tokenEnv, runner }), /Usage: factory\.js kaizen-check/u)
  await assert.rejects(runKaizenCheckCommand({ argv: ["--store", store, "--repo", "ourostack/factory"], env, runner }), /GH_TOKEN must hold/u)
  assert.ok(SUPPORTED_COMMANDS.includes("kaizen-check"))
  // A card whose calls fail is reported, and the command exits 1 after checking the rest.
  const failing = async (args, options) => {
    const route = args[args.indexOf("X-GitHub-Api-Version: 2022-11-28") + 1]
    if (route.startsWith("repos/ourostack/factory/issues/4/comments?")) return { code: 1, stdout: "", stderr: "gh: Server Error (HTTP 502)" }
    return runner(args, options)
  }
  let output = ""
  const code = await main({ argv: ["kaizen-check", "--store", store, "--repo", "ourostack/factory"], env: tokenEnv, runner: failing, write: (text) => { output += text }, logError: () => assert.fail("a failed card is a result, not an error") })
  assert.equal(code, 1)
  assert.deepEqual(JSON.parse(output), { cards: [{ number: 4, status: "failed", code: "http_502" }], failed: 1 })
}))

test("kaizen-check uses the real gh runner when none is injected", () => scratch(async (env) => {
  const store = path.join(env.HOME, "store")
  cpSync(FIXTURE_STORE, store, { recursive: true })
  // An empty PATH means gh cannot start: the stable code, not a crash.
  await assert.rejects(runKaizenCheckCommand({ argv: ["--store", store, "--repo", "ourostack/factory"], env: { ...env, GH_TOKEN: "ghs_SENTINEL", PATH: "" } }), (error) => error.code === "gh_missing")
}))

test("andon reads the store's jobs and syncs its alarms through gh with GH_TOKEN", () => scratch(async (env) => {
  const store = path.join(env.HOME, "store")
  cpSync(FIXTURE_STORE, store, { recursive: true })
  const routes = []
  const runner = async (args, options) => {
    assert.equal(options.token, "ghs_SENTINEL")
    routes.push(args[args.indexOf("X-GitHub-Api-Version: 2022-11-28") + 1])
    return { code: 0, stdout: "[]", stderr: "" }
  }
  const argv = ["--store", store, "--repo", "ourostack/factory"]
  const tokenEnv = { ...env, GH_TOKEN: "ghs_SENTINEL" }
  // A store without factory.json tracks no plugin.
  assert.deepEqual(await runAndonCommand({ argv, env: tokenEnv, runner }), { tracked: [], alarms: [], failed: 0 })
  assert.deepEqual(routes, ["repos/ourostack/factory/issues?state=all&labels=andon&per_page=100&page=1"])
  await fs.writeFile(path.join(store, "factory.json"), '{"andon":{"plugins":["desk"]}}\n')
  assert.deepEqual(await runAndonCommand({ argv, env: tokenEnv, runner }), { tracked: ["desk"], alarms: [], failed: 0 })
  await fs.writeFile(path.join(store, "factory.json"), '{"andon":{"plugins":"desk"}}\n')
  await assert.rejects(runAndonCommand({ argv, env: tokenEnv, runner }), /the store's factory\.json is not valid \(invalid_config\)/u)
  await assert.rejects(runAndonCommand({ argv: ["--repo", "ourostack/factory"], env: { ...env, GH_TOKEN: "x" }, runner }), /Usage: factory\.js andon/u)
  assert.ok(SUPPORTED_COMMANDS.includes("andon"))
}))

test("runIfMain runs the command and sets the exit code only for this module's own path", async () => {
  const before = process.exitCode
  try {
    const module = path.resolve("/a/b.js")
    assert.equal(await runIfMain(pathToFileURL(module).href, path.resolve("/a/other.js"), async () => assert.fail("must not run")), false)
    assert.equal(await runIfMain(pathToFileURL(module).href, module, async () => 3), true)
    assert.equal(process.exitCode, 3)
  } finally {
    process.exitCode = before
  }
})

test("main writes to stdout and stderr by default", async () => {
  const out = []
  const err = []
  const write = process.stdout.write
  const error = process.stderr.write
  process.stdout.write = (text) => { out.push(String(text)); return true }
  process.stderr.write = (text) => { err.push(String(text)); return true }
  try {
    assert.equal(await main({ argv: ["no-such-command"] }), 1)
    // With no argv, main reads the process arguments, which name no subcommand here.
    assert.equal(await main(), 1)
    assert.equal(await main({ argv: ["validate-pr"] }), 1)
    assert.equal(await main({ argv: ["reconcile", "--desk", "/nonexistent-desk-for-test", "--since", "2026-09-28T00:00:00Z", "--until", "2026-09-29T00:00:00Z"], env: { HOME: "/nonexistent-home-for-test" } }), 1)
  } finally {
    process.stdout.write = write
    process.stderr.write = error
  }
  assert.match(err.join(""), /unknown subcommand/u)
  assert.equal(out.length, 1)
  assert.equal(JSON.parse(out[0]).ok, false)
})
