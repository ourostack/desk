import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as endpoints from "../../src/readiness/identity.js"
import { connectOrStartController } from "../../src/readiness/controller-client.js"
import { startReadinessController } from "../../src/readiness/controller-server.js"

function filesystem(entries = {}) {
  const dirs = new Map(Object.entries({
    "/": { uid: 0, mode: 0o755 },
    "/run": { uid: 0, mode: 0o755 },
    "/run/user": { uid: 0, mode: 0o755 },
    "/tmp": { uid: 0, mode: 0o1777 },
    ...entries,
  }))
  const created = []
  return {
    created,
    lstatSync(name) {
      const entry = dirs.get(name)
      if (!entry) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return {
        ...entry,
        isDirectory: () => entry.type === undefined || entry.type === "directory",
        isSymbolicLink: () => entry.type === "symlink",
      }
    },
    realpathSync: (name) => dirs.get(name)?.realpath ?? name,
    mkdirSync(name, options) {
      if (dirs.has(name)) throw Object.assign(new Error("exists"), { code: "EEXIST" })
      created.push({ name, ...options })
      dirs.set(name, { uid: 501, mode: options.mode })
    },
  }
}

const identity = {
  id: "a".repeat(64), root: "/home/" + "long-home-".repeat(30),
  user: { uid: 501, username: "alice" }, protocol_version: 1,
  lexical_contract: { schema: 1 }, semantic_contract: { mode: "background" },
}

for (const platform of ["linux", "darwin"]) {
  test(`${platform}: long home and metadata paths do not lengthen the private endpoint`, () => {
    const fs = filesystem()
    const options = { identity, platform, uid: 501, env: {}, fs }
    const endpoint = endpoints.deriveControllerEndpoint(options)
    assert.match(endpoint, /^\/tmp\/desk-readiness-501\/[a-f0-9]{32}\.sock$/u)
    assert.ok(Buffer.byteLength(endpoint) < 104)
    assert.equal(endpoints.deriveControllerEndpoint(options), endpoint)
    assert.deepEqual(fs.created, [{ name: "/tmp/desk-readiness-501", mode: 0o700 }])
  })
}

test("short, private XDG_RUNTIME_DIR is preferred without creating a fallback directory", () => {
  const fs = filesystem({ "/run/user/501": { uid: 501, mode: 0o700 } })
  const endpoint = endpoints.deriveControllerEndpoint({
    identity, platform: "linux", uid: 501, env: { XDG_RUNTIME_DIR: "/run/user/501" }, fs,
  })
  assert.match(endpoint, /^\/run\/user\/501\/[a-f0-9]{32}\.sock$/u)
  assert.deepEqual(fs.created, [])
})

