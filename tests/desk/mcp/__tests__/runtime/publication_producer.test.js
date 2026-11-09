import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
const producerModule = (name, fallback) => process.env.DESK_PRODUCER_REVIEW_ROOT
  ? `${process.env.DESK_PRODUCER_REVIEW_ROOT}/${name}.mjs` : fallback
const { commitPaths, commitIndexPaths, indexEntries } = await import(producerModule("git-stage", "../../../../../plugins/desk/mcp/src/util/git-stage.js"))
const publication = await import(producerModule("publication-state", "../../../../../plugins/desk/mcp/src/runtime/publication-state.js"))
const { desk_save } = await import(producerModule("desk-save", "../../../../../plugins/desk/mcp/src/tools/desk-save.js"))
const { createDeskSession } = await import(producerModule("desk-session", "../../../../../plugins/desk/mcp/src/runtime/desk-session.js"))
const server = await import(producerModule("server", "../../../../../plugins/desk/mcp/src/server.js"))

function fixture(t, { seeded = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-producer-"))
  const root = path.join(dir, "root"), remote = path.join(dir, "remote.git"), home = path.join(dir, "home")
  for (const folder of [root, remote, home]) mkdirSync(folder)
  const env = { PATH: "/usr/bin:/bin", HOME: home, XDG_STATE_HOME: path.join(dir, "state"),
    XDG_CONFIG_HOME: path.join(home, "config"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" }
  const git = (...args) => {
    const result = spawnSync("/usr/bin/git", ["-C", root, ...args], { env, encoding: "utf8", timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  assert.equal(spawnSync("/usr/bin/git", ["init", "--bare", "-q", remote], { env }).status, 0)
  git("init", "-q", "-b", "main"); git("config", "user.name", "Owned producer"); git("config", "user.email", "fixture@example.invalid")
  if (seeded) {
    writeFileSync(path.join(root, "seed"), "seed\n"); git("add", "seed"); git("commit", "-qm", "seed")
    git("remote", "add", "origin", remote); git("push", "-qu", "origin", "main")
  }
  const context = publication.createPublicationContext({ root, env, sessionId: "trusted-fixture" })
  t.after(() => t.diagnostic(JSON.stringify({ retainedFixture: dir })))
  return { root, remote, env, git, context }
}

test("an owned helper returns a context-bound exact commit receipt without publishing staged foreign bytes", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, "own"), "owned\n")
  f.git("add", "own")
  writeFileSync(path.join(f.root, "foreign"), "foreign\n"); f.git("add", "foreign")
  const before = f.git("rev-parse", "HEAD")
  const result = await commitPaths(f.root, ["own"], "owned commit",
    (command, args, options) => spawnSync(command, args, { ...options, env: { ...f.env, DESK_TOOL_COMMIT: "1" } }),
    "main", { publicationContext: f.context })
  assert.equal(result.ok, true, result.stderr)
  assert.deepEqual(Object.keys(result).sort(), ["ok", "stderr"])
  const receipt = publication.publicationReceiptOf({ context: f.context, commitResult: result })
  assert.equal(receipt.status, "qualified")
  assert.throws(() => publication.createPublicationIntent({ context: f.context, commitReceipt: JSON.parse(JSON.stringify(receipt.receipt)) }),
    { code: "publication_commit_receipt_required" })
  const intent = publication.createPublicationIntent({ context: f.context, commitReceipt: receipt.receipt })
  const ticket = publication.requestPublication({ context: f.context, intent })
  const final = await publication.flushPublication({ context: f.context, id: ticket.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ result, receipt: { status: receipt.status }, ticket: final }))
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(f.git("rev-parse", `${final.targetCommit}^`), before)
  assert.equal(f.git("diff-tree", "--no-commit-id", "--name-only", "-r", final.targetCommit), "own")
  assert.equal(f.git("diff", "--cached", "--name-only"), "foreign")
  assert.equal(readFileSync(path.join(f.root, "foreign"), "utf8"), "foreign\n")
  assert.equal(publication.publicationReceiptOf({ context: f.context, commitResult: { ...result } }).status, "unqualified")
  publication.closePublicationContext(f.context)
  assert.throws(() => publication.createPublicationIntent({ context: f.context, commitReceipt: receipt.receipt }), { code: "publication_context_invalid" })
})

test("desk_save requests publication only from its actual validated helper receipt", async (t) => {
  const f = fixture(t)
  let legacy = 0
  const result = await desk_save({ deskRoot: f.root, input: { files: [{ path: "saved.md", content: "saved\n" }], message: "save" },
    statusContext: { publicationContext: f.context, stateBranch: "main" },
    spawnGit: (command, args, options) => spawnSync(command, args, { ...options, env: f.env }),
    schedulePush: () => { legacy += 1 } })
  assert.equal(result.status, "committed")
  assert.equal(legacy, 0)
  assert.ok(result.publication?.id)
  const final = await publication.flushPublication({ context: f.context, id: result.publication.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ result, final }))
  assert.equal(final.state, "verified", JSON.stringify(final))
})

test("a configured caller reflog action retains its commit but cannot fall back to legacy publication", async (t) => {
  const f = fixture(t)
  const context = publication.createPublicationContext({ root: f.root, env: { ...f.env, GIT_REFLOG_ACTION: "existing exact action" }, sessionId: "caller-action" })
  let legacy = 0
  const result = await desk_save({ deskRoot: f.root, input: { files: [{ path: "saved.md", content: "saved\n" }], message: "save" },
    statusContext: { publicationContext: context, stateBranch: "main" },
    spawnGit: (command, args, options) => spawnSync(command, args, { ...options, env: f.env }), schedulePush: () => { legacy += 1 } })
  assert.equal(result.status, "committed")
  assert.equal(legacy, 0)
  assert.equal(result.publication.status, "unqualified")
  assert.equal(result.publication.reason, "publication_caller_reflog_action_preserved")
  assert.ok(f.git("reflog", "-1", "--format=%gs").startsWith("existing exact action: "))
})

test("an admitted session injects producer authority and its accepted desk_save ticket survives disposal", async (t) => {
  const f = fixture(t)
  const session = createDeskSession({
    args: { person: null }, env: f.env, deskStateDir: path.join(f.env.XDG_STATE_HOME, "session"),
    readinessStateHome: path.join(f.env.XDG_STATE_HOME, "readiness"), removeLeftovers: async () => {},
    stderr: { write() {} }, watch: () => ({ close() {} }),
    resolveInputs: async () => ({ root: { root: f.root, source: "explicit-root" }, activation: {
      stateBranch: "main", readinessPolicy: { lexical: "required", semantic: "unsupported", write_authority: "workspace", authority_provider: null, root: "workspace" },
    } }),
    git: async ({ cwd, args }) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { env: f.env, encoding: "utf8", timeout: 10000 })
      return { ...result, ok: result.status === 0, stdout: result.stdout.trim() }
    },
    loadRuntime: async () => ({ runtimeServer: { ...server,
      createSearchEngine: () => ({ warm() {}, async close() {}, noteChange() {}, searchStatus: () => ({ state: "ready" }) }),
    }, runtimeStatus: { state: "ready" } }),
  })
  t.after(() => session.dispose())
  await session.start()
  const answer = await session.callTool({ name: "desk_save", input: { files: [{ path: "session.md", content: "session saved\n" }], message: "session save" } })
  const result = JSON.parse(answer.content[0].text)
  t.diagnostic(JSON.stringify({ firstResult: result }))
  assert.equal(result.status, "committed")
  assert.ok(result.publication?.id)
  await session.dispose()
  const fresh = publication.createPublicationContext({ root: f.root, env: f.env, sessionId: "fresh-after-disposal" })
  const final = await publication.flushPublication({ context: fresh, id: result.publication.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ final }))
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(f.git("show", `${final.targetCommit}:session.md`), "session saved")
})

