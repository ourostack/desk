import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { execFileSync, spawnSync } from "node:child_process"
import { removeTree } from "../_remove_tree.js"
import { otherFile } from "../_file_identity.js"

const repo = fileURLToPath(new URL("../../../../../", import.meta.url))
const require = createRequire(import.meta.url)
const compat = require(path.join(repo, "scripts/superpowers-hook-compat.cjs"))
const { refresh, main, upstreamVersion, chooseSuperpowersVersion, SUPERPOWERS_VERSION_FILES } = require(path.join(repo, "scripts/refresh-superpowers.cjs"))
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "superpowers-refresh-fault-")), retained = []
  t.after(async () => {
    for (const candidate of retained) if (fs.existsSync(candidate)) await removeTree(candidate)
    await removeTree(root); assert.equal(fs.existsSync(root), false)
  })
  const put = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  for (const file of SUPERPOWERS_VERSION_FILES) put(file, '{"version":"6.4.5"}\n')
  put("plugins/superpowers/README.md", `version 6.4.2, commit \`${"a".repeat(40)}\`; the upstream tree is \`${"b".repeat(40)}\`\n`)
  const raw = fs.readFileSync(path.join(repo, "plugins/superpowers/hooks/upstream/run-hook.cmd"))
  const bytes = new Map([
    ["hooks/run-hook.cmd", raw], ["LICENSE", Buffer.from("fixture MIT\n")], ["skills/example/SKILL.md", Buffer.from("original skill\n")],
  ])
  const source = { id: "obra-superpowers", repository: "obra/superpowers", commit: "a".repeat(40), license: "MIT",
    files: [...bytes].map(([sourcePath, content]) => ({
      sourcePath, generatedPath: `plugins/superpowers/${sourcePath}`, sha256: hash(content),
      ...(sourcePath === "hooks/run-hook.cmd" ? { upstreamPath: "plugins/superpowers/hooks/upstream/run-hook.cmd" } : {}),
    })) }
  for (const file of source.files) put(file.upstreamPath ?? file.generatedPath, bytes.get(file.sourcePath))
  put("upstream-sources.lock.json", JSON.stringify({ sources: [source] }, null, 2) + "\n")
  compat.generate({ root })
  const incoming = new Map(bytes)
  incoming.set("skills/example/SKILL.md", Buffer.from("incoming skill\n"))
  incoming.set(".claude-plugin/plugin.json", Buffer.from('{"version":"7.0.0"}'))
  const upstream = {
    commit: "c".repeat(40), tree: "d".repeat(40),
    entries: new Map([...incoming.keys()].map((file) => [file, { type: "blob", mode: "100644" }])),
    read: (file) => incoming.get(file),
  }
  return { root, put, retained, upstream, incoming, track(error) {
    if (error.candidateCleanupPath) retained.push(error.candidateCleanupPath)
    return error
  } }
}

test("refresh refuses non-hook raw drift and occupied new selected source before consumer writes", (t) => {
  const f = fixture(t), license = "plugins/superpowers/LICENSE"
  f.put(license, "foreign existing raw\n")
  assert.throws(() => refresh(f), /current raw SHA-256 drift/)
  f.put(license, "fixture MIT\n")
  f.put("plugins/superpowers/skills/example/new", "foreign untracked source\n")
  f.upstream.entries.set("skills/example/new", { type: "blob", mode: "100644" })
  f.incoming.set("skills/example/new", Buffer.from("upstream new\n"))
  assert.throws(() => refresh(f), /occupied incoming source path/)
  assert.equal(fs.readFileSync(path.join(f.root, "plugins/superpowers/skills/example/new"), "utf8"), "foreign untracked source\n")
})