for (const parent of [{ uid: 0, mode: 0o777 }, { uid: 502, mode: 0o755 }]) {
  test(`private XDG leaf below an unsafe ancestor is not usable: ${JSON.stringify(parent)}`, () => {
    const endpoint = endpoints.deriveControllerEndpoint({
      identity, platform: "linux", uid: 501, env: { XDG_RUNTIME_DIR: "/unsafe/runtime" },
      fs: filesystem({
        "/unsafe": parent, "/unsafe/runtime": { uid: 501, mode: 0o700 },
      }),
    })
    assert.match(endpoint, /^\/tmp\/desk-readiness-501\//u)
  })
}

test("macOS canonical short temp root remains bounded", () => {
  const fs = filesystem({
    "/tmp": { uid: 0, mode: 0o1777, realpath: "/private/tmp" },
    "/private": { uid: 0, mode: 0o755 },
    "/private/tmp": { uid: 0, mode: 0o1777 },
  })
  const endpoint = endpoints.deriveControllerEndpoint({ identity, platform: "darwin", uid: 501, env: {}, fs })
  assert.match(endpoint, /^\/private\/tmp\/desk-readiness-501\/[a-f0-9]{32}\.sock$/u)
  assert.ok(Buffer.byteLength(endpoint) <= 100)
})

for (const entry of [
  { uid: 502, mode: 0o700 }, { uid: 501, mode: 0o755 },
  { uid: 501, mode: 0o770 }, { uid: 501, mode: 0o700, type: "symlink" },
  { uid: 501, mode: 0o700, type: "file" },
  { uid: 501, mode: 0o700, realpath: "/" + "x".repeat(100) },
]) {
  test(`unsafe or long XDG directory falls back: ${JSON.stringify(entry)}`, () => {
    const endpoint = endpoints.deriveControllerEndpoint({
      identity, platform: "darwin", uid: 501, env: { XDG_RUNTIME_DIR: "/run/user/501" },
      fs: filesystem({ "/run/user/501": entry }),
    })
    assert.match(endpoint, /^\/tmp\/desk-readiness-501\//u)
  })
}

for (const runtimeDir of ["relative", "/absent", "/" + "x".repeat(200)]) {
  test(`unusable XDG path falls back: ${runtimeDir.slice(0, 20)}`, () => {
    assert.match(endpoints.deriveControllerEndpoint({
      identity, platform: "linux", uid: 501, env: { XDG_RUNTIME_DIR: runtimeDir }, fs: filesystem(),
    }), /^\/tmp\/desk-readiness-501\//u)
  })
}

for (const entry of [
  { uid: 502, mode: 0o700 }, { uid: 501, mode: 0o755 },
  { uid: 501, mode: 0o700, type: "symlink" }, { uid: 501, mode: 0o700, type: "file" },
]) {
  test(`unsafe pre-existing fallback fails closed: ${JSON.stringify(entry)}`, () => {
    assert.throws(() => endpoints.deriveControllerEndpoint({
      identity, platform: "linux", uid: 501, env: {},
      fs: filesystem({ "/tmp/desk-readiness-501": entry }),
    }), /unsafe.*(directory|ownership|permissions)/u)
  })
}

test("F2 endpoint digest distinguishes lexical identity and OS users without semantic partitioning", () => {
  const derive = (value) => endpoints.deriveControllerEndpoint({
    identity: value, platform: "linux", uid: value.user.uid, env: {},
    fs: filesystem({
      "/tmp/desk-readiness-501": { uid: 501, mode: 0o700 },
      "/tmp/desk-readiness-502": { uid: 502, mode: 0o700 },
    }),
  })
  const cases = [
    identity, { ...identity, id: "a".repeat(63) + "b" },
    { ...identity, root: identity.root + "different" },
    { ...identity, user: { uid: 502, username: "alice" } },
  ]
  assert.equal(new Set(cases.map(derive)).size, cases.length)
  assert.equal(derive(identity), derive({ ...identity, semantic_contract: { mode: "required", endpoints: ["different"] } }))
  assert.match(derive(cases[3]), /^\/tmp\/desk-readiness-502\//u)
  assert.throws(() => endpoints.deriveControllerEndpoint({
    identity, platform: "linux", uid: 502, env: {}, fs: filesystem(),
  }), /ownership/u)
})

test("POSIX endpoint validation measures bytes and rejects NUL, relative and overlong paths", () => {
  for (const platform of ["linux", "darwin"]) {
    endpoints.validateControllerEndpoint("/" + "a".repeat(99), platform)
    for (const value of ["/" + "a".repeat(100), "/" + "\u00e9".repeat(50), "/tmp/a\0b", "relative"]) {
      assert.throws(() => endpoints.validateControllerEndpoint(value, platform), /endpoint/u)
    }
  }
})

test("Windows named pipe derivation is unchanged and does not touch POSIX directories", () => {
  assert.equal(endpoints.deriveControllerEndpoint({
    identity, platform: "win32", fs: {},
  }), `\\\\.\\pipe\\desk-readiness-alice-${identity.id}`)
})

test("controller close preserves unrelated metadata files", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-endpoint-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stateHome = path.join(root, "state")
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  const sentinel = path.join(stateHome, client.id, "unowned.txt")
  writeFileSync(sentinel, "keep")
  await client.close()
  assert.equal(readFileSync(sentinel, "utf8"), "keep")
  assert.equal(existsSync(path.join(stateHome, client.id, "owner.json")), false)
})

test("real POSIX controller listens with long metadata home and removes only its socket", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-endpoint-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stateHome = path.join(root, "long-home-".repeat(20))
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  t.after(() => client.close())
  const endpoint = endpoints.deriveControllerEndpoint({ identity: client.identity })
  assert.ok(Buffer.byteLength(endpoint) <= 100)
  assert.equal(lstatSync(path.dirname(endpoint)).mode & 0o777, 0o700)
  assert.equal(lstatSync(endpoint).uid, process.getuid())
  assert.equal(lstatSync(endpoint).isSocket(), true)
  assert.equal((await client.status()).state, "CONTROL_READY")
  assert.deepEqual(JSON.parse(readFileSync(path.join(stateHome, client.id, "owner.json"))).identity, client.identity)
  await client.close()
  assert.equal(existsSync(endpoint), false)
})

test("real POSIX listener refuses a caller-supplied overlong endpoint before metadata publication", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-endpoint-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await assert.rejects(startReadinessController({
    identity, endpoint: path.join(root, "x".repeat(110)), stateDir: path.join(root, "state"),
  }), /endpoint/u)
  assert.equal(existsSync(path.join(root, "state", "owner.json")), false)
})

for (const kind of ["file", "unidentified socket", "owned socket"]) {
  test(`POSIX election reclaims only a positively identified dead-owner socket: ${kind}`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "desk-reclaim-"))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const stateHome = path.join(root, "state")
    const controllerIdentity = endpoints.controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
    const endpoint = endpoints.deriveControllerEndpoint({ identity: controllerIdentity })
    t.after(() => rmSync(endpoint, { force: true }))
    const stateDir = path.join(stateHome, controllerIdentity.id)
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      kind === "file"
        ? "process.exit(0)"
        : "import net from 'node:net'; net.createServer().listen(process.argv[1], () => process.exit(0))",
      endpoint,
    ], { encoding: "utf8" })
    assert.equal(child.status, 0, child.stderr)
    if (kind === "file") writeFileSync(endpoint, "not a socket")
    const stat = lstatSync(endpoint)
    writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({
      identity: controllerIdentity, endpoint,
      socket: { dev: stat.dev, ino: kind === "unidentified socket" ? stat.ino + 1 : stat.ino },
      owner: { pid: child.pid, token: "old-token" },
    }))
    const connecting = connectOrStartController({ root, stateHome, ephemeral: true })
    if (kind === "owned socket") {
      const client = await connecting
      try {
        assert.equal((await client.status()).state, "CONTROL_READY")
        assert.notEqual((await client.status()).owner.pid, child.pid)
      } finally {
        await client.close()
      }
    } else {
      let unexpectedClient
      try {
        await assert.rejects(async () => { unexpectedClient = await connecting }, /election|EADDRINUSE/u)
        assert.equal(lstatSync(endpoint).ino, stat.ino)
        if (kind === "file") assert.equal(readFileSync(endpoint, "utf8"), "not a socket")
      } finally {
        await unexpectedClient?.close()
      }
    }
  })
}