test("a native producer response loss retains exact commit custody and does not replay the mutation", async (t) => {
  const f = fixture(t)
  const observer = path.join(path.dirname(f.root), "lose-commit-response.cjs")
  writeFileSync(observer, `const cp=require("node:child_process");const original=cp.spawn;
if(process.argv.includes("--native-owner"))cp.spawn=function(command,args,options){
 const child=original.call(this,command,args,options);
 if(command==="git"&&args.includes("commit"))child.once("exit",()=>process.kill(process.pid,"SIGKILL"));
 return child;
};
`)
  const context = publication.createPublicationContext({ root: f.root, env: { ...f.env, NODE_OPTIONS: `--require=${observer}` }, sessionId: "lost-response" })
  writeFileSync(path.join(f.root, "owned-loss"), "owned loss\n"); f.git("add", "owned-loss")
  const before = f.git("rev-parse", "HEAD")
  const result = await commitPaths(f.root, ["owned-loss"], "lost response", spawnSync, "main", { publicationContext: context })
  const receipt = publication.publicationReceiptOf({ context, commitResult: result })
  t.diagnostic(JSON.stringify({ result, receipt, before, after: f.git("rev-parse", "HEAD") }))
  assert.equal(receipt.status, "qualified")
  assert.equal(result.ok, true)
  assert.equal(f.git("rev-list", "--count", `${before}..HEAD`), "1")
  const intent = publication.createPublicationIntent({ context, commitReceipt: receipt.receipt })
  const ticket = publication.requestPublication({ context, intent })
  const final = await publication.flushPublication({ context, id: ticket.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ final }))
  assert.equal(final.state, "verified", JSON.stringify(final))
})

test("index-only receipt commits the captured entry without altering the real index or later working bytes", async (t) => {
    const f = fixture(t)
    writeFileSync(path.join(f.root, "own"), "staged owned\n"); f.git("add", "own")
    writeFileSync(path.join(f.root, "foreign"), "staged foreign\n"); f.git("add", "foreign")
    const git = (command, args, options) => spawnSync(command, args, { ...options, env: f.env })
    const entries = indexEntries(f.root, ["own"], git)
    const indexBefore = readFileSync(path.join(f.root, ".git/index"))
    writeFileSync(path.join(f.root, "own"), "later working draft\n")
    const result = await commitIndexPaths(f.root, ["own"], entries, "index commit", git, "main", { publicationContext: f.context })
    assert.equal(result.ok, true, result.stderr)
    const receipt = publication.publicationReceiptOf({ context: f.context, commitResult: result })
    assert.equal(receipt.status, "qualified", JSON.stringify(receipt))
    assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), indexBefore)
    assert.equal(readFileSync(path.join(f.root, "own"), "utf8"), "later working draft\n")
    assert.equal(f.git("show", "HEAD:own"), "staged owned")
    const resource = result.effects?.private_resource
    if (resource?.custody === "unknown") {
      assert.equal(fs.existsSync(resource.path), true)
      assert.ok(resource.children.find((child) => child.name === "index").observations.length > 1)
      t.diagnostic(JSON.stringify({ retainedPrivateResource: resource,
        qualification: "Actual native index identity transitions preserved as uncertain custody; no independent transition ownership is claimed." }))
    }
  })

  for (const mode of ["nested", "pruned", "unexpected-path"]) {
    test(`configured ${mode} hook effects cannot mint a producer receipt or dispatch legacy publication`, async (t) => {
      const f = fixture(t)
      const hook = path.join(f.root, `.git/hooks/${mode === "unexpected-path" ? "pre-commit" : "post-commit"}`)
      const body = mode === "pruned" ? "git reflog expire --expire=all --all\n"
        : mode === "nested" ? `rm "$0"\nprintf nested > nested\ngit add nested\ngit commit -qm nested\n`
        : `printf unexpected > unexpected\ngit add unexpected\n`
      writeFileSync(hook, `#!/bin/sh\n${body}`, { mode: 0o700 })
      const result = await desk_save({ deskRoot: f.root, input: { files: [{ path: "saved.md", content: "saved\n" }], message: "save" },
        statusContext: { publicationContext: f.context, stateBranch: "main" }, schedulePush: () => assert.fail("Legacy root publication") })
      t.diagnostic(JSON.stringify({ result, head: f.git("rev-parse", "HEAD") }))
      assert.equal(result.status, "committed")
      assert.equal(result.publication.status, "unqualified")
      if (mode === "unexpected-path") assert.equal(result.publication.reason, "publication_producer_write_set_mismatch")
      assert.equal(f.git("show", "HEAD:saved.md"), "saved")
    })
  }

  test("foreign or cloned authority is refused before hosted save writes any file", async (t) => {
    const f = fixture(t)
    await assert.rejects(desk_save({ deskRoot: f.root, input: { files: [{ path: "refused.md", content: "no\n" }], message: "refused" },
      statusContext: { publicationContext: {}, stateBranch: "main" } }), { code: "publication_context_invalid" })
    assert.equal(f.git("status", "--porcelain"), "")
  })

