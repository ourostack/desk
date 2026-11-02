import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { removeTree } from "../_remove_tree.js"

const repo = fileURLToPath(new URL("../../../../../", import.meta.url))
const require = createRequire(import.meta.url)
const compat = require(path.join(repo, "scripts/superpowers-hook-compat.cjs"))
const { updateSource, inspectSource, formatLock, compactSources } = require(path.join(repo, "scripts/check-upstream-sources.cjs"))
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")

test("the actual vendored run-hook.cmd has no heredoc and preserves distinct upstream evidence", () => {
  const lock = JSON.parse(readFileSync(path.join(repo, "upstream-sources.lock.json")))
  const source = lock.sources.find((source) => source.id === "obra-superpowers")
  const file = source.files.find((file) => file.sourcePath === "hooks/run-hook.cmd")
  assert.equal(file.generatedPath, "plugins/superpowers/hooks/run-hook.cmd")
  assert.equal(file.upstreamPath, "plugins/superpowers/hooks/upstream/run-hook.cmd")
  const raw = readFileSync(path.join(repo, file.upstreamPath))
  const actual = readFileSync(path.join(repo, file.generatedPath), "utf8")
  assert.equal(hash(raw), file.sha256)
  assert.doesNotMatch(actual, /<<\s*['"]?CMDBLOCK/u)
  assert.equal(actual, compat.transform(raw).cmd)
  const declaration = JSON.parse(readFileSync(path.join(repo, "plugins/superpowers/hooks/copilot-hooks.json")))
  assert.equal(declaration.hooks.sessionStart[0].bash, 'bash "${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start')
  assert.equal(declaration.hooks.sessionStart[0].powershell, '& "${PLUGIN_ROOT}\\hooks\\run-hook.cmd" session-start')
  const provenance = compat.verify({ root: repo })
  assert.equal(provenance.source.path, file.upstreamPath)
  assert.equal(provenance.outputs[0].path, file.generatedPath)
  assert.equal(hash(Buffer.from(actual)), provenance.outputs[0].sha256)
  const text = readFileSync(path.join(repo, "upstream-sources.lock.json"), "utf8")
  assert.equal(formatLock(lock, compactSources(text, lock)), text)
  const inspected = inspectSource(source, {
    repository: () => ({ full_name: source.repository, default_branch: "main", html_url: "https://github.com/obra/superpowers", license: { spdx_id: "MIT" } }),
    latestRelease: () => null,
    commit: () => ({ sha: source.commit }),
    file: (repository, sourcePath) => {
      const selected = source.files.find((entry) => entry.sourcePath === sourcePath)
      return readFileSync(path.join(repo, selected.upstreamPath ?? selected.generatedPath))
    },
  })
  const hook = inspected.selected_files.find((entry) => entry.source_path === "hooks/run-hook.cmd")
  assert.equal(hook.generated_path, file.generatedPath)
  assert.equal(hook.upstream_path, file.upstreamPath)
  assert.equal(hook.candidate_sha256, file.sha256)
  assert.equal(inspected.classification, "current")
})

test("upstream refresh writes only the explicit evidence path, retaining downstream output and raw digest identity", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "superpowers-literal-updater-"))
  t.after(async () => {
    await removeTree(root)
    assert.equal(existsSync(root), false)
    t.diagnostic(`Removed owned literal-updater fixture: ${root}`)
  })
  const rawPath = "plugins/provider/hooks/upstream/run-hook.cmd"
  const actualPath = "plugins/provider/hooks/run-hook.cmd"
  mkdirSync(path.dirname(path.join(root, rawPath)), { recursive: true })
  writeFileSync(path.join(root, rawPath), "original upstream\n")
  writeFileSync(path.join(root, actualPath), "maintained downstream output\n")
  const lock = { sources: [{ id: "fixture", repository: "owner/repo", commit: "a".repeat(40), license: "MIT",
    files: [{ sourcePath: "hooks/run-hook.cmd", generatedPath: actualPath, sha256: hash("original upstream\n"), upstreamPath: rawPath }] }] }
  const lockPath = path.join(root, "upstream-sources.lock.json")
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n")
  const upstream = (bytes) => ({ commit: "b".repeat(40), tree: "c".repeat(40),
    entries: new Map([["hooks/run-hook.cmd", { type: "blob", mode: "100644" }]]),
    read: () => Buffer.from(bytes) })
  assert.equal(updateSource({ lockPath, sourceId: "fixture", upstream: upstream("original upstream\n") }).changed, false)
  assert.equal(updateSource({ lockPath, sourceId: "fixture", upstream: upstream("new upstream\n") }).changed, true)
  assert.equal(readFileSync(path.join(root, rawPath), "utf8"), "new upstream\n")
  assert.equal(readFileSync(path.join(root, actualPath), "utf8"), "maintained downstream output\n")
  const updated = JSON.parse(readFileSync(lockPath)).sources[0].files[0]
  assert.equal(updated.upstreamPath, rawPath)
  assert.equal(updated.sha256, hash("new upstream\n"))
  assert.equal(updateSource({ lockPath, sourceId: "fixture", upstream: upstream("new upstream\n") }).changed, false)
  for (const invalid of ["../outside", "/absolute", "plugins/provider/../outside", actualPath]) {
    lock.sources[0].files[0].upstreamPath = invalid
    writeFileSync(lockPath, JSON.stringify(lock))
    assert.throws(() => updateSource({ lockPath, sourceId: "fixture", upstream: upstream("new upstream\n") }), /upstream.*path/u)
    assert.equal(readFileSync(path.join(root, actualPath), "utf8"), "maintained downstream output\n")
  }
  const collision = { ...lock.sources[0].files[0], sourcePath: "hooks/upstream/run-hook.cmd", generatedPath: rawPath };
  lock.sources[0].files[0].upstreamPath = rawPath
  lock.sources[0].files.push(collision)
  writeFileSync(lockPath, JSON.stringify(lock))
  assert.throws(() => updateSource({ lockPath, sourceId: "fixture", upstream: upstream("new upstream\n") }), /upstream.*path/u)
})

