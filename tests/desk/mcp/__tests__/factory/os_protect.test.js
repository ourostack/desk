// The shared path-protection primitives behind `src/factory/outbox.js`. Every test runs against a throwaway temp
// directory and always cleans up.

import { test } from "node:test"
import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { promises as fs } from "node:fs"
import { mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  assertNotGitCheckout,
  assertOutsideGitWorkspace,
  clearExtendedAcl,
  ensureOwnerOnlyDirectory,
  expandHome,
  lstatIfPresent,
  primeAclFreeFiles,
  protectLeafFile,
  realpathExistingPrefix,
} from "../../../../../plugins/desk/mcp/src/factory/os-protect.js"
import { NO_ENOTDIR, NO_POSIX_MODES } from "../_platform.js"

const NAMING = { label: "desk_test", subject: "test thing" }
const nativeMac = { skip: process.platform !== "darwin" }

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-os-protect-")))
  try {
    return await run(base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

test("expandHome expands ~ and ~/... but leaves other paths alone", () => {
  assert.equal(expandHome("~", "/home/x"), "/home/x")
  assert.equal(expandHome("~/sub/dir", "/home/x"), path.join("/home/x", "sub", "dir"))
  assert.equal(expandHome("/already/absolute", "/home/x"), "/already/absolute")
  assert.equal(expandHome("relative/path", "/home/x"), "relative/path")
})

test("lstatIfPresent returns null for a missing path and the stat for an existing one", async () => {
  await scratch(async (base) => {
    assert.equal(await lstatIfPresent(path.join(base, "nope"), NAMING), null)
    const stat = await lstatIfPresent(base, NAMING)
    assert.equal(stat.isDirectory(), true)
  })
})

test("lstatIfPresent rethrows a non-ENOENT failure as a labeled error, rather than treating it as absent", { skip: NO_ENOTDIR }, async () => {
  await scratch(async (base) => {
    // A path with a plain-file ancestor produces ENOTDIR, not ENOENT.
    const file = path.join(base, "blocker")
    await fs.writeFile(file, "not a directory")
    await assert.rejects(
      () => lstatIfPresent(path.join(file, "child"), NAMING),
      /desk_test: private test thing path .* could not be inspected \(ENOTDIR\)/u,
    )
  })
})

test("assertNotGitCheckout refuses a directory that directly contains .git and passes one that doesn't", async () => {
  await scratch(async (base) => {
    await assert.doesNotReject(() => assertNotGitCheckout(base, NAMING))
    await fs.mkdir(path.join(base, ".git"))
    await assert.rejects(
      () => assertNotGitCheckout(base, NAMING),
      /desk_test: refusing to write private test thing inside the Git checkout at/u,
    )
  })
})

test("assertOutsideGitWorkspace walks every ancestor up to the filesystem root", async () => {
  await scratch(async (base) => {
    const deep = path.join(base, "a", "b", "c")
    await fs.mkdir(deep, { recursive: true })
    await assert.doesNotReject(() => assertOutsideGitWorkspace(deep, NAMING))
    await fs.mkdir(path.join(base, ".git"))
    await assert.rejects(() => assertOutsideGitWorkspace(deep, NAMING), /Git checkout/u)
  })
})

test("realpathExistingPrefix resolves the deepest existing ancestor and lists the missing remainder", async () => {
  await scratch(async (base) => {
    const target = path.join(base, "one", "two", "three")
    const { real, remainder } = await realpathExistingPrefix(target)
    assert.equal(real, await fs.realpath(base))
    assert.deepEqual(remainder, ["one", "two", "three"])

    await fs.mkdir(path.join(base, "one", "two"), { recursive: true })
    const second = await realpathExistingPrefix(target)
    assert.equal(second.real, await fs.realpath(path.join(base, "one", "two")))
    assert.deepEqual(second.remainder, ["three"])
  })
})

test("realpathExistingPrefix follows a symlinked existing ancestor", async () => {
  await scratch(async (base) => {
    const real = path.join(base, "real")
    await fs.mkdir(real)
    const link = path.join(base, "link")
    await fs.symlink(real, link)
    const { real: resolved, remainder } = await realpathExistingPrefix(path.join(link, "child"))
    assert.equal(resolved, await fs.realpath(real))
    assert.deepEqual(remainder, ["child"])
  })
})

test("realpathExistingPrefix gives up once it reaches the filesystem root with nothing resolvable", async (t) => {
  const failure = Object.assign(new Error("nothing resolves, ever"), { code: "ENOENT" })
  const mocked = t.mock.method(fs, "realpath", async () => {
    throw failure
  })
  try {
    await assert.rejects(() => realpathExistingPrefix("/a/b/c"), (error) => error === failure)
  } finally {
    mocked.mock.restore()
  }
})

test("realpathExistingPrefix rethrows a non-ENOENT/ENOTDIR failure", async (t) => {
  await scratch(async (base) => {
    const failure = Object.assign(new Error("denied"), { code: "EACCES" })
    const mocked = t.mock.method(fs, "realpath", async () => {
      throw failure
    })
    try {
      await assert.rejects(() => realpathExistingPrefix(path.join(base, "child")), (error) => error === failure)
    } finally {
      mocked.mock.restore()
    }
  })
})

test("clearExtendedAcl is a no-op off darwin", () => {
  assert.doesNotThrow(() => clearExtendedAcl("/nonexistent", "linux", NAMING))
  assert.doesNotThrow(() => clearExtendedAcl("/nonexistent", "win32", NAMING))
})

test("ACL batch observation is a no-op off macOS and for an empty list", async (t) => {
  t.mock.method(childProcess, "execFileSync", () => { throw new Error("unexpected native inspection") })
  await primeAclFreeFiles(["/absent"], "linux", NAMING)
  await primeAclFreeFiles(["/absent"], "win32", NAMING)
  await primeAclFreeFiles([], "darwin", NAMING)
})

test("ACL-free batches retain the native limits and leave ordinary leaf checks in place", async (t) => {
  await scratch(async (base) => {
    await fs.mkdir(path.join(base, "left"))
    await fs.mkdir(path.join(base, "right"))
    const files = Array.from({ length: 65 }, (_, index) => path.join(base, index % 2 ? "left" : "right", `${index}.json`))
    for (const file of files) await fs.writeFile(file, "{}", { mode: 0o600 })
    const lstat = fs.lstat.bind(fs)
    const ancestors = new Map()
    t.mock.method(fs, "lstat", async (file, ...args) => {
      const stat = await lstat(file, ...args)
      const relative = path.relative(base, String(file))
      if (stat.isDirectory() && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
        if (!ancestors.has(String(file))) ancestors.set(String(file), stat)
        return ancestors.get(String(file))
      }
      return stat
    })
    const calls = []
    t.mock.method(childProcess, "execFileSync", (command, args, options) => {
      calls.push({ command, args, options })
      return "regular files\n"
    })
    await primeAclFreeFiles(files, "darwin", NAMING)
    assert.deepEqual(calls.map((call) => call.args.length - 1), [32, 32, 1])
    for (const call of calls) {
      assert.equal(call.command, "/bin/ls")
      assert.equal(call.args[0], "-ldeq")
      assert.equal(call.options.timeout, 5000)
      assert.equal(call.options.maxBuffer, 65536)
    }
    await primeAclFreeFiles([...files, files[0]], "darwin", NAMING)
    assert.equal(calls.length, 3, "unchanged witnessed identities need no second native inspection")
    for (const file of files) await protectLeafFile(file, "darwin", NAMING)
    assert.equal(calls.length, 3, "the existing leaf guard consumes only the same witnessed identities")
  })
})

test("ACL batches bound argument bytes as well as file count", async (t) => {
  await scratch(async (base) => {
    const files = Array.from({ length: 12 }, (_, index) => path.join(base, `${index}-${"x".repeat(1000)}`))
    t.mock.method(fs, "lstat", async (file) => {
      const leaf = files.includes(file)
      return { dev: 1, ino: 2, ctimeMs: 3, nlink: 1, isFile: () => leaf, isDirectory: () => !leaf }
    })
    const calls = []
    t.mock.method(childProcess, "execFileSync", (command, args) => { calls.push(args.slice(1)); return "regular files\n" })
    await primeAclFreeFiles(files, "darwin", NAMING)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.flat(), files)
    assert.ok(calls.every((batch) => batch.reduce((sum, file) => sum + Buffer.byteLength(file), 0) <= 8192))
  })
})

for (const missing of [true, false]) {
  test(`an initially ${missing ? "missing" : "non-directory"} parent refuses ACL batch observation`, async (t) => {
    await scratch(async (base) => {
      const file = path.join(base, "leaf.json")
      await fs.writeFile(file, "{}", { mode: 0o600 })
      const lstat = fs.lstat.bind(fs)
      t.mock.method(fs, "lstat", async (target, ...args) => {
        if (target === base) {
          if (missing) throw Object.assign(new Error("gone"), { code: "ENOENT" })
          return { isDirectory: () => false }
        }
        return lstat(target, ...args)
      })
      t.mock.method(childProcess, "execFileSync", () => { throw new Error("unexpected native inspection") })
      await assert.rejects(() => primeAclFreeFiles([file], "darwin", NAMING), /acl_parent_changed/u)
    })
  })
}

test("a parent missing after native inspection cannot make a leaf look verified", async (t) => {
  await scratch(async (base) => {
    const file = path.join(base, "leaf.json")
    await fs.writeFile(file, "{}", { mode: 0o600 })
    const lstat = fs.lstat.bind(fs)
    let inspected = false
    t.mock.method(fs, "lstat", async (target, ...args) => {
      if (target === base && inspected) throw Object.assign(new Error("gone"), { code: "ENOENT" })
      return lstat(target, ...args)
    })
    let calls = 0
    t.mock.method(childProcess, "execFileSync", () => { calls += 1; inspected = true; return "regular file\n" })
    await primeAclFreeFiles([file], "darwin", NAMING)
    await protectLeafFile(file, "darwin", NAMING)
    assert.equal(calls, 2)
  })
})

test("ACL observation excludes missing, linked and non-regular paths without repairing them", async (t) => {
  await scratch(async (base) => {
    const files = ["missing", "symlink", "directory", "hardlink", "regular"].map((name) => path.join(base, name))
    const statOf = async (file) => {
      const name = path.basename(file)
      if (name === "missing") throw Object.assign(new Error("gone"), { code: "ENOENT" })
      return {
        dev: 1, ino: 2, ctimeMs: 3, mode: 0o600, nlink: name === "hardlink" ? 2 : 1,
        isFile: () => ["regular", "hardlink"].includes(name),
        isDirectory: () => !files.includes(file),
        isSymbolicLink: () => name === "symlink",
      }
    }
    t.mock.method(fs, "lstat", statOf)
    const calls = []
    t.mock.method(childProcess, "execFileSync", (command, args) => { calls.push(args); return "regular file\n" })
    await primeAclFreeFiles([...files, files[4]], "darwin", NAMING)
    assert.deepEqual(calls, [["-ldeq", files[4]]])
    await assert.rejects(() => protectLeafFile(files[1], "darwin", NAMING), /is a symlink/u)
    await assert.rejects(() => protectLeafFile(files[2], "darwin", NAMING), /is not a regular file/u)
    await assert.rejects(() => protectLeafFile(files[3], "darwin", NAMING), /is hard-linked/u)
    assert.equal(calls.length, 1)
  })
})

test("a failed native ACL batch propagates and cannot make a later leaf look verified", async (t) => {
  await scratch(async (base) => {
    const file = path.join(base, "leaf.json")
    await fs.writeFile(file, "{}", { mode: 0o600 })
    const failure = Object.assign(new Error("native inspection timed out"), { code: "ETIMEDOUT" })
    let calls = 0
    t.mock.method(childProcess, "execFileSync", () => {
      if (++calls === 1) throw failure
      return "regular file\n"
    })
    await assert.rejects(() => primeAclFreeFiles([file], "darwin", NAMING), (error) => error === failure)
    await protectLeafFile(file, "darwin", NAMING)
    assert.equal(calls, 2, "the failed batch cannot populate the ACL-free cache")
  })
})

test("an ACL in a batch leaves every member for ordinary inspection and clearing", async (t) => {
  await scratch(async (base) => {
    const files = [path.join(base, "grant.json"), path.join(base, "clean.json")]
    for (const file of files) await fs.writeFile(file, "{}", { mode: 0o600 })
    let granted = true
    const calls = []
    t.mock.method(childProcess, "execFileSync", (command, args) => {
      calls.push(command)
      if (command === "/bin/chmod") granted = false
      return command === "/bin/ls" && args.includes(files[0]) && granted
        ? "regular file\n 0: group:everyone allow read\n" : "regular file\n"
    })
    await primeAclFreeFiles(files, "darwin", NAMING)
    for (const file of files) await protectLeafFile(file, "darwin", NAMING)
    assert.equal(granted, false)
    assert.deepEqual(calls, ["/bin/ls", "/bin/ls", "/bin/chmod", "/bin/ls", "/bin/ls"])
  })
})

for (const change of ["rewrite", "replace", "remove"]) {
  test(`a file ${change} during native batch observation cannot inherit a clean identity`, async (t) => {
    await scratch(async (base) => {
      const file = path.join(base, "leaf.json")
      const replacement = path.join(base, "replacement.json")
      await fs.writeFile(file, "original", { mode: 0o600 })
      await fs.writeFile(replacement, "replacement", { mode: 0o600 })
      let calls = 0
      t.mock.method(childProcess, "execFileSync", () => {
        if (++calls === 1) {
          if (change === "rewrite") writeFileSync(file, "changed bytes")
          else if (change === "replace") renameSync(replacement, file)
          else unlinkSync(file)
        }
        return "regular file\n"
      })
      await primeAclFreeFiles([file], "darwin", NAMING)
      if (change === "remove") {
        await assert.rejects(() => protectLeafFile(file, "darwin", NAMING), { code: "ENOENT" })
        await fs.writeFile(file, "new file", { mode: 0o600 })
      }
      await protectLeafFile(file, "darwin", NAMING)
      assert.equal(calls, 2, "changed or missing identities were never recorded as clean")
    })
  })
}

test("native macOS: a real ACL added after batch observation is still found and cleared", nativeMac, async (t) => {
  await scratch(async (base) => {
    const file = path.join(base, "leaf.json")
    await fs.writeFile(file, "{}", { mode: 0o600 })
    const native = childProcess.execFileSync.bind(childProcess)
    const calls = []
    t.mock.method(childProcess, "execFileSync", (command, ...args) => {
      calls.push(command)
      return native(command, ...args)
    })
    await primeAclFreeFiles([file], "darwin", NAMING)
    native("/bin/chmod", ["+a", "everyone allow read", file], { timeout: 5000 })
    await protectLeafFile(file, "darwin", NAMING)
    assert.deepEqual(calls, ["/bin/ls", "/bin/ls", "/bin/chmod", "/bin/ls"])
    assert.doesNotMatch(native("/bin/ls", ["-ldeq", file], { encoding: "utf8" }), /^\s*\d+:/mu)
  })
})

for (const at of ["parent", "ancestor"]) {
  test(`native macOS: a transient ${at} substitution cannot make an ACL-bearing file look clean`, nativeMac, async (t) => {
    await scratch(async (base) => {
      const tree = path.join(base, "tree")
      const outside = path.join(base, "external")
      const owned = path.join(tree, "owned")
      const saved = path.join(base, "saved")
      const external = path.join(outside, "owned")
      await fs.mkdir(owned, { recursive: true })
      await fs.mkdir(external, { recursive: true })
      const files = ["grant.json", "peer.json"].map((name) => path.join(owned, name))
      for (const file of files) {
        await fs.writeFile(file, "owned", { mode: 0o600 })
        await fs.writeFile(path.join(external, path.basename(file)), "external", { mode: 0o600 })
      }
      const native = childProcess.execFileSync.bind(childProcess)
      native("/bin/chmod", ["+a", "everyone allow read", files[0]], { timeout: 5000 })
      let swapped = false
      t.mock.method(childProcess, "execFileSync", (command, args, options) => {
        if (command !== "/bin/ls" || swapped) return native(command, args, options)
        swapped = true
        const moved = at === "parent" ? owned : tree
        renameSync(moved, saved)
        symlinkSync(at === "parent" ? external : outside, moved, "dir")
        try { return native(command, args, options) } finally {
          unlinkSync(moved)
          renameSync(saved, moved)
        }
      })
      await primeAclFreeFiles(files, "darwin", NAMING)
      await protectLeafFile(files[0], "darwin", NAMING)
      assert.equal(swapped, true)
      assert.doesNotMatch(native("/bin/ls", ["-ldeq", files[0]], { encoding: "utf8" }), /^\s*\d+:/mu)
      assert.equal(await fs.readFile(path.join(external, "grant.json"), "utf8"), "external")
    })
  })
}

test("native macOS: a parent changed across both witness boundaries cannot transfer an external clean result", nativeMac, async (t) => {
  await scratch(async (base) => {
    const owned = path.join(base, "owned")
    const saved = path.join(base, "saved")
    const external = path.join(base, "external")
    await fs.mkdir(owned)
    await fs.mkdir(external)
    const files = ["grant.json", "peer.json"].map((name) => path.join(owned, name))
    for (const file of files) {
      await fs.writeFile(file, "owned", { mode: 0o600 })
      await fs.writeFile(path.join(external, path.basename(file)), "external", { mode: 0o600 })
    }
    const native = childProcess.execFileSync.bind(childProcess)
    native("/bin/chmod", ["+a", "everyone allow read", files[0]], { timeout: 5000 })
    const lstat = fs.lstat.bind(fs)
    let swapped = false
    let restored = false
    let roots = 0
    const restore = () => {
      renameSync(owned, external)
      renameSync(saved, owned)
      restored = true
    }
    t.mock.method(fs, "lstat", async (target, ...args) => {
      if (target === owned && !swapped) {
        renameSync(owned, saved)
        renameSync(external, owned)
        swapped = true
      }
      const stat = await lstat(target, ...args)
      if (swapped && !restored && target === path.parse(owned).root && ++roots === 2) restore()
      return stat
    })
    try { await primeAclFreeFiles(files, "darwin", NAMING) } finally {
      if (swapped && !restored) restore()
    }
    await protectLeafFile(files[0], "darwin", NAMING)
    assert.equal(swapped, true)
    assert.equal(restored, true)
    assert.doesNotMatch(native("/bin/ls", ["-ldeq", files[0]], { encoding: "utf8" }), /^\s*\d+:/mu)
  })
})

test("clearExtendedAcl clears a real inherited ACL grant on darwin", nativeMac, async () => {
  await scratch(async (base) => {
    const dir = path.join(base, "target")
    await fs.mkdir(dir)
    childProcess.execFileSync("/bin/chmod", ["+a", "everyone allow list,search", dir], { timeout: 5000 })
    assert.match(childProcess.execFileSync("/bin/ls", ["-ldeq", dir], { encoding: "utf8" }), /everyone allow/u)
    clearExtendedAcl(dir, "darwin", NAMING)
    assert.doesNotMatch(childProcess.execFileSync("/bin/ls", ["-ldeq", dir], { encoding: "utf8" }), /^\s*\d+:/mu)
  })
})

test("clearExtendedAcl refuses when the native provider fails or an ACL survives", async (t) => {
  for (const outcome of ["unavailable", "retained"]) {
    const failure = new Error("native provider unavailable")
    const mocked = t.mock.method(childProcess, "execFileSync", (command) => {
      if (outcome === "unavailable") throw failure
      return command === "/bin/ls" ? "directory\n 0: group:everyone allow read\n" : ""
    })
    try {
      if (outcome === "unavailable") {
        assert.throws(() => clearExtendedAcl("/x", "darwin", NAMING), (error) => error === failure)
      } else {
        assert.throws(() => clearExtendedAcl("/x", "darwin", NAMING), /retains an extended ACL/u)
      }
    } finally {
      mocked.mock.restore()
    }
  }
})

test("clearExtendedAcl accepts a path whose listing shows no ACL entry", (t) => {
  const calls = []
  const mocked = t.mock.method(childProcess, "execFileSync", (command) => {
    calls.push(command)
    return command === "/bin/ls" ? "drwx------  2 owner  staff  64 Jan  1 00:00 /x\n" : ""
  })
  try {
    assert.equal(clearExtendedAcl("/x", "darwin", NAMING), true)
    assert.deepEqual(calls, ["/bin/ls"], "a path with no ACL entry is listed once and never touched")
  } finally {
    mocked.mock.restore()
  }
})

test("clearExtendedAcl clears a listed ACL entry and lists again to prove it is gone", (t) => {
  const calls = []
  let listed = 0
  const mocked = t.mock.method(childProcess, "execFileSync", (command) => {
    calls.push(command)
    if (command !== "/bin/ls") return ""
    listed += 1
    return listed === 1 ? "drwx------  2 owner  staff  64 Jan  1 00:00 /x\n 0: group:everyone allow read\n" : "drwx------  2 owner  staff  64 Jan  1 00:00 /x\n"
  })
  try {
    assert.equal(clearExtendedAcl("/x", "darwin", NAMING), false)
    assert.deepEqual(calls, ["/bin/ls", "/bin/chmod", "/bin/ls"])
  } finally {
    mocked.mock.restore()
  }
})

test("a directory and a file proved ACL-free are not listed again until their identity or change time moves (darwin)", { skip: NO_POSIX_MODES }, async (t) => {
  await scratch(async (base) => {
    const dir = path.join(base, "owned")
    const file = path.join(dir, "leaf.json")
    await ensureOwnerOnlyDirectory(dir, "linux", NAMING)
    await fs.writeFile(file, "{}", { mode: 0o600 })
    const calls = []
    let withAcl = false
    const mocked = t.mock.method(childProcess, "execFileSync", (command, args) => {
      calls.push([command, args[args.length - 1]])
      if (command !== "/bin/ls") return ""
      return withAcl ? "x\n 0: group:everyone allow read\n" : "x\n"
    })
    try {
      await ensureOwnerOnlyDirectory(dir, "darwin", NAMING)
      await protectLeafFile(file, "darwin", NAMING)
      assert.equal(calls.length, 2, "the first use lists each path once")
      await ensureOwnerOnlyDirectory(dir, "darwin", NAMING)
      await protectLeafFile(file, "darwin", NAMING)
      assert.equal(calls.length, 2, "the second use is answered from what was proved")

      // Anything that touches the path moves its change time, so it is listed again.
      await fs.chmod(file, 0o640)
      await protectLeafFile(file, "darwin", NAMING)
      assert.equal(calls.length, 3, "a drifted mode is listed again and repaired")
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
      await protectLeafFile(file, "darwin", NAMING)
      assert.equal(calls.length, 4, "the repair moved the change time, so the next call lists once more")
      await protectLeafFile(file, "darwin", NAMING)
      assert.equal(calls.length, 4)

      // A rename-over is a different file, so it is checked on its own, and an ACL that appears is cleared and never remembered.
      const replacement = path.join(dir, "replacement.json")
      await fs.writeFile(replacement, "{}", { mode: 0o600 })
      await fs.rename(replacement, file)
      withAcl = true
      mocked.mock.mockImplementation((command, args) => {
        calls.push([command, args[args.length - 1]])
        if (command === "/bin/chmod") withAcl = false
        return command === "/bin/ls" && withAcl ? "x\n 0: group:everyone allow read\n" : "x\n"
      })
      const before = calls.length
      await protectLeafFile(file, "darwin", NAMING)
      assert.deepEqual(calls.slice(before).map(([command]) => command), ["/bin/ls", "/bin/chmod", "/bin/ls"])
    } finally {
      mocked.mock.restore()
    }
  })
})

test("native macOS: a real ACL added to a file this process proved clean is listed and cleared again, and an untouched file is not listed again", nativeMac, async (t) => {
  await scratch(async (base) => {
    const file = path.join(base, "leaf.json")
    await fs.writeFile(file, "{}", { mode: 0o600 })
    // Nothing is stubbed: the real ls and chmod run, and the real execFileSync is only counted.
    const real = childProcess.execFileSync.bind(childProcess)
    const calls = []
    const counted = t.mock.method(childProcess, "execFileSync", (command, ...rest) => {
      calls.push(command)
      return real(command, ...rest)
    })
    try {
      await protectLeafFile(file, "darwin", NAMING)
      await protectLeafFile(file, "darwin", NAMING)
      assert.deepEqual(calls, ["/bin/ls"], "listed once, then answered from what was proved")
      real("/bin/chmod", ["+a", "everyone allow read", file], { timeout: 5000 })
      assert.match(real("/bin/ls", ["-ldeq", file], { encoding: "utf8" }), /everyone allow/u)
      calls.length = 0
      await protectLeafFile(file, "darwin", NAMING)
      assert.deepEqual(calls, ["/bin/ls", "/bin/chmod", "/bin/ls"], "an ACL added since is found and cleared")
      assert.doesNotMatch(real("/bin/ls", ["-ldeq", file], { encoding: "utf8" }), /^\s*\d+:/mu)
    } finally {
      counted.mock.restore()
    }
  })
})

test("a retained ACL is refused on every call and never remembered as proved (darwin)", { skip: NO_POSIX_MODES }, async (t) => {
  await scratch(async (base) => {
    const file = path.join(base, "leaf.json")
    await fs.writeFile(file, "{}", { mode: 0o600 })
    const mocked = t.mock.method(childProcess, "execFileSync", (command) => (command === "/bin/ls" ? "x\n 0: group:everyone allow read\n" : ""))
    try {
      await assert.rejects(() => protectLeafFile(file, "darwin", NAMING), /retains an extended ACL/u)
      await assert.rejects(() => protectLeafFile(file, "darwin", NAMING), /retains an extended ACL/u)
    } finally {
      mocked.mock.restore()
    }
  })
})

test("ensureOwnerOnlyDirectory creates, then re-verifies, an owner-only 0700 directory", { skip: NO_POSIX_MODES }, async () => {
  await scratch(async (base) => {
    const dir = path.join(base, "sub")
    const created = await ensureOwnerOnlyDirectory(dir, "linux", NAMING)
    assert.equal(created, true)
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700)
    await fs.chmod(dir, 0o755)
    const second = await ensureOwnerOnlyDirectory(dir, "linux", NAMING)
    assert.equal(second, false)
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700)
  })
})