test("existing release fragment is not overwritten by an incoming refresh", (t) => {
  const f = fixture(t)
  f.put("plugins/desk/changelog.d/superpowers-7.0.0.md", "foreign pending fragment\n")
  assert.throws(() => refresh(f), /release fragment already exists/)
  assert.equal(fs.readFileSync(path.join(f.root, "plugins/desk/changelog.d/superpowers-7.0.0.md"), "utf8"), "foreign pending fragment\n")
})

test("occupied initial guard journal refuses exclusive transition and retains UNKNOWN", (t) => {
  const f = fixture(t)
  const io = { ...fs, mkdirSync(file, ...args) {
    fs.mkdirSync(file, ...args)
    if (path.basename(file).startsWith(".superpowers-hook-transaction-guard-")) {
      fs.writeFileSync(path.join(file, "journal.json"), "foreign initial journal\n")
    }
  } }
  assert.throws(() => refresh({ ...f, io }), (error) => {
    f.track(error)
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.match(error.message, /initial guard journal path occupied/)
    return true
  })
})

test("guard changed after descriptor-qualified transition fails its caller readback", (t) => {
  const f = fixture(t), descriptors = new Map()
  let closes = 0
  const io = { ...fs, openSync(file, ...args) {
    const fd = fs.openSync(file, ...args); descriptors.set(fd, file); return fd
  }, closeSync(fd) {
    const file = descriptors.get(fd); fs.closeSync(fd)
    if (file?.endsWith("journal.json") && ++closes === 2) fs.writeFileSync(file, "foreign after transition\n")
  } }
  assert.throws(() => refresh({ ...f, io }), (error) => {
    f.track(error)
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.match(error.message, /guard journal transition readback changed/)
    return true
  })
})

for (const mode of ["identity", "cleanup-noop"]) {
  test(`candidate ${mode} refuses successful cleanup with a retained retry guard`, (t) => {
    const f = fixture(t)
    let candidate, published = false
    const io = { ...fs, mkdirSync(file, ...args) {
      fs.mkdirSync(file, ...args)
      if (path.basename(file).startsWith("superpowers-hook-candidate-")) candidate = file
    }, renameSync(from, to) {
      fs.renameSync(from, to)
      if (to.startsWith(f.root) && to.endsWith("superpowers-7.0.0.md")) published = true
    }, lstatSync(file, ...args) {
      const stat = fs.lstatSync(file, ...args)
      return mode === "identity" && published && file === candidate ? { ...stat, ...otherFile(stat), isDirectory: () => true } : stat
    }, rmSync(file, ...args) {
      if (mode === "cleanup-noop" && file === candidate) return
      return fs.rmSync(file, ...args)
    } }
    assert.throws(() => refresh({ ...f, io }), (error) => {
      f.track(error); assert.equal(error.recoveryStatus, "UNKNOWN")
      assert.match(error.message, mode === "identity" ? /candidate directory identity changed/ : /candidate still exists/)
      return true
    })
  })
}

test("retained-path existence and directory observation errors remain in candidate recovery state", (t) => {
  const f = fixture(t)
  let candidate, cleaning = false
  const io = { ...fs, mkdirSync(file, ...args) {
    fs.mkdirSync(file, ...args)
    if (path.basename(file).startsWith("superpowers-hook-candidate-")) candidate = file
  }, rmSync(file, ...args) {
    if (file === candidate) { cleaning = true; throw Error("candidate cleanup denied") }
    return fs.rmSync(file, ...args)
  }, existsSync(file) {
    if (cleaning && file === candidate) throw Object.assign(Error("candidate existence denied"), { code: "EACCES" })
    return fs.existsSync(file)
  }, readdirSync(file, ...args) {
    if (cleaning && file === f.root) throw Error("root blocker observation denied")
    return fs.readdirSync(file, ...args)
  } }
  assert.throws(() => refresh({ ...f, io }), (error) => {
    f.track(error); assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.ok(error.candidateRecoveryState.observationErrors.some((item) => item.reason === "candidate existence denied"))
    assert.match(error.guardCreationError, /root blocker observation denied/)
    return true
  })
})