test("a server producer context cannot mint publication from caller-supplied HEAD or JSON", (t) => {
  const f = fixture(t)
  const context = publication.createPublicationContext({ root: f.root, env: f.env, sessionId: "server-producer", requireCommitReceipt: true })
  assert.throws(() => publication.createPublicationIntent({ context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "caller" }),
    { code: "publication_commit_receipt_required" })
  assert.throws(() => publication.createPublicationIntent({ context, commitReceipt: { targetCommit: f.git("rev-parse", "HEAD") } }),
    { code: "publication_commit_receipt_required" })
})

test("a scoped helper refuses another member's exact path before any commit preparation", async (t) => {
  const f = fixture(t)
  mkdirSync(path.join(f.root, "desks/other"), { recursive: true })
  writeFileSync(path.join(f.root, "desks/other/private.md"), "foreign\n")
  f.git("add", "desks/other/private.md")
  const parent = f.git("rev-parse", "HEAD")
  const context = publication.createPublicationContext({ root: f.root, env: f.env, sessionId: "ari-scope", person: "ari" })
  await assert.rejects(commitPaths(f.root, ["desks/other/private.md"], "refused", spawnSync, "main", { publicationContext: context }),
    { code: "publication_write_set_invalid" })
  assert.equal(f.git("rev-parse", "HEAD"), parent)
})

for (const selection of ["./notes/new.md", "notes//.", "."]) {
  test(`participating save expands supported selection ${selection} into exact attributed paths`, async (t) => {
    const f = fixture(t)
    mkdirSync(path.join(f.root, "notes"))
    writeFileSync(path.join(f.root, "notes/new.md"), "new\n")
    const result = await desk_save({ deskRoot: f.root, input: { paths: [selection], message: "selected paths" },
      statusContext: { publicationContext: f.context, stateBranch: "main" }, schedulePush: () => assert.fail("Legacy fallback") })
    assert.equal(result.status, "committed", JSON.stringify(result))
    assert.ok(result.publication?.id, JSON.stringify(result))
    const final = await publication.flushPublication({ context: f.context, id: result.publication.id, timeoutMs: 60000 })
    assert.equal(final.state, "verified", JSON.stringify(final))
  })
}

test("hosted save rechecks authority after validation before opening or truncating the next file", async (t) => {
  const f = fixture(t)
  const originalMkdir = fs.promises.mkdir
  let changed = false
  fs.promises.mkdir = async (...args) => {
    const result = await originalMkdir(...args)
    if (!changed && String(args[0]) === f.root) { changed = true; f.git("checkout", "-qb", "substituted") }
    return result
  }
  try {
    await assert.rejects(desk_save({ deskRoot: f.root, input: { files: [{ path: "refused.md", content: "must not write\n" }], message: "refused" },
      statusContext: { publicationContext: f.context, stateBranch: "main" } }), { code: "publication_binding_changed" })
    assert.equal(fs.existsSync(path.join(f.root, "refused.md")), false)
  } finally { fs.promises.mkdir = originalMkdir }
})

test("an unborn Git desk qualifies an exact first commit without inventing parent authority", async (t) => {
  const f = fixture(t, { seeded: false })
  const result = await desk_save({ deskRoot: f.root, input: { files: [{ path: "first.md", content: "first\n" }], message: "initial" },
    statusContext: { publicationContext: f.context, stateBranch: "main" } })
  t.diagnostic(JSON.stringify({ result }))
  assert.equal(result.status, "committed", JSON.stringify(result))
  assert.ok(result.publication.id, JSON.stringify(result))
  assert.equal(f.git("rev-list", "--parents", "-n", "1", result.desk_commit), result.desk_commit)
})

test("hosted save retains applied paths when authority changes between files", async (t) => {
  const f = fixture(t)
  const originalOpen = fs.promises.open
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (String(args[0]).endsWith("first.md")) {
      const originalWrite = handle.writeFile.bind(handle)
      handle.writeFile = async (...values) => {
        const result = await originalWrite(...values)
        f.git("checkout", "-qb", "between-files")
        return result
      }
    }
    return handle
  }
  try {
    await assert.rejects(desk_save({ deskRoot: f.root, input: { files: [{ path: "first.md", content: "first\n" }, { path: "second.md", content: "second\n" }], message: "two files" },
      statusContext: { publicationContext: f.context, stateBranch: "main" } }), (error) =>
      error.code === "publication_binding_changed" && error.mutation.applied_paths.join() === "first.md")
    assert.equal(readFileSync(path.join(f.root, "first.md"), "utf8"), "first\n")
    assert.equal(fs.existsSync(path.join(f.root, "second.md")), false)
  } finally { fs.promises.open = originalOpen }
})