test("ensureOwnerOnlyDirectory refuses a symlink and a plain file in the directory's place", async () => {
  await scratch(async (base) => {
    const target = path.join(base, "real")
    await fs.mkdir(target)
    const link = path.join(base, "link")
    await fs.symlink(target, link)
    await assert.rejects(() => ensureOwnerOnlyDirectory(link, "linux", NAMING), /is a symlink/u)

    const file = path.join(base, "plain")
    await fs.writeFile(file, "x")
    await assert.rejects(() => ensureOwnerOnlyDirectory(file, "linux", NAMING), /is not a directory/u)
  })
})

test("ensureOwnerOnlyDirectory handles a racing creator (EEXIST from mkdir)", { skip: NO_POSIX_MODES }, async (t) => {
  await scratch(async (base) => {
    const dir = path.join(base, "raced")
    const mkdir = fs.mkdir.bind(fs)
    const mocked = t.mock.method(fs, "mkdir", async (target, options) => {
      await mkdir(target, { mode: 0o777 })
      throw Object.assign(new Error("raced"), { code: "EEXIST" })
    })
    try {
      const created = await ensureOwnerOnlyDirectory(dir, "linux", NAMING)
      assert.equal(created, false)
      assert.equal((await fs.stat(dir)).mode & 0o777, 0o700)
    } finally {
      mocked.mock.restore()
    }
  })
})