test("a disappearing retained candidate is recorded as absent rather than another observation fault", (t) => {
  const f = fixture(t)
  let candidate, cleaning = false
  const io = { ...fs, mkdirSync(file, ...args) {
    fs.mkdirSync(file, ...args)
    if (path.basename(file).startsWith("superpowers-hook-candidate-")) candidate = file
  }, rmSync(file, ...args) {
    if (file === candidate) { cleaning = true; throw Error("candidate cleanup refused") }
    return fs.rmSync(file, ...args)
  }, existsSync(file) {
    if (cleaning && file === candidate) throw Object.assign(Error("candidate gone during observation"), { code: "ENOENT" })
    return fs.existsSync(file)
  } }
  assert.throws(() => refresh({ ...f, io }), (error) => {
    f.track(error); assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.deepEqual(error.candidateRecoveryState.observationErrors, [])
    assert.equal(error.retainedRoots.includes(candidate), false)
    return true
  })
})

test("upstream versions have an explicit fallback and packaging-only revisions advance", () => {
  assert.equal(chooseSuperpowersVersion("7.0.0", "7.0.0"), "7.0.1")
  const fake = (values) => ({ entries: new Map(Object.keys(values).map((file) => [file, {}])),
    read: (file) => Buffer.from(JSON.stringify(values[file])) })
  assert.equal(upstreamVersion(fake({ "package.json": { version: "7.2.0" } })), "7.2.0")
  assert.equal(upstreamVersion(fake({ ".claude-plugin/plugin.json": { version: "invalid" }, "package.json": { version: "7.3.0" } })), "7.3.0")
  assert.throws(() => upstreamVersion(fake({})), /declares no semantic version/)
})

test("successful changed and no-change refreshes preserve absent selected paths and raw evidence", (t) => {
  const f = fixture(t)
  f.upstream.entries.delete("skills/example/SKILL.md")
  f.upstream.entries.set("skills/example/replacement", { type: "blob", mode: "100644" })
  f.incoming.set("skills/example/replacement", Buffer.from("replacement"))
  assert.equal(refresh(f).changed, true)
  assert.equal(fs.existsSync(path.join(f.root, "plugins/superpowers/skills/example/SKILL.md")), false)
  const result = refresh(f)
  assert.equal(result.changed, false); assert.equal(result.release, null)
  compat.verify({ root: f.root })
})

test("malformed release README fails before any consumer version is changed", (t) => {
  const f = fixture(t), version = fs.readFileSync(path.join(f.root, SUPERPOWERS_VERSION_FILES[0]))
  f.put("plugins/superpowers/README.md", "unknown provenance format")
  assert.throws(() => refresh(f), /no longer states/)
  assert.deepEqual(fs.readFileSync(path.join(f.root, SUPERPOWERS_VERSION_FILES[0])), version)
})

for (const fault of ["journal", "directory", "missing", "rearm-fails"]) {
  test(`candidate allocation re-admits the original guard: ${fault}`, (t) => {
    const f = fixture(t)
    let injected = false
    const io = { ...fs, mkdirSync(file, ...args) {
      if (injected && fault === "rearm-fails" && path.basename(file).startsWith(".superpowers-hook-transaction-guard-")) {
        throw Error("rearm allocation refused")
      }
      fs.mkdirSync(file, ...args)
      if (!injected && path.basename(file).startsWith("superpowers-hook-candidate-")) {
        injected = true
        const guard = path.join(f.root, fs.readdirSync(f.root).find((name) => name.startsWith(".superpowers-hook-transaction-guard-")))
        if (fault === "directory") { fs.rmSync(guard, { recursive: true }); fs.mkdirSync(guard) }
        if (["missing", "rearm-fails"].includes(fault)) fs.rmSync(guard, { recursive: true })
        else fs.writeFileSync(path.join(guard, "journal.json"), "foreign bytes")
      }
    } }
    assert.throws(() => refresh({ ...f, io }), (error) => {
      f.track(error); assert.equal(error.recoveryStatus, "UNKNOWN")
      if (fault === "rearm-fails") assert.equal(error.retryBlockingEstablished, false)
      return true
    })
  })
}

