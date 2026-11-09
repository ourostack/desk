// Actual current admission/worker expressions with virtual Git/metadata; no Git or native subprocess.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import path from "node:path"
const source = readFileSync(new URL("../../../../../plugins/desk/mcp/src/runtime/recovery-state.js", import.meta.url), "utf8")
const bindingText = source.slice(source.indexOf("export function recoveryBinding("), source.indexOf("\nfunction publicOperation(")).replace(/^export /, "")
function fixture({ markers = {}, paths = {}, branch = "refs/heads/main", noRemote = false, noUpstream = false,
  deadline = 1000, mutate, clock = () => 0 } = {}) {
  const calls = [], metadata = []
  const stat = { dev: 1n, ino: 2n, mode: 0o40700n, isDirectory: () => true, isSymbolicLink: () => false }
  const fail = code => Object.assign(new Error(code), { code })
  const resolve = file => {
    metadata.push(["realpath", file]); mutate?.("realpath", file, stat)
    if (file === "/repo") return file
    return file
  }
  const fn = vm.runInNewContext(`(${bindingText})`, { path, Date: { now: clock }, realpathSync: resolve,
    lstatSync(file) {
      metadata.push(["lstat", file]); mutate?.("lstat", file, stat)
      if (file === "/admin/own") return stat
      const state = markers[path.basename(file)] ?? "absent"
      if (state === "absent") throw fail("ENOENT")
      if (state instanceof Error) throw state
      return { dev: 1n, ino: 3n, mode: state === "directory" ? 0o40700n : 0o100600n,
        isDirectory: () => state === "directory", isSymbolicLink: () => state === "symlink" }
    },
    statSync: () => stat, digest: () => "digest", localProof: () => ({ resolution: "model" }),
    fileProof: () => ({ absent: true }),
    local(root, env, args, options) {
      calls.push({ args, deadline: options.deadline }); mutate?.("git", args, stat)
      if (args.includes("--show-toplevel")) return "/repo\n/admin/own\n/admin/common"
      if (args.includes("symbolic-ref")) { if (branch === "detached") throw fail("git_inspection_failed"); return branch }
      if (args.includes("--git-path")) {
        const name = args.at(-1)
        return paths[name] ?? `/admin/own/${name}`
      }
      if (args[0] === "config") return noRemote ? "" : noUpstream ? "remote.origin.url\n/local/upstream\0"
        : "branch.main.remote\norigin\0branch.main.merge\nrefs/heads/main\0remote.origin.url\n/local/upstream\0"
      if (args[0] === "remote") return "/local/upstream"
      throw fail("unexpected_virtual_Git")
    },
  })
  return { run: () => fn("/repo", {}, { deadline }), calls, metadata }
}
for (const branch of ["refs/heads/main", "detached"]) {
  test(`existing rebase directory is explicit unresolved admission before branch probe: ${branch}`, () => {
    const f = fixture({ branch, markers: { "rebase-merge": "directory" } })
    assert.throws(f.run, { code: "rebase_in_progress" })
    assert.equal(f.calls.some(row => row.args[0] === "symbolic-ref"), false)
  })
}
test("repeated admission never consumes or clears the original operation", () => {
  const f = fixture({ markers: { "rebase-apply": "directory" } })
  for (let i = 0; i < 2; i++) assert.throws(f.run, { code: "rebase_in_progress" })
  assert.equal(f.calls.some(row => ["fetch", "pull", "rebase", "stash", "push"].includes(row.args[0])), false)
})
for (const state of ["file", "symlink", "fifo", Object.assign(new Error("EACCES"), { code: "EACCES" }),
  Object.assign(new Error("ELOOP"), { code: "ELOOP" }), Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" })]) {
  test(`unknown marker type/read dominates another present marker: ${String(state)}`, () => {
    const f = fixture({ markers: { "rebase-merge": "directory", "rebase-apply": state } })
    assert.throws(f.run, { code: "sync_operation_unverified" })
    assert.equal(f.calls.filter(row => row.args.includes("rebase-merge") || row.args.includes("rebase-apply")).length, 2)
  })
}
for (const bad of ["relative/rebase-merge", "/admin/common/rebase-merge", "/admin/sibling/rebase-merge",
  "/admin/own-lookalike/rebase-merge", "/admin/own/other-name", ""]) {
  test(`guard refuses invalid or non-own worktree admin path: ${bad}`, () => {
    const f = fixture({ paths: { "rebase-merge": bad } })
    assert.throws(f.run, { code: "sync_operation_unverified" })
  })
}
for (const config of [{ noRemote: true }, { noUpstream: true }, {}]) {
  test(`two absent markers preserve the actual current binding path: ${JSON.stringify(config)}`, () => {
    const f = fixture(config), result = f.run()
    assert.equal(result.nothingToSync, config.noRemote ? "no_remote" : config.noUpstream ? "no_upstream" : undefined)
    const markers = f.calls.filter(row => row.args.includes("rebase-merge") || row.args.includes("rebase-apply"))
    assert.equal(markers.length, 2); assert.equal(markers.every(row => row.deadline === 1000), true)
  })
}
test("canonical parent identity rebind refuses rather than trusting a matching spelling", () => {
  let count = 0
  const f = fixture({ mutate(kind, file, stat) {
    if (kind === "lstat" && file === "/admin/own" && ++count === 2) stat.ino = 99n
  } })
  assert.throws(f.run, { code: "sync_operation_unverified" })
})
test("expiry during resolution dispatches no next marker probe or source work", () => {
  let now = 0
  const f = fixture({ clock: () => now, mutate(kind, args) {
    if (kind === "git" && args.includes("rebase-merge")) now = 1000
  } })
  assert.throws(f.run, { code: "sync_operation_unverified" })
  assert.equal(f.calls.some(row => row.args.includes("rebase-apply")), false)
})
test("expiry during second marker resolution cannot admit no-upstream", () => {
  let now = 0
  const f = fixture({ noUpstream: true, clock: () => now, mutate(kind, args) {
    if (kind === "git" && args.includes("rebase-apply")) now = 1000
  } })
  assert.throws(f.run, { code: "sync_operation_unverified" })
  assert.equal(f.calls.some(row => row.args[0] === "symbolic-ref"), false)
})
test("marker path is lstat-only and never realpathed or read for contents", () => {
  const f = fixture({ markers: { "rebase-merge": "directory" } })
  assert.throws(f.run, { code: "rebase_in_progress" })
  assert.equal(f.metadata.some(([kind, file]) => kind === "realpath" && /rebase-(merge|apply)$/.test(file)), false)
})
test("expired original deadline and missing finite lease never dispatch guard Git", () => {
  for (const deadline of [0, Infinity]) {
    const f = fixture({ deadline })
    assert.throws(f.run, { code: "sync_operation_unverified" })
    assert.equal(f.calls.some(row => row.args.includes("rebase-merge") || row.args.includes("rebase-apply")), false)
  }
})
async function worker(reason, bootChecks = true, taskOnly = false, duringMatching = false) {
  const begin = source.indexOf("export async function runRecoveryWorker("), end = source.indexOf("\nfunction ownedCommand(", begin)
  const text = source.slice(begin, end).replace(/^export /, "").replaceAll("import.meta.url", JSON.stringify("file:///model/recovery-state.js"))
  let record = { version: 1, id: "model", dispatch: { pid: 7 }, rootIdentity: "root", lifetimeMs: 1000,
    state: "starting", binding: null, bootChecks, taskOnly,
    incoming: { state: "not_dispatched" }, outgoing: { state: "not_dispatched" },
    source: { state: "not_checked" }, resources: { childrenClosed: true } }
  let childCalls = 0, lockCalls = 0, bindings = 0
  const fn = vm.runInNewContext(`(${text})`, { path, Date, URL, process: { pid: 7 }, settlementOwnerStart: null,
    directory: () => "/state", read: file => file.endsWith("active.json") ? { id: "model" } : record,
    validRecord: () => true, pause: () => {}, rootIdentity: () => "root", readProcessStart: async () => "model-start",
    recoveryBinding: () => {
      if (duringMatching && bindings++ === 0) return { fetch: "/local/upstream", push: "/local/upstream",
        merge: "refs/heads/main", key: "model", referenceHook: { qualified: true } }
      throw Object.assign(new Error(reason), { code: reason })
    },
    local: (root, env, args) => { if (duringMatching && args[0] === "rev-parse" && args[1] === "HEAD") return "model-head"
      throw new Error("unexpected local mutation") },
    save: (file, value) => { if (file.endsWith("/model.json")) record = value }, unlinkSync: () => {},
    fileURLToPath: url => url.pathname,
    ownedCommand: async () => { childCalls++; throw new Error("unexpected boot/migration subprocess") },
  })
  await fn({ root: "/repo", env: {}, id: "model", acquireLock: async () => {
    lockCalls++; if (duringMatching) return { release() {} }
    throw new Error("unexpected sync lock")
  } })
  return { record, childCalls, lockCalls }
}
for (const reason of ["rebase_in_progress", "sync_operation_unverified"]) {
  for (const taskOnly of [false, true]) {
    test(`actual current worker records refusal with no boot/migration/fetch dispatch: ${reason}/${taskOnly}`, async () => {
      const result = await worker(reason, true, taskOnly)
      assert.equal(result.childCalls, 0); assert.equal(result.lockCalls, 0)
      assert.equal(result.record.state, "blocked"); assert.equal(result.record.reason, reason)
      assert.equal(result.record.incoming.state, "not_dispatched")
      assert.equal(result.record.outgoing.state, "not_dispatched"); assert.equal(result.record.source.state, "not_checked")
      assert.equal(result.record.finalized, true)
    })
  }
  test(`matching recheck refusal still dispatches no fetch or background boot: ${reason}`, async () => {
    const result = await worker(reason, true, true, true)
    assert.equal(result.childCalls, 0)
    assert.equal(result.record.state, "blocked"); assert.equal(result.record.reason, reason)
    assert.equal(result.record.incoming.state, "not_dispatched"); assert.equal(result.record.outgoing.state, "not_dispatched")
    assert.equal(result.record.source.state, "not_applied")
    assert.equal(result.record.finalized, true)
  })
}