test("an admitted confirmed plain directory preserves non-Git save behavior without producer Git authority", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desk-plain-producer-"))
  const session = createDeskSession({
    args: { person: null }, env: { PATH: "/usr/bin:/bin", HOME: directory },
    deskStateDir: path.join(directory, "state"), readinessStateHome: path.join(directory, "readiness"),
    removeLeftovers: async () => {}, stderr: { write() {} }, watch: () => ({ close() {} }),
    resolveInputs: async () => ({ root: { root: directory, source: "explicit-root" }, activation: {
      stateBranch: null, readinessPolicy: { lexical: "required", semantic: "unsupported", write_authority: "workspace", authority_provider: null, root: "workspace" },
    } }),
    git: async ({ cwd, args }) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { env: { PATH: "/usr/bin:/bin", HOME: directory }, encoding: "utf8" })
      return { ...result, ok: result.status === 0, stdout: result.stdout.trim() }
    },
    loadRuntime: async () => ({ runtimeServer: { ...server,
      createSearchEngine: () => ({ warm() {}, async close() {}, noteChange() {}, searchStatus: () => ({ state: "ready" }) }),
    }, runtimeStatus: { state: "ready" } }),
  })

  t.after(() => session.dispose())
  await session.start()
  const answer = await session.callTool({ name: "desk_save", input: { files: [{ path: "plain.md", content: "plain\n" }], message: "plain save" } })
  const result = JSON.parse(answer.content[0].text)
  assert.equal(result.status, "nothing_to_commit", JSON.stringify(result))
  assert.equal(readFileSync(path.join(directory, "plain.md"), "utf8"), "plain\n")
  t.diagnostic(JSON.stringify({ retainedFixture: directory, result }))
})

test("an attributed nonzero native outcome keeps failure effects and publishes only its exact proved commit", async (t) => {
    const f = fixture(t)
    const bin = path.join(path.dirname(f.root), "bin")
    mkdirSync(bin)
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\n/usr/bin/git "$@"\nstatus=$?\nif [ "$3" = commit ] && [ "$status" = 0 ]; then exit 1; fi\nexit "$status"\n`, { mode: 0o700 })
    const context = publication.createPublicationContext({ root: f.root, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, sessionId: "nonzero-attributed" })
    const result = await desk_save({ deskRoot: f.root, input: { files: [{ path: "nonzero.md", content: "attributed\n" }], message: "nonzero" },
      statusContext: { publicationContext: context, stateBranch: "main" } })
    t.diagnostic(JSON.stringify({ result }))
    assert.equal(result.status, "failed")
    assert.equal(result.effects.status, "attributed")
    assert.equal(result.effects.command.status, 1)
    assert.ok(result.publication.id)
    const final = await publication.flushPublication({ context, id: result.publication.id, timeoutMs: 60000 })
    assert.equal(final.state, "verified", JSON.stringify(final))
  })

  test("known-closed private-index preparation failure removes only its exact temporary resource", async (t) => {
    const f = fixture(t)
    writeFileSync(path.join(f.root, "own"), "own\n"); f.git("add", "own")
    const entries = indexEntries(f.root, ["own"], (command, args, options) => spawnSync(command, args, { ...options, env: f.env }))
    const bin = path.join(path.dirname(f.root), "prep-bin"), marker = path.join(path.dirname(f.root), "private-index-path")
    mkdirSync(bin)
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$3" = read-tree ]; then printf '%s' "$GIT_INDEX_FILE" > '${marker}'; exit 17; fi\nexec /usr/bin/git "$@"\n`, { mode: 0o700 })
    const context = publication.createPublicationContext({ root: f.root, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, sessionId: "prep-failed" })
    const before = f.git("rev-parse", "HEAD")
    await assert.rejects(commitIndexPaths(f.root, ["own"], entries, "must not commit", spawnSync, "main", { publicationContext: context }),
      (error) => ["publication_index_preparation_failed", "publication_producer_readback_failed"].includes(error.code))
    const temporary = path.dirname(readFileSync(marker, "utf8"))
    assert.equal(fs.existsSync(temporary), false)
    assert.equal(f.git("rev-parse", "HEAD"), before)
    t.diagnostic(JSON.stringify({ exactRemovedTemporary: temporary }))
  })

test("private input preparation failure removes its exact resource before a new writer dispatch", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, "own"), "own\n"); f.git("add", "own")
  const entries = indexEntries(f.root, ["own"], (command, args, options) => spawnSync(command, args, { ...options, env: f.env }))
  const originalWrite = fs.writeFileSync
  let temporary
  fs.writeFileSync = (file, ...args) => {
    if (String(file).endsWith("/entries") && String(file).includes("desk-publication-index-")) {
      temporary = path.dirname(file)
      throw Object.assign(new Error("Owned fixture input denied"), { code: "EACCES" })
    }
    return originalWrite(file, ...args)
  }
  const { syncBuiltinESMExports } = await import("node:module")
  syncBuiltinESMExports()
  try {
    await assert.rejects(commitIndexPaths(f.root, ["own"], entries, "no update writer", spawnSync, "main", { publicationContext: f.context }),
      { code: "EACCES" })
    assert.ok(temporary)
    assert.equal(fs.existsSync(temporary), false)
  } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports() }
})