for (const fault of ["journal", "directory"]) {
  test(`changed guard during candidate disposal is not silently removed: ${fault}`, (t) => {
    const f = fixture(t)
    let candidate
    const io = { ...fs, mkdirSync(file, ...args) {
      fs.mkdirSync(file, ...args)
      if (path.basename(file).startsWith("superpowers-hook-candidate-")) candidate = file
    }, rmSync(file, ...args) {
      fs.rmSync(file, ...args)
      if (file === candidate) {
        const guard = path.join(f.root, fs.readdirSync(f.root).find((name) => name.startsWith(".superpowers-hook-transaction-guard-")))
        if (fault === "directory") { fs.rmSync(guard, { recursive: true }); fs.mkdirSync(guard) }
        fs.writeFileSync(path.join(guard, "journal.json"), "foreign during cleanup")
      }
    } }
    assert.throws(() => refresh({ ...f, io }), (error) => {
      f.track(error); assert.equal(error.recoveryStatus, "UNKNOWN")
      return true
    })
  })
}

test("nested unknown candidate recovery survives enclosing refresh cleanup", (t) => {
  const f = fixture(t)
  const original = f.incoming.get("hooks/run-hook.cmd").toString()
  const changed = original.replace("@echo off\n", "@echo off\nREM Fixture upstream change\n")
  assert.notEqual(changed, original)
  f.incoming.set("hooks/run-hook.cmd", Buffer.from(changed))
  const io = { ...fs, renameSync(from, to) {
    if (to.includes("superpowers-hook-candidate-") && to.endsWith("run-hook-compat.provenance.json")) {
      fs.writeFileSync(path.join(path.dirname(to), "run-hook.cmd"), "foreign nested output")
      throw Error("nested publish failure")
    }
    return fs.renameSync(from, to)
  } }
  assert.throws(() => refresh({ ...f, io }), (error) => {
    f.track(error); assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.ok(error.retainedRoots.includes(error.recoveryPath))
    return true
  })
})

test("refresh argument validation and real CLI qualify a bounded fixture Git tree", (t) => {
  for (const args of [[], ["--upstream-dir"], ["--unknown", "value"]]) assert.throws(() => main(args), /required|unknown or incomplete/)
  assert.throws(() => main(), /required/)
  const f = fixture(t), upstreamDir = path.join(f.root, "upstream-input")
  fs.mkdirSync(upstreamDir)
  for (const [file, content] of f.incoming) {
    fs.mkdirSync(path.dirname(path.join(upstreamDir, file)), { recursive: true })
    fs.writeFileSync(path.join(upstreamDir, file), content)
  }
  const git = (...args) => execFileSync("git", ["-C", upstreamDir, ...args], { encoding: "utf8" }).trim()
  git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid")
  git("config", "commit.gpgsign", "false"); git("add", "--all"); git("commit", "--quiet", "-m", "fixture")
  let output = ""
  assert.equal(main(["--upstream-dir", upstreamDir, "--root", f.root, "--ref", "HEAD"], { stdout: { write: (text) => { output += text } } }), 0)
  assert.equal(JSON.parse(output).changed, true)
  const cli = path.join(repo, "scripts/refresh-superpowers.cjs")
  const success = spawnSync(process.execPath, [cli, "--upstream-dir", upstreamDir, "--root", f.root], { encoding: "utf8", timeout: 5000 })
  assert.equal(success.status, 0, success.stderr)
  assert.equal(JSON.parse(success.stdout).changed, false)
  const failure = spawnSync(process.execPath, [cli], { encoding: "utf8", timeout: 5000 })
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /required/)
})