test("ensureOwnerOnlyDirectory propagates a non-EEXIST mkdir failure", async (t) => {
  await scratch(async (base) => {
    const dir = path.join(base, "denied")
    const failure = Object.assign(new Error("denied"), { code: "EACCES" })
    const mocked = t.mock.method(fs, "mkdir", async () => {
      throw failure
    })
    try {
      await assert.rejects(() => ensureOwnerOnlyDirectory(dir, "linux", NAMING), (error) => error === failure)
    } finally {
      mocked.mock.restore()
    }
  })
})

test("ensureOwnerOnlyDirectory skips the POSIX mode/ACL step on win32", async () => {
  await scratch(async (base) => {
    const dir = path.join(base, "winlike")
    await ensureOwnerOnlyDirectory(dir, "win32", NAMING)
    assert.equal((await fs.stat(dir)).isDirectory(), true)
  })
})

test("protectLeafFile refuses a symlink, a non-regular file and a hard link, and repairs a drifted mode", { skip: NO_POSIX_MODES }, async () => {
  await scratch(async (base) => {
    const real = path.join(base, "real.json")
    await fs.writeFile(real, "{}")
    const link = path.join(base, "link.json")
    await fs.symlink(real, link)
    await assert.rejects(() => protectLeafFile(link, "linux", NAMING), /is a symlink/u)

    const dir = path.join(base, "dir.json")
    await fs.mkdir(dir)
    await assert.rejects(() => protectLeafFile(dir, "linux", NAMING), /is not a regular file/u)

    const hardLinked = path.join(base, "linked.json")
    await fs.link(real, hardLinked)
    await assert.rejects(() => protectLeafFile(hardLinked, "linux", NAMING), /is hard-linked/u)
    await fs.unlink(hardLinked)

    await fs.chmod(real, 0o644)
    await protectLeafFile(real, "linux", NAMING)
    assert.equal((await fs.stat(real)).mode & 0o777, 0o600)
  })
})

test("protectLeafFile skips the POSIX mode/ACL step on win32", async () => {
  await scratch(async (base) => {
    const file = path.join(base, "win.json")
    await fs.writeFile(file, "{}", { mode: 0o644 })
    await protectLeafFile(file, "win32", NAMING)
    // Mode is left as is off the POSIX branch; the file is still a valid regular file.
    assert.equal((await fs.stat(file)).isFile(), true)
  })
})