for (const boundary of ["initial-resource", "ready-resource", "result-resource", "persistent-ready", "preparation-ready"]) {
  test(`producer persistence refusal at ${boundary} returns settled effects instead of escaping native callbacks`, async (t) => {
    const f = fixture(t)
    writeFileSync(path.join(f.root, "owned"), "owned\n"); f.git("add", "owned")
    const entries = boundary === "preparation-ready" ? indexEntries(f.root, ["owned"],
      (command, args, options) => spawnSync(command, args, { ...options, env: f.env })) : null
    const originalWrite = fs.writeFileSync
    let injected = false
    fs.writeFileSync = (file, content, ...args) => {
      if ((typeof file === "number" || String(file).includes("/producer-")) && String(content).startsWith('{"version":1,"operationId":')) {
        const record = JSON.parse(String(content))
        const resource = record.resources
        const matches = boundary === "initial-resource" ? resource?.childPid && !resource.start
          : ["ready-resource", "persistent-ready", "preparation-ready"].includes(boundary) ? resource?.phase === "accepted"
          : resource?.resultReceived === true && !resource.childrenClosed
        if ((!injected && matches) || (injected && boundary === "persistent-ready")) { injected = true; throw Object.assign(new Error("Owned journal denied"), { code: "EACCES" }) }
      }
      return originalWrite(file, content, ...args)
    }
    const { syncBuiltinESMExports } = await import("node:module")
    syncBuiltinESMExports()
    try {
      if (entries) {
        await assert.rejects(commitIndexPaths(f.root, ["owned"], entries, "prep journal refusal", spawnSync, "main", { publicationContext: f.context }),
          (error) => error.code === "publication_producer_journal_failed" && error.mutation.resources.childrenClosed &&
            error.mutation.persistence_error.code === "EACCES" && error.mutation.commitDispatched === false)
        assert.equal(f.git("rev-list", "--count", "HEAD"), "1")
        return
      }
      const result = await commitPaths(f.root, ["owned"], "journal refusal", spawnSync, "main", { publicationContext: f.context })
      assert.equal(injected, true)
      assert.equal(result.ok, false)
      assert.equal(result.effects.command.resources.childrenClosed, true)
      assert.equal(result.effects.persistence_error.code, "EACCES")
      assert.equal(f.git("rev-list", "--count", "HEAD"), "2")
      assert.equal(publication.publicationReceiptOf({ context: f.context, commitResult: result }).status, "qualified")
      t.diagnostic(JSON.stringify({ result }))
    } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports() }
  })
}

for (const failure of ["qualified", "preparation"]) {
  test(`private-index cleanup refusal preserves the ${failure} primary outcome and exact retained resource`, async (t) => {
    const f = fixture(t)
    writeFileSync(path.join(f.root, "owned"), "owned\n"); f.git("add", "owned")
    const entries = indexEntries(f.root, ["owned"], (command, args, options) => spawnSync(command, args, { ...options, env: f.env }))
    let context = f.context
    if (failure === "preparation") {
      const bin = path.join(path.dirname(f.root), "cleanup-prep-bin"); mkdirSync(bin)
      writeFileSync(path.join(bin, "git"), '#!/bin/sh\nif [ "$3" = read-tree ]; then exit 17; fi\nexec /usr/bin/git "$@"\n', { mode: 0o700 })
      context = publication.createPublicationContext({ root: f.root, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, sessionId: "cleanup-prep" })
    }

    const originalRemove = fs.rmdirSync
    const originalStat = fs.lstatSync
    let stable
    if (failure === "qualified") fs.lstatSync = (file, ...args) => {
      const result = originalStat(file, ...args)
      if (result && String(file).includes("desk-publication-index-") && String(file).endsWith("/index")) {
        stable ??= { dev: result.dev, ino: result.ino, mode: result.mode }
        return Object.assign(Object.create(Object.getPrototypeOf(result)), result, stable)
      }
      return result
    }
    let retained
    fs.rmdirSync = (file, ...args) => {
      if (String(file).includes("desk-publication-index-")) { retained = file; throw Object.assign(new Error("Owned cleanup denied"), { code: "EACCES" }) }
      return originalRemove(file, ...args)
    }
    const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports()
    try {
      if (failure === "qualified") {
        const result = await commitIndexPaths(f.root, ["owned"], entries, "cleanup refusal", spawnSync, "main", { publicationContext: context })
        assert.equal(result.ok, true)
        assert.equal(result.effects.cleanup_error.code, "EACCES")
        assert.equal(result.effects.retained_resource, retained)
        assert.equal(result.effects.private_resource.cleanup_steps.at(-1).operation, "rmdir")
        assert.equal(result.effects.private_resource.cleanup_steps.at(-1).state, "unknown")
        assert.ok(result.effects.private_resource.cleanup_steps.some((step) => step.operation === "unlink" && step.state === "removed"))
        assert.equal(publication.publicationReceiptOf({ context, commitResult: result }).status, "qualified")
      } else {
        await assert.rejects(commitIndexPaths(f.root, ["owned"], entries, "prep refusal", spawnSync, "main", { publicationContext: context }),
          (error) => error.code === "publication_index_preparation_failed" && error.mutation.cleanup_error.code === "EACCES" &&
            error.mutation.retained_resource === retained)
      }
      assert.equal(fs.existsSync(retained), true)
      t.diagnostic(JSON.stringify({ exactRetainedResource: retained,
        qualification: failure === "qualified" ? "Virtual stable index identity isolates cleanup-refusal effect mapping; real native index transitions remain retained, not independently attested." : "Actual known-closed preparation failure" }))
    } finally { fs.rmdirSync = originalRemove; fs.lstatSync = originalStat; syncBuiltinESMExports() }
  })
}