for (const alias of ["symlink", "hardlink"]) {
  test(`upstream evidence ${alias} substitution refuses before touching downstream or external bytes`, { skip: process.platform === "win32" }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "superpowers-evidence-alias-"))
    t.after(async () => {
      await removeTree(root)
      assert.equal(existsSync(root), false)
      t.diagnostic(`Removed owned evidence-alias fixture: ${root}`)
    })
    const generatedPath = "plugins/provider/hooks/run-hook.cmd"
    const upstreamPath = "plugins/provider/hooks/upstream/run-hook.cmd"
    const target = path.join(root, upstreamPath), outside = path.join(root, "external-fixture")
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(outside, "raw evidence\n")
    writeFileSync(path.join(root, generatedPath), "maintained output\n")
    if (alias === "symlink") symlinkSync(outside, target)
    else linkSync(outside, target)
    const lockPath = path.join(root, "lock.json")
    writeFileSync(lockPath, JSON.stringify({ sources: [{ id: "fixture", files: [
      { sourcePath: "hooks/run-hook.cmd", generatedPath, sha256: hash("raw evidence\n"), upstreamPath },
    ] }] }))
    const before = readFileSync(lockPath)
    const upstream = { commit: "a".repeat(40), tree: "b".repeat(40),
      entries: new Map([["hooks/run-hook.cmd", { type: "blob", mode: "100644" }]]), read: () => Buffer.from("changed evidence\n") }
    assert.throws(() => updateSource({ lockPath, sourceId: "fixture", upstream }), /upstream evidence path/u)
    assert.equal(readFileSync(outside, "utf8"), "raw evidence\n")
    assert.equal(readFileSync(path.join(root, generatedPath), "utf8"), "maintained output\n")
    assert.deepEqual(readFileSync(lockPath), before)
    if (alias === "symlink") assert.equal(lstatSync(target).isSymbolicLink(), true)
    else assert.equal(lstatSync(target).nlink, 2)
  })
}
