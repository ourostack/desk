// The shared path-protection primitives behind both `src/protected/store.js`
// and `src/factory/outbox.js`. Every test runs against a throwaway temp
// directory and always cleans up.

import { test } from "node:test"
import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { promises as fs } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  assertNotGitCheckout,
  assertOutsideGitWorkspace,
  clearExtendedAcl,
  ensureOwnerOnlyDirectory,
  expandHome,
  lstatIfPresent,
  protectLeafFile,
  realpathExistingPrefix,
} from "../../src/factory/os-protect.js"

const NAMING = { label: "desk_test", subject: "test thing" }
const nativeMac = { skip: process.platform !== "darwin" }

async function scratch(run) {
  const base = mkdtempSync(path.join(os.tmpdir(), "desk-os-protect-"))
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

test("lstatIfPresent rethrows a non-ENOENT failure as a labeled error, rather than treating it as absent", async () => {
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

test("ensureOwnerOnlyDirectory creates, then re-verifies, an owner-only 0700 directory", async () => {
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

test("ensureOwnerOnlyDirectory handles a racing creator (EEXIST from mkdir)", async (t) => {
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

test("protectLeafFile refuses a symlink, a non-regular file and a hard link, and repairs a drifted mode", async () => {
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