test("initial preparation journal refusal prevents every native preparation admission", async (t) => {
      const f = fixture(t)
      writeFileSync(path.join(f.root, "owned"), "owned\n"); f.git("add", "owned")
      const entries = indexEntries(f.root, ["owned"], (command, args, options) => spawnSync(command, args, { ...options, env: f.env }))
      const originalWrite = fs.writeFileSync
      let denied = false
      fs.writeFileSync = (file, content, ...args) => {
        if ((typeof file === "number" || String(file).includes("/producer-")) && String(content).startsWith('{"version":1,"operationId":')) {
          const record = JSON.parse(String(content))
          if (record.state === "preparing") { denied = true; throw Object.assign(new Error("Initial journal denied"), { code: "EACCES" }) }
        }
        return originalWrite(file, content, ...args)
      }
      const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports()
      try {
        await assert.rejects(commitIndexPaths(f.root, ["owned"], entries, "never prepare", spawnSync, "main", { publicationContext: f.context }),
          (error) => error.code === "publication_producer_journal_failed" &&
            error.mutation.preparations.length === 0 && error.mutation.resources.childPid === undefined)
        assert.equal(denied, true)
      } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports() }
    })

    test("persistent producer rename refusal creates no secondary temporaries and preserves filesystem paths", async (t) => {
      const f = fixture(t)
      writeFileSync(path.join(f.root, "owned"), "owned\n"); f.git("add", "owned")
      const originalRename = fs.renameSync
      let attempts = 0, failedSource, failedDestination
      fs.renameSync = (source, destination) => {
        if (String(destination).includes("/producer-")) {
          attempts += 1; failedSource = source; failedDestination = destination
          throw Object.assign(new Error("Rename denied"), { code: "EACCES", path: source, dest: destination, syscall: "rename" })
        }
        return originalRename(source, destination)
      }
      const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports()
      try {
        await assert.rejects(commitPaths(f.root, ["owned"], "rename refusal", spawnSync, "main", { publicationContext: f.context }),
          (error) => error.mutation.persistence_error.path === failedSource &&
            error.mutation.persistence_error.dest === failedDestination &&
            error.mutation.persistence_error.journalPath === failedDestination)
        assert.equal(attempts, 1)
        assert.equal(fs.existsSync(failedSource), false)
      } finally { fs.renameSync = originalRename; syncBuiltinESMExports() }
    })

    test("settled preparation failure remains primary when its ready journal also fails", async (t) => {
      const f = fixture(t)
      writeFileSync(path.join(f.root, "owned"), "owned\n"); f.git("add", "owned")
      const entries = indexEntries(f.root, ["owned"], (command, args, options) => spawnSync(command, args, { ...options, env: f.env }))
      const bin = path.join(path.dirname(f.root), "dual-prep-bin"); mkdirSync(bin)
      writeFileSync(path.join(bin, "git"), '#!/bin/sh\nif [ "$3" = read-tree ]; then exit 17; fi\nexec /usr/bin/git "$@"\n', { mode: 0o700 })
      const context = publication.createPublicationContext({ root: f.root, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, sessionId: "dual-prep" })
      const originalWrite = fs.writeFileSync
      fs.writeFileSync = (file, content, ...args) => {
        if ((typeof file === "number" || String(file).includes("/producer-")) && String(content).startsWith('{"version":1,"operationId":') &&
          JSON.parse(String(content)).resources?.phase === "accepted") throw Object.assign(new Error("Ready journal denied"), { code: "EACCES" })
        return originalWrite(file, content, ...args)
      }
      const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports()
      try {
        await assert.rejects(commitIndexPaths(f.root, ["owned"], entries, "dual failure", spawnSync, "main", { publicationContext: context }),
          (error) => error.code === "publication_index_preparation_failed" &&
            error.mutation.preparations[0].status === 17 && error.mutation.resources.childrenClosed &&
            error.mutation.persistence_error.code === "EACCES")
      } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports() }
    })

test("producer rename and temporary cleanup refusal retains one exact closed journal file", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, "owned"), "owned\n"); f.git("add", "owned")
  const rename = fs.renameSync, unlink = fs.unlinkSync
  let retained, attempts = 0
  fs.renameSync = (source, destination) => {
    if (String(destination).includes("/producer-")) {
      retained = source; attempts += 1
      throw Object.assign(new Error("Rename denied"), { code: "EACCES", path: source, dest: destination })
    }
    return rename(source, destination)
  }
  fs.unlinkSync = (file) => {
    if (file === retained) throw Object.assign(new Error("Temporary cleanup denied"), { code: "EACCES", path: file })
    return unlink(file)
  }
  const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports()
  try {
    await assert.rejects(commitPaths(f.root, ["owned"], "retained temp", spawnSync, "main", { publicationContext: f.context }),
      (error) => error.mutation.persistence_error.retained_resource === retained &&
        error.mutation.persistence_error.cleanup_error.code === "EACCES")
    assert.equal(attempts, 1)
    assert.equal(fs.existsSync(retained), true)
    t.diagnostic(JSON.stringify({ exactRetainedJournalTemporary: retained }))
  } finally { fs.renameSync = rename; fs.unlinkSync = unlink; syncBuiltinESMExports() }
})

for (const mode of ["close", "write-close", "replacement", "missing"]) {
  test(`journal ${mode} preserves descriptor and current-path custody before rename or cleanup`, async (t) => {
    const f = fixture(t)
    writeFileSync(path.join(f.root, "owned"), "owned\n"); f.git("add", "owned")
    const originalOpen = fs.openSync, originalClose = fs.closeSync, originalWrite = fs.writeFileSync
    let descriptor, temporary, displaced, injected = false
    fs.openSync = (file, ...args) => {
      const fd = originalOpen(file, ...args)
      if (String(file).includes("/producer-") && String(file).endsWith(".tmp")) { descriptor = fd; temporary = file }
      return fd
    }
    fs.writeFileSync = (file, ...args) => {
      if (file === descriptor && mode === "write-close") throw Object.assign(new Error("Write full"), { code: "ENOSPC", syscall: "write" })
      return originalWrite(file, ...args)
    }
    fs.closeSync = (fd) => {
      originalClose(fd)
      if (fd === descriptor && !injected) {
        injected = true
        if (mode === "close" || mode === "write-close") throw Object.assign(new Error("Close uncertain"), { code: "EIO", syscall: "close" })
        displaced = `${temporary}.displaced`
        fs.renameSync(temporary, displaced)
        if (mode === "replacement") originalWrite(temporary, "FOREIGN\n")
      }
    }
    const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports()
    try {
      await assert.rejects(commitPaths(f.root, ["owned"], "journal custody", spawnSync, "main", { publicationContext: f.context }),
        (error) => {
          const proof = error.mutation.persistence_error
          if (mode === "close" || mode === "write-close") return proof.code === (mode === "write-close" ? "ENOSPC" : "EIO") &&
            proof.descriptor_custody === "unknown" && proof.retained_resource === temporary && proof.close_error.code === "EIO"
          return proof.retained_resource === temporary && proof.path_custody === "unknown"
        })
      if (mode === "replacement") assert.equal(readFileSync(temporary, "utf8"), "FOREIGN\n")
      if (mode === "close" || mode === "write-close") assert.equal(fs.existsSync(temporary), true)
      t.diagnostic(JSON.stringify({ retainedJournalPath: temporary, displaced,
        qualification: "Close fault injected after actual test close; product must treat API closure as unknown. Replacement is controlled filesystem interleaving, not a native race." }))
    } finally { fs.openSync = originalOpen; fs.closeSync = originalClose; fs.writeFileSync = originalWrite; syncBuiltinESMExports() }
  })
}

for (const mode of ["replacement-directory", "foreign-child"]) {
      test(`tidy publication retains ${mode} instead of deleting unattributed private resources`, async (t) => {
        const f = fixture(t)
        writeFileSync(path.join(f.root, "owned.md"), "owned\n"); f.git("add", "owned.md")
        const originalWrite = fs.writeFileSync
        let temporary, displaced, injected = false
        fs.writeFileSync = (file, content, ...args) => {
          if (!injected && typeof file === "number" && String(content).startsWith('{"version":1,"operationId":')) {
            const record = JSON.parse(String(content))
            if (record.state === "qualified") {
              temporary = record.temporary ?? record.private_resource?.path ?? temporary
              if (!temporary) {
                const input = record.preparations?.at(-1)?.resources
                // The old record drops its path, so capture it from the fixture-only allocation below.
                assert.ok(input)
              }

              injected = true
              if (mode === "replacement-directory") {
                displaced = `${temporary}.displaced`
                fs.renameSync(temporary, displaced)
                mkdirSync(temporary)
              }
              originalWrite(path.join(temporary, "foreign"), "FOREIGN\n")
            }
          }
          return originalWrite(file, content, ...args)
        }
        const originalTemp = fs.mkdtempSync
        fs.mkdtempSync = (...args) => {
          const result = originalTemp(...args)
          if (String(args[0]).includes("desk-publication-index-")) temporary = result
          return result
        }
        const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports()
        try {
          const result = await desk_save({ deskRoot: f.root, input: { paths: ["owned.md"], message: "tidy custody", tidy: true },
            statusContext: { publicationContext: f.context, stateBranch: "main" } })
          assert.equal(injected, true)
          assert.equal(result.status, "committed", JSON.stringify(result))
          assert.ok(result.publication?.id)
          assert.equal(readFileSync(path.join(temporary, "foreign"), "utf8"), "FOREIGN\n")
          const serialized = JSON.parse(JSON.stringify(result))
          assert.equal(serialized.effects.private_resource.path, temporary)
          assert.equal(serialized.effects.private_resource.custody, "unknown")
          assert.ok(serialized.effects.cleanup_error || serialized.effects.private_resource.observation_error)
          const sync = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills/desk/sync")
          const journalDirectory = path.join(sync, fs.readdirSync(sync).find((name) => name.endsWith(".publication")))
          const journal = JSON.parse(readFileSync(path.join(journalDirectory,
            fs.readdirSync(journalDirectory).find((name) => name.startsWith("producer-"))), "utf8"))
          assert.equal(journal.private_resource.path, temporary)
          assert.equal(journal.private_resource.custody, "unknown")
          assert.ok(journal.cleanup_error || journal.private_resource.observation_error)
          const final = await publication.flushPublication({ context: f.context, id: result.publication.id, timeoutMs: 60000 })
          assert.equal(final.state, "verified", JSON.stringify(final))
          t.diagnostic(JSON.stringify({ result: serialized, retainedPrivateDirectory: temporary, displaced,
            qualification: "Controlled post-settlement filesystem replacement/insertion, not a native concurrent-writer race." }))
        } finally {
          fs.writeFileSync = originalWrite; fs.mkdtempSync = originalTemp; syncBuiltinESMExports()
        }
      })
    }

test("unreadable new private-directory identity retains its exact path without cleanup or dispatch", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, "owned.md"), "owned\n"); f.git("add", "owned.md")
  const entries = indexEntries(f.root, ["owned.md"], (command, args, options) => spawnSync(command, args, { ...options, env: f.env }))
  const originalStat = fs.lstatSync
  let temporary
  fs.lstatSync = (file, ...args) => {
    if (String(file).includes("desk-publication-index-")) {
      temporary = file
      throw Object.assign(new Error("Private directory identity unavailable"), { code: "EACCES" })
    }
    return originalStat(file, ...args)
  }
  const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports()
  try {
    await assert.rejects(commitIndexPaths(f.root, ["owned.md"], entries, "identity unavailable", spawnSync, "main", { publicationContext: f.context }),
      (error) => error.code === "EACCES" && error.mutation.private_resource.path === temporary &&
        error.mutation.private_resource.custody === "unknown" && error.mutation.commitDispatched === false)
    assert.equal(fs.existsSync(temporary), true)
    t.diagnostic(JSON.stringify({ retainedPrivateDirectory: temporary }))
  } finally { fs.lstatSync = originalStat; syncBuiltinESMExports() }
})

test("unknown private-index commit closure survives tidy-save serialization with its exact location", async (t) => {
  if (!process.env.DESK_PRODUCER_REVIEW_ROOT?.includes("v6-private")) {
    t.skip("Linked source control injects virtual unknown closure after real owned commit settlement")
    return
  }
  const f = fixture(t)
  writeFileSync(path.join(f.root, "owned.md"), "owned\n"); f.git("add", "owned.md")
  const result = await desk_save({ deskRoot: f.root, input: { paths: ["owned.md"], message: "unknown custody", tidy: true },
    statusContext: { publicationContext: f.context, stateBranch: "main" } })
  const serialized = JSON.parse(JSON.stringify(result))
  t.diagnostic(JSON.stringify({ result: serialized, qualifier: "Injected UNKNOWN result mapping after actual native settlement; not native closure failure." }))
  assert.equal(serialized.status, "failed")
  const resource = serialized.commit.effects.private_resource
  assert.ok(resource.path)
  assert.ok(resource.identity)
  assert.equal(resource.custody, "unknown")
  assert.equal(fs.existsSync(resource.path), true)
  const sync = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills/desk/sync")
  const directory = path.join(sync, fs.readdirSync(sync).find((name) => name.endsWith(".publication")))
  const journal = JSON.parse(readFileSync(path.join(directory, fs.readdirSync(directory).find((name) => name.startsWith("producer-"))), "utf8"))
  assert.equal(journal.private_resource.path, resource.path)
  assert.deepEqual(journal.private_resource.identity, resource.identity)
  assert.equal(journal.private_resource.custody, "unknown")
  assert.equal(journal.command.status, 0)
  assert.equal(journal.resources.childrenClosed, false)
})

test("a private index replacement before post-commit capture never acquires cleanup ownership", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, "owned.md"), "owned\n"); f.git("add", "owned.md")
  const originalStat = fs.lstatSync
  let replaced = false, indexPath, captures = 0
  fs.lstatSync = (file, ...args) => {
    if (!replaced && String(file).endsWith("/index") && String(file).includes("desk-publication-index-") &&
      ++captures === 3) {
      indexPath = file
      fs.renameSync(file, `${file}.displaced`)
      writeFileSync(file, "FOREIGN INDEX\n")
      replaced = true
    }
    return originalStat(file, ...args)
  }
  const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports()
  try {
    const result = await desk_save({ deskRoot: f.root, input: { paths: ["owned.md"], tidy: true, message: "capture replacement" },
      statusContext: { publicationContext: f.context, stateBranch: "main" } })
    assert.equal(result.status, "committed", JSON.stringify(result))
    assert.equal(replaced, true)
    assert.equal(readFileSync(indexPath, "utf8"), "FOREIGN INDEX\n")
    t.diagnostic(JSON.stringify({ result, indexPath }))
    assert.equal(result.effects.private_resource.custody, "unknown")
    assert.ok(result.effects.private_resource.children.find((child) => child.name === "index").observations.length > 1)
  } finally { fs.lstatSync = originalStat; syncBuiltinESMExports() }
})

test("partial private cleanup reports confirmed removal and the uncertain next step without losing receipt", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, "owned.md"), "owned\n"); f.git("add", "owned.md")
  const unlink = fs.unlinkSync
  const stat = fs.lstatSync
  let stable
  fs.lstatSync = (file, ...args) => {
    const result = stat(file, ...args)
    if (result && String(file).includes("desk-publication-index-") && String(file).endsWith("/index")) {
      stable ??= { dev: result.dev, ino: result.ino, mode: result.mode }
      return Object.assign(Object.create(Object.getPrototypeOf(result)), result, stable)
    }
    return result
  }
  let refused
  fs.unlinkSync = (file) => {
    if (String(file).includes("desk-publication-index-") && String(file).endsWith("/entries")) {
      refused = file
      throw Object.assign(new Error("Child removal denied"), { code: "EACCES", path: file })
    }
    return unlink(file)
  }
  const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports()
  try {
    const result = await desk_save({ deskRoot: f.root, input: { paths: ["owned.md"], tidy: true, message: "partial cleanup" },
      statusContext: { publicationContext: f.context, stateBranch: "main" } })
    assert.equal(result.status, "committed", JSON.stringify(result))
    const resource = result.effects.private_resource
    t.diagnostic(JSON.stringify({ result, refused }))
    assert.ok(resource.cleanup_steps.some((step) => step.path.endsWith("/index") && step.state === "removed"))
    assert.equal(resource.cleanup_steps.at(-1).path, refused)
    assert.equal(resource.cleanup_steps.at(-1).state, "unknown")
    assert.equal(fs.existsSync(refused), true)
    assert.ok(result.publication.id)
    t.diagnostic(JSON.stringify({ qualification: "Virtual stable private-index identity isolates partial-cleanup state mapping; native identity-transition attestation remains unqualified.", result }))
  } finally { fs.unlinkSync = unlink; fs.lstatSync = stat; syncBuiltinESMExports() }
})

test("private cleanup preserves the original caller-action refusal in the latest journal", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, "owned.md"), "owned\n"); f.git("add", "owned.md")
  const context = publication.createPublicationContext({ root: f.root, env: { ...f.env, GIT_REFLOG_ACTION: "preserve action" }, sessionId: "refusal-history" })
  const result = await desk_save({ deskRoot: f.root, input: { paths: ["owned.md"], tidy: true, message: "refusal history" },
    statusContext: { publicationContext: context, stateBranch: "main" } })
  assert.equal(result.publication.reason, "publication_caller_reflog_action_preserved")
  const sync = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills/desk/sync")
  const directory = path.join(sync, fs.readdirSync(sync).find((name) => name.endsWith(".publication")))
  const file = fs.readdirSync(directory).find((name) => name.startsWith("producer-") && name.endsWith(".json"))
  const journal = JSON.parse(readFileSync(path.join(directory, file), "utf8"))
  assert.equal(journal.reason, result.publication.reason)
})
