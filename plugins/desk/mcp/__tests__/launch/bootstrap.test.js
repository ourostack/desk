// Desk's cross-platform MCP bootstrap (mcp/bootstrap.cjs).
//
// The bootstrap is what both host MCP configs run with whatever `node` the host has. It must parse and run on very old Node, find the best installed Node (preferring one whose ABI has a Desk runtime pack), run index.js in that Node, and, when no compatible Node exists, serve the MCP handshake itself with degraded:node_missing and an install command for this machine.
//
// In-process tests load the bootstrap with `require` and inject the platform, environment, probe, spawn and streams, so every branch (including the Windows layouts) is measured on any host. Spawned tests run it under real Node releases with a temporary HOME. Tests named "native:" also run in the Windows CI job.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { pathToFileURL } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import {
  bootstrapPath,
  indexPath,
  installedNodesByMajor,
  isolatedEnv,
  makeIsolatedHome,
  mcpRoot,
  runHandshake,
  toolPayload,
} from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const bootstrap = require(bootstrapPath)
const { TOOL_NAMES } = await import(pathToFileURL(path.join(mcpRoot, "src", "tool-names.js")).href)
const packageJson = JSON.parse(readFileSync(path.join(mcpRoot, "package.json"), "utf8"))
const nodes = installedNodesByMajor()
// A fresh Windows CI runner restores the runtime pack into an empty cache on first start (7 to 11 s observed), so Windows gets 15 s, half the hosts' 30 s MCP startup timeout, instead of 3 s. A2 moves that restore after the handshake.
const HANDSHAKE_BUDGET_MS = process.platform === "win32" ? 15000 : 3000

// ---- fixtures ----

/** A fake `node` (a POSIX sh script, whatever its name) that answers the bootstrap's probe and, when run, prints its label and arguments. */
function fakeNode(file, version, abi, { label = file, broken = false, exitCode = 0 } = {}) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, [
    "#!/bin/sh",
    `if [ "$1" = "-e" ]; then ${broken ? "exit 1" : `printf 'v${version} ${abi}'; exit 0`}; fi`,
    `printf 'ran %s' ${JSON.stringify(label)}`,
    `for arg in "$@"; do printf ' [%s]' "$arg"; done`,
    "printf '\\n'",
    `exit ${exitCode}`,
    "",
  ].join("\n"))
  chmodSync(file, 0o755)
  return file
}

/** Options for selectNode on a fixture machine: nothing from this host is visible. */
function machine(root, overrides = {}) {
  return {
    env: { PATH: "" },
    platform: "darwin",
    arch: "arm64",
    homeDir: path.join(root, "home"),
    mcpRoot,
    current: { path: path.join(root, "current", "node"), version: "v16.20.2", abi: "93" },
    systemPrefix: path.join(root, "sysroot"),
    ...overrides,
  }
}

function collect(output) {
  const chunks = []
  output.on("data", (chunk) => chunks.push(chunk))
  return () => Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

// ---- it must run on very old Node ----

test("the bootstrap uses only syntax and built-ins that Node 8 has", () => {
  const source = readFileSync(bootstrapPath, "utf8")
  // Strings first (one holds a URL), then comments.
  const code = source.replace(/"(?:[^"\\]|\\.)*"/gu, "\"\"").replace(/\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "")
  for (const [name, pattern] of [
    ["arrow functions", /=>/u],
    ["template literals", /`/u],
    ["const or let", /\b(?:const|let)\s/u],
    ["optional chaining or nullish coalescing", /\?\.|\?\?/u],
    ["spread or rest", /\.\.\./u],
    ["classes", /\bclass\s/u],
    ["async functions", /\basync\s|\bawait\s/u],
    ["structuredClone", /structuredClone/u],
    ["destructuring", /\b(?:var)\s*[{[]/u],
  ]) {
    assert.doesNotMatch(code, pattern, `bootstrap.cjs must not use ${name}`)
  }
  const modules = [...source.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1]).sort()
  assert.deepEqual([...new Set(modules)], ["child_process", "fs", "os", "path", "url"])
  assert.match(source, /Known limit: .*no `node` executable at all/u)
})

for (const major of [16, 20, 22, 24]) {
  test(`the bootstrap loads and exports its API on Node ${major}`, {
    skip: nodes.has(major) ? false : `no Node ${major} is installed here`,
  }, () => {
    const result = spawnSync(nodes.get(major).executable, ["-e", `var b = require(${JSON.stringify(bootstrapPath)}); process.stdout.write(typeof b.run + " " + b.satisfies("22.1.0", ">=20"))`], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", NODE_OPTIONS: "" },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, "function true")
  })
}

// ---- engines range and package metadata ----

const rangeCases = [
  [">=20.0.0", "16.20.2", false], [">=20.0.0", "20.0.0", true], [">= 20", "20.1.0", true], [">= 20", "19.9.9", false],
  ["^20 || ^22", "22.1.0", true], ["^20 || ^22", "21.9.0", false], ["^20 || ^22", "23.0.0", false],
  ["~20.1", "20.1.9", true], ["~20.1", "20.2.0", false], ["~20.1.3", "20.1.4", true], ["~20.1.3", "20.1.2", false],
  [">=20 <23", "22.9.9", true], [">=20 <23", "23.0.0", false], [">20", "20.9.0", false], [">20", "21.0.0", true],
  [">20.1.0", "20.1.1", true], [">20.1.0", "20.1.0", false], ["<=22", "22.9.0", true], ["<=22", "23.0.0", false],
  ["<=22.1.0", "22.1.0", true], ["<=22.1.0", "22.1.1", false], ["<22", "21.9.9", true], ["<22", "22.0.0", false],
  ["22.3.1", "22.3.1", true], ["22.3.1", "22.3.0", false], ["=22", "22.8.0", true], ["=22", "23.0.0", false],
  ["22.x", "22.8.0", true], ["22.x", "23.0.0", false], ["v22.3", "22.3.5", true], ["v22.3", "22.4.0", false],
  ["^0.2.3", "0.2.9", true], ["^0.2.3", "0.3.0", false], ["^0.0.3", "0.0.3", true], ["^0.0.3", "0.0.4", false],
  ["^0.2", "0.2.9", true], ["^0.2", "0.3.0", false], ["*", "16.0.0", true], ["", "16.0.0", true], ["x", "1.0.0", true],
  [">=20.0.0", "20.10.0", true], [">=20.9.0", "20.10.0", true], ["latest", "22.0.0", false], [">=26", "25.9.9", false],
  [">*", "22.0.0", false], [">=20.0.0", "not-a-version", false], ["~20", "20.9.0", true], ["~20", "21.0.0", false],
  ["^0", "0.9.0", true], ["^0", "1.0.0", false], ["^0.0", "0.0.5", true], ["^0.0", "0.1.0", false],
  ["=*", "1.0.0", true], [">=*", "1.0.0", true], ["<=*", "1.0.0", true], ["<*", "1.0.0", false],
]

test("engines ranges follow npm semver for plain majors, minors and patches", () => {
  for (const [range, version, expected] of rangeCases) {
    assert.equal(bootstrap.satisfies(version, range), expected, `${JSON.stringify(range)} vs ${version}`)
  }
  assert.equal(bootstrap.satisfies("v22.1.0", ">=20"), true)
})

test("the bootstrap reads engines.node and the runtime pack ABIs from the same files index.js uses", async () => {
  assert.deepEqual(bootstrap.readPackage(mcpRoot), { range: packageJson.engines.node, version: packageJson.version })
  const root = await mkTempRoot("desk-bootstrap-package-")
  assert.deepEqual(bootstrap.readPackage(root), { range: ">=20.0.0", version: null })
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9", engines: {} }))
  assert.deepEqual(bootstrap.readPackage(root), { range: ">=20.0.0", version: "9.9.9" })

  const matrix = JSON.parse(readFileSync(path.join(mcpRoot, "artifacts", "runtime-deps", packageJson.version, "support-matrix.json"), "utf8"))
  for (const target of matrix.targets) {
    assert.deepEqual(bootstrap.packAbis(mcpRoot, packageJson.version, target.platform, target.arch), [String(target.node_abi)])
  }
  assert.deepEqual(bootstrap.packAbis(mcpRoot, packageJson.version, "sunos", "sparc"), [])
  assert.deepEqual(bootstrap.packAbis(mcpRoot, null, "darwin", "arm64"), [])
  assert.deepEqual(bootstrap.packAbis(root, "9.9.9", "darwin", "arm64"), [])
  mkdirSync(path.join(root, "artifacts", "runtime-deps", "9.9.9"), { recursive: true })
  writeFileSync(path.join(root, "artifacts", "runtime-deps", "9.9.9", "support-matrix.json"), JSON.stringify({ targets: "none" }))
  assert.deepEqual(bootstrap.packAbis(root, "9.9.9", "darwin", "arm64"), [])
  // A corrupt matrix with null or foreign entries still yields the good ones.
  writeFileSync(path.join(root, "artifacts", "runtime-deps", "9.9.9", "support-matrix.json"), JSON.stringify({ targets: [null, 7, { platform: "darwin", arch: "arm64", node_abi: 127 }, { platform: "darwin", arch: "arm64", node_abi: "127" }] }))
  assert.deepEqual(bootstrap.packAbis(root, "9.9.9", "darwin", "arm64"), ["127"])
})

// ---- discovery ----

test("POSIX discovery covers PATH, nvm, fnm, Volta, asdf, mise, Homebrew and the system", async () => {
  const root = await mkTempRoot("desk-bootstrap-posix-")
  const home = path.join(root, "home")
  const prefix = path.join(root, "sysroot")
  const expected = [
    fakeNode(path.join(root, "path-bin", "node"), "16.20.2", "93"),
    fakeNode(path.join(home, ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0", "127"),
    fakeNode(path.join(root, "custom-fnm", "node-versions", "v22.9.1", "installation", "bin", "node"), "22.9.1", "127"),
    fakeNode(path.join(home, ".local", "share", "fnm", "node-versions", "v22.9.2", "installation", "bin", "node"), "22.9.2", "127"),
    fakeNode(path.join(home, "Library", "Application Support", "fnm", "node-versions", "v22.9.3", "installation", "bin", "node"), "22.9.3", "127"),
    fakeNode(path.join(home, ".fnm", "node-versions", "v22.9.4", "installation", "bin", "node"), "22.9.4", "127"),
    fakeNode(path.join(home, ".volta", "tools", "image", "node", "22.9.5", "bin", "node"), "22.9.5", "127"),
    fakeNode(path.join(home, ".asdf", "installs", "nodejs", "22.9.6", "bin", "node"), "22.9.6", "127"),
    fakeNode(path.join(home, ".local", "share", "mise", "installs", "node", "22.9.7", "bin", "node"), "22.9.7", "127"),
    fakeNode(path.join(prefix, "opt", "homebrew", "bin", "node"), "22.9.8", "127"),
    fakeNode(path.join(prefix, "usr", "local", "bin", "node"), "22.9.9", "127"),
    fakeNode(path.join(prefix, "opt", "homebrew", "opt", "node@22", "bin", "node"), "22.10.0", "127"),
    fakeNode(path.join(prefix, "usr", "local", "opt", "node@20", "bin", "node"), "20.10.0", "115"),
    fakeNode(path.join(prefix, "usr", "bin", "node"), "20.11.0", "115"),
  ]
  // Another Homebrew formula is not Node.
  fakeNode(path.join(prefix, "opt", "homebrew", "opt", "openssl@3", "bin", "node"), "22.0.0", "127")
  // Not executable, and a directory named node: both ignored.
  writeFileSync(path.join(home, ".nvm", "versions", "node", "v22.9.0", "bin", "npm"), "")
  mkdirSync(path.join(home, ".nvm", "versions", "node", "v99.0.0", "bin", "node"), { recursive: true })
  const plain = path.join(home, ".volta", "tools", "image", "node", "25.0.0", "bin", "node")
  mkdirSync(path.dirname(plain), { recursive: true })
  writeFileSync(plain, "")
  const found = bootstrap.candidatePaths({
    env: { PATH: [path.join(root, "path-bin"), "", path.join(root, "missing")].join(":"), FNM_DIR: path.join(root, "custom-fnm") },
    platform: "darwin",
    homeDir: home,
    systemPrefix: prefix,
  })
  assert.deepEqual(found, expected)

  // Each manager's own override variable wins over its default folder.
  const custom = {
    NVM_DIR: path.join(root, "o-nvm"),
    VOLTA_HOME: path.join(root, "o-volta"),
    ASDF_DATA_DIR: path.join(root, "o-asdf"),
    MISE_DATA_DIR: path.join(root, "o-mise"),
    XDG_DATA_HOME: path.join(root, "o-xdg"),
  }
  const overridden = [
    fakeNode(path.join(custom.NVM_DIR, "versions", "node", "v22.1.0", "bin", "node"), "22.1.0", "127"),
    fakeNode(path.join(custom.XDG_DATA_HOME, "fnm", "node-versions", "v22.1.1", "installation", "bin", "node"), "22.1.1", "127"),
    fakeNode(path.join(custom.VOLTA_HOME, "tools", "image", "node", "22.1.2", "bin", "node"), "22.1.2", "127"),
    fakeNode(path.join(custom.ASDF_DATA_DIR, "installs", "nodejs", "22.1.3", "bin", "node"), "22.1.3", "127"),
    fakeNode(path.join(custom.MISE_DATA_DIR, "installs", "node", "22.1.4", "bin", "node"), "22.1.4", "127"),
  ]
  const foundCustom = bootstrap.candidatePaths({ env: custom, platform: "linux", homeDir: path.join(root, "nobody"), systemPrefix: path.join(root, "none") })
  assert.deepEqual(foundCustom, overridden)
  assert.deepEqual(bootstrap.candidatePaths({ env: {}, platform: "linux", homeDir: "", systemPrefix: path.join(root, "none") }), [])
})

test("Windows discovery covers PATH, nvm-windows, fnm, Volta, mise and Program Files", async () => {
  const root = await mkTempRoot("desk-bootstrap-windows-")
  const appData = path.join(root, "AppData", "Roaming")
  const localAppData = path.join(root, "AppData", "Local")
  const programFiles = path.join(root, "Program Files")
  const programFilesX86 = path.join(root, "Program Files (x86)")
  const installed = path.join(appData, "fnm", "node-versions", "v24.2.0", "installation", "node.exe")
  const expected = [
    fakeNode(path.join(root, "bin one", "node.exe"), "16.20.2", "93"),
    fakeNode(path.join(root, "nvm-home", "v22.9.0", "node.exe"), "22.9.0", "127"),
    fakeNode(path.join(appData, "nvm", "v22.9.1", "node.exe"), "22.9.1", "127"),
    fakeNode(path.join(root, "nvm-symlink", "node.exe"), "24.1.0", "137"),
    fakeNode(path.join(root, "fnm-dir", "node-versions", "v24.1.1", "installation", "node.exe"), "24.1.1", "137"),
    fakeNode(installed, "24.2.0", "137"),
    fakeNode(path.join(localAppData, "fnm", "node-versions", "v24.2.1", "installation", "node.exe"), "24.2.1", "137"),
  ]
  // fnm's per-shell folders are links into node-versions; they are listed too, and deduplicated by real path later.
  mkdirSync(path.join(localAppData, "fnm_multishells"), { recursive: true })
  symlinkSync(path.dirname(installed), path.join(localAppData, "fnm_multishells", "123_456"))
  expected.push(path.join(localAppData, "fnm_multishells", "123_456", "node.exe"))
  expected.push(
    fakeNode(path.join(localAppData, "Volta", "tools", "image", "node", "24.3.0", "node.exe"), "24.3.0", "137"),
    fakeNode(path.join(localAppData, "mise", "installs", "node", "24.3.1", "node.exe"), "24.3.1", "137"),
    fakeNode(path.join(programFiles, "nodejs", "node.exe"), "24.4.0", "137"),
    fakeNode(path.join(programFilesX86, "nodejs", "node.exe"), "22.4.0", "127"),
  )
  const env = {
    PATH: [path.join(root, "bin one"), path.join(root, "missing")].join(";"),
    NVM_HOME: path.join(root, "nvm-home"),
    NVM_SYMLINK: path.join(root, "nvm-symlink"),
    FNM_DIR: path.join(root, "fnm-dir"),
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    ProgramFiles: programFiles,
    "ProgramFiles(x86)": programFilesX86,
  }
  const found = bootstrap.candidatePaths({ env, platform: "win32", homeDir: path.join(root, "profile") })
  assert.deepEqual(found, expected)

  // A Windows machine with none of those variables set still looks in the default Program Files.
  assert.deepEqual(bootstrap.candidatePaths({ env: {}, platform: "win32", homeDir: "" }).filter((file) => !file.startsWith("C:")), [])
})

test("on a fake Windows layout the bootstrap picks the packed Node, not the newest one", async () => {
  const root = await mkTempRoot("desk-bootstrap-windows-pick-")
  const appData = path.join(root, "AppData", "Roaming")
  fakeNode(path.join(appData, "nvm", "v25.1.0", "node.exe"), "25.1.0", "141")
  const packed = fakeNode(path.join(appData, "nvm", "v24.9.0", "node.exe"), "24.9.0", "137")
  fakeNode(path.join(appData, "nvm", "v22.9.0", "node.exe"), "22.9.0", "127")
  const selection = bootstrap.selectNode(machine(root, {
    platform: "win32",
    arch: "x64",
    env: { APPDATA: appData, PATH: "" },
  }))
  assert.deepEqual(selection.packAbis, ["137"])
  assert.equal(selection.node.path, packed)
  assert.equal(selection.node.version, "24.9.0")
})

// ---- selection ----

test("selection prefers the newest Node whose ABI has a runtime pack, then the newest compatible one", async () => {
  const root = await mkTempRoot("desk-bootstrap-select-")
  const home = path.join(root, "home")
  const nvm = (version) => path.join(home, ".nvm", "versions", "node", `v${version}`, "bin", "node")
  fakeNode(nvm("24.1.0"), "24.1.0", "137")
  const packed = fakeNode(nvm("22.9.0"), "22.9.0", "127")
  fakeNode(nvm("22.10.0"), "22.10.0", "127", { broken: true })
  fakeNode(nvm("20.11.1"), "20.11.1", "115")
  let selection = bootstrap.selectNode(machine(root))
  assert.equal(selection.range, packageJson.engines.node)
  assert.deepEqual(selection.packAbis, ["127"])
  assert.equal(selection.node.path, packed, "a broken 22.10.0 is skipped; 22.9.0 has a pack; 24.1.0 does not")

  // No packed ABI installed: the newest compatible Node.
  selection = bootstrap.selectNode(machine(root, { arch: "x64", platform: "sunos" }))
  assert.equal(selection.node.path, nvm("24.1.0"))

  // A major the bootstrap has no ABI for, and a path with no version, are asked.
  const unknown = fakeNode(path.join(root, "path-bin", "node"), "26.0.0", "127")
  selection = bootstrap.selectNode(machine(root, { env: { PATH: path.join(root, "path-bin") } }))
  assert.equal(selection.node.path, unknown)
  assert.equal(selection.node.abi, "127")
})

test("selection keeps the running Node on a tie and never probes it", async () => {
  const root = await mkTempRoot("desk-bootstrap-current-")
  fakeNode(path.join(root, "home", ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0", "127")
  const probed = []
  const selection = bootstrap.selectNode(machine(root, {
    current: { path: "/running/node", version: "v22.9.0", abi: "127" },
    probe: (file) => { probed.push(file); return null },
  }))
  assert.equal(selection.node.current, true)
  assert.equal(selection.node.path, "/running/node")
  assert.deepEqual(probed, [])
})

test("the same binary reached through two paths is considered once, and a probe that fails drops it", async () => {
  const root = await mkTempRoot("desk-bootstrap-dedupe-")
  const real = fakeNode(path.join(root, "home", ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0", "127")
  mkdirSync(path.join(root, "link-bin"))
  symlinkSync(real, path.join(root, "link-bin", "node"))
  fakeNode(path.join(root, "odd-bin", "node"), "x", "y")
  const probes = []
  const selection = bootstrap.selectNode(machine(root, {
    env: { PATH: [path.join(root, "link-bin"), path.join(root, "odd-bin")].join(":") },
    probe: (file, timeoutMs) => { probes.push(file); assert.ok(timeoutMs > 0 && timeoutMs <= 3000); return bootstrap.probeNode(file, {}, timeoutMs) },
  }))
  assert.equal(selection.node.path, path.join(root, "link-bin", "node"))
  assert.deepEqual(probes, [path.join(root, "odd-bin", "node"), path.join(root, "link-bin", "node")])
  assert.equal(bootstrap.probeNode(path.join(root, "missing-node"), {}, 1000), null)
})

test("no compatible Node gives no selection", async () => {
  const root = await mkTempRoot("desk-bootstrap-none-")
  fakeNode(path.join(root, "home", ".nvm", "versions", "node", "v18.20.4", "bin", "node"), "18.20.4", "108")
  const selection = bootstrap.selectNode(machine(root))
  assert.equal(selection.node, null)
})

// ---- the install command ----

test("the install command installs the Node major Desk ships a runtime pack for, per platform", async () => {
  const root = await mkTempRoot("desk-bootstrap-fix-")
  const brewBin = path.join(root, "brew-bin")
  fakeNode(path.join(brewBin, "brew"), "0.0.0", "0")
  assert.equal(bootstrap.packedMajor(["127"]), "22")
  assert.equal(bootstrap.packedMajor(["115", "127", "999"]), "22")
  assert.equal(bootstrap.packedMajor(["137"]), "24")
  assert.equal(bootstrap.packedMajor(["999"]), null)
  assert.equal(bootstrap.packedMajor([]), null)

  // Windows: single commands that Windows PowerShell 5.1 accepts, and no `nvm use`.
  const windows = [
    [{ NVM_HOME: "C:\\nvm" }, "24", "nvm install 24"],
    [{ NVM_HOME: "C:\\nvm" }, null, "nvm install lts"],
    [{}, "24", "winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements"],
    [{}, null, "winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements"],
    [{}, "22", "winget install --id OpenJS.NodeJS.22 --exact --accept-source-agreements --accept-package-agreements"],
  ]
  for (const [env, major, expected] of windows) {
    const command = bootstrap.installCommand({ platform: "win32", env, homeDir: root, major })
    assert.equal(command, expected)
    assert.doesNotMatch(command, /&&|nvm use/u)
  }

  // macOS and Linux: an existing nvm first, then Homebrew, then a fresh nvm.
  const nvmDir = path.join(root, "nvm dir")
  mkdirSync(nvmDir)
  writeFileSync(path.join(nvmDir, "nvm.sh"), "# nvm\n")
  assert.equal(bootstrap.installCommand({ platform: "linux", env: { NVM_DIR: nvmDir, PATH: brewBin }, homeDir: root, major: "22" }), `. "${nvmDir}/nvm.sh" && nvm install 22`)
  assert.equal(bootstrap.installCommand({ platform: "darwin", env: { PATH: brewBin }, homeDir: root, major: "22" }), "brew install node@22")
  assert.equal(bootstrap.installCommand({ platform: "darwin", env: { PATH: brewBin }, homeDir: root, major: null }), "brew install node")
  mkdirSync(path.join(root, ".nvm"))
  writeFileSync(path.join(root, ".nvm", "nvm.sh"), "# nvm\n")
  assert.equal(bootstrap.installCommand({ platform: "linux", env: {}, homeDir: root, major: null }), `. "${path.join(root, ".nvm", "nvm.sh")}" && nvm install --lts`)
  assert.match(
    bootstrap.installCommand({ platform: "linux", env: {}, homeDir: path.join(root, "nobody"), major: "22" }),
    /^curl -fsSL https:\/\/raw\.githubusercontent\.com\/nvm-sh\/nvm\/v[0-9.]+\/install\.sh \| bash && \. "\$HOME\/\.nvm\/nvm\.sh" && nvm install 22$/u,
  )
})

// ---- the degraded responder ----

test("with no compatible Node the bootstrap serves the MCP handshake itself and names the fix", async () => {
  const root = await mkTempRoot("desk-bootstrap-responder-")
  const input = new PassThrough()
  const output = new PassThrough()
  const read = collect(output)
  const errors = []
  const running = bootstrap.run({
    ...machine(root),
    args: [],
    stdin: input,
    stdout: output,
    stderr: { write: (text) => errors.push(text) },
  })
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n\nnot json\r\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\r\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "three", method: "tools/list" })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "desk_status", arguments: { id: 9 } } })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "task_create" } })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call" })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "resources/list" })}\n`)
  input.end(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "initialize" }))
  await running
  const [init, parseError, ping, list, status, gated, nameless, unknown, lastInit] = read()
  assert.equal(parseError.error.code, -32700)
  assert.equal(init.result.protocolVersion, "2025-03-26")
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: true } })
  assert.equal(init.result.serverInfo.name, "desk-mcp-bootstrap")
  assert.match(init.result.instructions, /Node\.js/u)
  assert.deepEqual(ping.result, {})
  assert.equal(list.id, "three")
  assert.deepEqual(list.result.tools.map((tool) => tool.name), TOOL_NAMES)
  for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, "object")
  const payload = toolPayload(status)
  assert.equal(status.result.isError, false)
  assert.equal(payload.status, "degraded")
  assert.equal(payload.state, "degraded:node_missing")
  assert.equal(payload.code, "node_missing")
  assert.equal(payload.required_node, packageJson.engines.node)
  assert.equal(payload.running_node, "v16.20.2")
  assert.equal(payload.recommended_node_major, "22")
  assert.match(payload.fix, /nvm install 22|brew install node@22/u)
  assert.match(payload.fix, /^Run `.+` in a shell, then reconnect the Desk MCP server/u)
  assert.equal(gated.result.isError, true)
  assert.deepEqual(toolPayload(gated), payload)
  assert.equal(nameless.result.isError, true)
  assert.equal(unknown.error.code, -32601)
  assert.equal(lastInit.result.protocolVersion, "2025-06-18")
  assert.match(errors.join(""), /no Node satisfies/u)
})

test("the responder stops cleanly when stdin fails", async () => {
  const input = new EventEmitter()
  input.setEncoding = () => {}
  const running = bootstrap.serveDegraded({ stdin: input, stdout: { write() {} }, payload: { summary: "s", fix: "f" } })
  input.emit("error", new Error("closed"))
  await running
})

// ---- running index.js ----

test("when the running Node is the best choice, index.js runs in this process", async () => {
  const root = await mkTempRoot("desk-bootstrap-inprocess-")
  const calls = []
  await bootstrap.run({
    ...machine(root, { current: { path: "/running/node", version: "v22.9.0", abi: "127" } }),
    args: ["--root", "/desk"],
    importIndex: (file, args) => { calls.push([file, args]) },
  })
  assert.deepEqual(calls, [[indexPath, ["--root", "/desk"]]])
})

test("importIndex loads index.js as an ES module and starts it through its entrypoint guard", async () => {
  const root = await mkTempRoot("desk-bootstrap-import-")
  const fixture = path.join(root, "index.js")
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(fixture, [
    "export const calls = []",
    "export async function main(options) { calls.push(['main', options.argv]) }",
    "export function runIfEntrypoint(options) { calls.push(['guard', options.argv[1]]); return options.launch() }",
    "",
  ].join("\n"))
  await bootstrap.importIndex(fixture, ["--x"])
  const loaded = await import(pathToFileURL(fixture).href)
  assert.deepEqual(loaded.calls, [["guard", fixture], ["main", ["--x"]]])
})

test("an index.js that cannot load is served as a degraded state, never a crash", async () => {
  const root = await mkTempRoot("desk-bootstrap-import-fail-")
  const input = new PassThrough()
  const output = new PassThrough()
  const read = collect(output)
  const errors = []
  const running = bootstrap.run({
    ...machine(root, { current: { path: "/running/node", version: "v22.9.0", abi: "127" } }),
    args: [],
    stdin: input,
    stdout: output,
    stderr: { write: (text) => errors.push(text) },
    importIndex: () => Promise.reject(new Error("index.js is broken")),
  })
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desk_status" } })}\n`)
  await running
  const payload = toolPayload(read()[0])
  assert.equal(payload.state, "degraded:bootstrap_failed")
  assert.match(payload.summary, /index\.js is broken/u)
  assert.match(errors.join(""), /could not start index\.js: index\.js is broken/u)

  const stdin = new PassThrough()
  const again = bootstrap.run({
    ...machine(root, { current: { path: "/running/node", version: "v22.9.0", abi: "127" } }),
    args: [],
    stdin,
    stdout: new PassThrough(),
    stderr: { write: (text) => errors.push(text) },
    importIndex: () => Promise.reject("not an Error"),
  })
  stdin.end()
  await again
  assert.match(errors.join(""), /could not start index\.js: not an Error/u)
})

function fakeChild() {
  const child = new EventEmitter()
  child.killed = []
  child.kill = (signal) => { child.killed.push(signal) }
  return child
}

test("another Node runs index.js as a child with inherited stdio, forwarded signals and its exit code", async () => {
  const root = await mkTempRoot("desk-bootstrap-reexec-")
  const chosen = fakeNode(path.join(root, "home", ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0", "127")
  const signals = new EventEmitter()
  const exits = []
  const kills = []
  const spawns = []
  const child = fakeChild()
  bootstrap.run({
    ...machine(root),
    args: ["--root", "/desk"],
    spawn: (file, argv, options) => { spawns.push([file, argv, options.stdio]); return child },
    signals,
    exit: (code) => exits.push(code),
    kill: (pid, signal) => kills.push([pid, signal]),
  })
  assert.deepEqual(spawns, [[chosen, [indexPath, "--root", "/desk"], "inherit"]])
  signals.emit("SIGTERM")
  signals.emit("SIGINT")
  assert.deepEqual(child.killed, ["SIGTERM", "SIGINT"])
  child.emit("exit", 3, null)
  assert.deepEqual(exits, [3])
  assert.equal(signals.listenerCount("SIGTERM"), 0)

  const second = fakeChild()
  bootstrap.run({
    ...machine(root),
    args: [],
    spawn: () => second,
    signals,
    exit: (code) => exits.push(code),
    kill: (pid, signal) => kills.push([pid, signal]),
  })
  second.emit("exit", null, "SIGKILL")
  assert.deepEqual(kills, [[process.pid, "SIGKILL"]])
})

test("a Node that cannot be spawned falls back to the degraded responder", async () => {
  const root = await mkTempRoot("desk-bootstrap-spawn-fail-")
  fakeNode(path.join(root, "home", ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0", "127")
  const child = fakeChild()
  const input = new PassThrough()
  const output = new PassThrough()
  const read = collect(output)
  const errors = []
  const running = bootstrap.run({
    ...machine(root),
    args: [],
    spawn: () => child,
    signals: new EventEmitter(),
    stdin: input,
    stdout: output,
    stderr: { write: (text) => errors.push(text) },
  })
  child.emit("error", new Error("spawn EACCES"))
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desk_status" } })}\n`)
  await running
  const payload = toolPayload(read()[0])
  assert.equal(payload.state, "degraded:node_spawn_failed")
  assert.match(payload.summary, /spawn EACCES/u)
})

test("run() fills every option from the real process when none are given", async () => {
  const calls = []
  await bootstrap.run({
    importIndex: (file, args) => { calls.push([file, args]) },
    env: { PATH: path.dirname(process.execPath), HOME: "/nonexistent", DESK_NODE_SYSTEM_PREFIX: "/nonexistent-prefix" },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], indexPath)
  assert.deepEqual(calls[0][1], process.argv.slice(2))
})

// ---- spawned: real Node releases ----

async function spawnBootstrap(node, fixture, pathDirs) {
  return runHandshake({
    command: node,
    args: [bootstrapPath],
    cwd: fixture.root,
    env: isolatedEnv(fixture, { PATH: [...pathDirs, "/usr/bin", "/bin"].join(":") }),
  })
}

test("Node 16 running the bootstrap starts Desk on a packed Node found on PATH", {
  skip: nodes.has(16) ? false : "no Node 16 is installed here",
}, async () => {
  const fixture = await makeIsolatedHome("desk-bootstrap-16-")
  const result = await spawnBootstrap(nodes.get(16).executable, fixture, [path.dirname(nodes.get(16).executable), path.dirname(process.execPath)])
  assert.ok(result.handshakeMs < HANDSHAKE_BUDGET_MS, `handshake took ${result.handshakeMs} ms; stderr: ${result.stderr}`)
  assert.equal(result.initialize.result.serverInfo.name, "desk-mcp")
  assert.deepEqual(result.tools.result.tools.map((tool) => tool.name), TOOL_NAMES)
  assert.equal(result.status.result.isError, undefined, JSON.stringify(result.status))
})

test("Node 16 alone gets the bootstrap's own degraded:node_missing handshake", {
  skip: nodes.has(16) ? false : "no Node 16 is installed here",
}, async () => {
  const fixture = await makeIsolatedHome("desk-bootstrap-16-alone-")
  const result = await spawnBootstrap(nodes.get(16).executable, fixture, [path.dirname(nodes.get(16).executable)])
  assert.ok(result.handshakeMs < HANDSHAKE_BUDGET_MS, `handshake took ${result.handshakeMs} ms; stderr: ${result.stderr}`)
  assert.equal(result.initialize.result.serverInfo.name, "desk-mcp-bootstrap")
  assert.deepEqual(result.tools.result.tools.map((tool) => tool.name), TOOL_NAMES)
  assert.equal(toolPayload(result.status).state, "degraded:node_missing")
  assert.match(result.stderr, /no Node satisfies/u)
})

for (const major of [20, 24]) {
  test(`Node ${major} running the bootstrap starts Desk in one hop`, {
    skip: nodes.has(major) ? false : `no Node ${major} is installed here`,
  }, async () => {
    const fixture = await makeIsolatedHome(`desk-bootstrap-${major}-`)
    const result = await spawnBootstrap(nodes.get(major).executable, fixture, [path.dirname(nodes.get(major).executable), path.dirname(process.execPath)])
    assert.ok(result.handshakeMs < HANDSHAKE_BUDGET_MS, `handshake took ${result.handshakeMs} ms; stderr: ${result.stderr}`)
    assert.equal(result.initialize.result.serverInfo.name, "desk-mcp")
    assert.equal(result.status.result.isError, undefined, JSON.stringify(result.status))
  })
}

test("the bootstrap passes the chosen Node's exit code through", {
  skip: process.platform === "win32" ? "fake nodes are POSIX shell scripts" : false,
}, async () => {
  const root = await mkTempRoot("desk-bootstrap-exit-")
  const mcp = path.join(root, "mcp")
  mkdirSync(mcp)
  copyFileSync(bootstrapPath, path.join(mcp, "bootstrap.cjs"))
  writeFileSync(path.join(mcp, "package.json"), JSON.stringify({ version: "0.0.0", engines: { node: ">=30" } }))
  fakeNode(path.join(root, "home", ".nvm", "versions", "node", "v30.1.0", "bin", "node"), "30.1.0", "999", { label: "nvm-v30", exitCode: 7 })
  const result = spawnSync(process.execPath, [path.join(mcp, "bootstrap.cjs"), "--root", "a b"], {
    encoding: "utf8",
    env: { HOME: path.join(root, "home"), PATH: "/usr/bin:/bin", DESK_NODE_SYSTEM_PREFIX: path.join(root, "none"), NODE_OPTIONS: "" },
  })
  assert.equal(result.status, 7, result.stderr)
  assert.equal(result.stdout, `ran nvm-v30 [${path.join(mcp, "index.js")}] [--root] [a b]\n`)
})

test("native: the bootstrap completes the MCP handshake on this host", async (t) => {
  const fixture = await makeIsolatedHome("desk-bootstrap-native-")
  // The host's PATH stays visible so that an older Node started by the host (CI runs this under Node 20 on Windows too) can find the packed one; HOME and the per-user folders are still temporary.
  const hostPath = process.platform === "win32" ? `${path.dirname(process.execPath)};${process.env.PATH ?? process.env.Path ?? ""}` : `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`
  const env = isolatedEnv(fixture, { PATH: hostPath })
  const result = await runHandshake({ command: process.execPath, args: [bootstrapPath], cwd: fixture.root, env, timeoutMs: 60000 })
  const packed = bootstrap.packAbis(mcpRoot, packageJson.version, process.platform, process.arch).includes(process.versions.modules)
  t.diagnostic(`${process.platform} ${process.version} (${packed ? "packed, in-process" : "no pack, re-exec"}): handshake in ${result.handshakeMs} ms`)
  assert.equal(result.initialize.result.serverInfo.name, "desk-mcp", result.stderr)
  assert.ok(result.handshakeMs < HANDSHAKE_BUDGET_MS, `handshake took ${result.handshakeMs} ms; stderr: ${result.stderr}`)
  assert.deepEqual(result.tools.result.tools.map((tool) => tool.name), TOOL_NAMES)
  assert.equal(result.status.result.isError, undefined, JSON.stringify(result.status))
})

// ---- every Desk MCP entry point goes through the bootstrap ----

const pluginRoot = path.resolve(mcpRoot, "..")

test("the Claude and Copilot MCP configs launch node with the bootstrap", () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.desk
  assert.equal(claude.command, "node")
  assert.equal(claude.args[0], "-e")
  // Claude Code expands ${VAR} in args; the inline launcher must not contain that form, and it must parse on very old Node too.
  assert.doesNotMatch(claude.args[1], /\$\{|=>|`|\?\.|\blet\s|\bconst\s/u)
  assert.deepEqual(claude.env, { DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" })
  const copilot = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.copilot.json"), "utf8")).mcpServers.desk
  assert.equal(copilot.command, "node")
  assert.deepEqual(copilot.args, ["${COPILOT_PLUGIN_ROOT}/mcp/bootstrap.cjs"])
})

test("the Claude inline launcher finds the plugin through DESK_PLUGIN_ROOT or the working directory", {
  skip: process.platform === "win32" ? "fake nodes are POSIX shell scripts" : false,
}, async () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.desk
  const root = await mkTempRoot("desk-bootstrap-claude-")
  const plugin = path.join(root, "plugin")
  mkdirSync(path.join(plugin, "mcp"), { recursive: true })
  copyFileSync(bootstrapPath, path.join(plugin, "mcp", "bootstrap.cjs"))
  writeFileSync(path.join(plugin, "mcp", "package.json"), JSON.stringify({ version: "0.0.0", engines: { node: ">=30" } }))
  fakeNode(path.join(root, "home", ".nvm", "versions", "node", "v30.1.0", "bin", "node"), "30.1.0", "999", { label: "nvm-v30" })
  const env = { HOME: path.join(root, "home"), PATH: "/usr/bin:/bin", DESK_NODE_SYSTEM_PREFIX: path.join(root, "none"), NODE_OPTIONS: "" }
  const expected = `ran nvm-v30 [${path.join(plugin, "mcp", "index.js")}]\n`
  const viaEnv = spawnSync(process.execPath, claude.args, { cwd: root, encoding: "utf8", env: { ...env, DESK_PLUGIN_ROOT: plugin } })
  assert.equal(viaEnv.stdout, expected, viaEnv.stderr)
  const viaCwd = spawnSync(process.execPath, claude.args, { cwd: plugin, encoding: "utf8", env: { ...env, DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" } })
  assert.equal(viaCwd.stdout.replace(realpathSync(plugin), plugin), expected, viaCwd.stderr)
})

for (const major of [16, 22]) {
  test(`the Claude inline launcher still completes a handshake on Node ${major} when it cannot find the plugin`, {
    skip: nodes.has(major) ? false : `no Node ${major} is installed here`,
  }, async () => {
    const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.desk
    const cwd = await mkTempRoot("desk-no-plugin-cwd-")
    const result = spawnSync(nodes.get(major).executable, claude.args, {
      cwd,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}", NODE_OPTIONS: "" },
      input: [
        { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } }, jsonrpc: "2.0", id: 0 },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { method: "ping", jsonrpc: "2.0", id: 1 },
        { method: "tools/list", jsonrpc: "2.0", id: 2 },
        { method: "tools/call", params: { name: "desk_status", arguments: {} }, jsonrpc: "2.0", id: 3 },
        { method: "prompts/list", jsonrpc: "2.0", id: "p" },
        { method: "initialize", jsonrpc: "2.0", id: 4 },
      ].map((message) => JSON.stringify(message)).join("\n") + "\nnot json\n",
    })
    assert.equal(result.status, 0, result.stderr)
    const [init, ping, list, status, unknown, bare] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(init.id, 0)
    assert.equal(init.result.protocolVersion, "2025-03-26")
    assert.deepEqual(ping.result, {})
    assert.deepEqual(list.result.tools.map((tool) => tool.name), TOOL_NAMES)
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: true } })
    assert.equal(JSON.parse(status.result.content[0].text).state, "degraded:plugin_root_missing")
    assert.equal(status.result.isError, false)
    assert.equal(unknown.error.code, -32601)
    assert.equal(bare.result.protocolVersion, "2025-06-18")
  })
}

test("the bootstrap's tool list matches the server's", () => {
  assert.deepEqual(bootstrap.TOOL_NAMES, TOOL_NAMES)
})

// ---- degrade, never die: failures inside the bootstrap ----

test("a spawn that throws synchronously is served as node_spawn_failed", async () => {
  const root = await mkTempRoot("desk-bootstrap-spawn-throw-")
  fakeNode(path.join(root, "home", ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0", "127")
  const input = new PassThrough()
  const output = new PassThrough()
  const read = collect(output)
  const running = bootstrap.run({
    ...machine(root),
    args: [],
    spawn: () => { throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" }) },
    signals: new EventEmitter(),
    stdin: input,
    stdout: output,
    stderr: { write() {} },
  })
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desk_status" } })}\n`)
  await running
  assert.equal(toolPayload(read()[0]).state, "degraded:node_spawn_failed")
})

test("anything that throws while picking a Node is served as bootstrap_failed", async () => {
  const root = await mkTempRoot("desk-bootstrap-throw-")
  fakeNode(path.join(root, "path-bin", "node"), "22.9.0", "127")
  const input = new PassThrough()
  const output = new PassThrough()
  const read = collect(output)
  const errors = []
  const running = bootstrap.run({
    ...machine(root, { env: { PATH: path.join(root, "path-bin") } }),
    args: [],
    probe: () => { throw new Error("probe exploded") },
    stdin: input,
    stdout: output,
    stderr: { write: (text) => errors.push(text) },
  })
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desk_status" } })}\n`)
  await running
  const payload = toolPayload(read()[0])
  assert.equal(payload.state, "degraded:bootstrap_failed")
  assert.match(payload.summary, /probe exploded/u)
  assert.match(errors.join(""), /bootstrap failed before it could start Desk: probe exploded/u)
})

test("an error event from a child that did start never starts a second responder", async () => {
  const root = await mkTempRoot("desk-bootstrap-late-error-")
  fakeNode(path.join(root, "home", ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0", "127")
  const child = fakeChild()
  child.pid = 4242
  const errors = []
  const exits = []
  const running = bootstrap.run({
    ...machine(root),
    args: [],
    spawn: () => child,
    signals: new EventEmitter(),
    stdout: { write: () => { throw new Error("the bootstrap must not write while the child serves") } },
    stderr: { write: (text) => errors.push(text) },
    exit: (code) => exits.push(code),
  })
  child.emit("error", new Error("kill EPERM"))
  child.emit("exit", 0, null)
  await running
  assert.match(errors.join(""), /kill EPERM/u)
  assert.deepEqual(exits, [0])
})

test("probes share a 3 s budget and version-manager shims on PATH are never run", async () => {
  const root = await mkTempRoot("desk-bootstrap-budget-")
  // Unversioned PATH binaries have to be probed; the clock jumps 2 s per probe.
  for (const name of ["a", "b", "c"]) fakeNode(path.join(root, name, "node"), "22.9.0", "127")
  fakeNode(path.join(root, "home", ".nvm", "versions", "node", "v20.11.1", "bin", "node"), "20.11.1", "115")
  let clock = 0
  const probed = []
  const selection = bootstrap.selectNode(machine(root, {
    env: { PATH: ["a", "b", "c"].map((name) => path.join(root, name)).join(":") },
    now: () => clock,
    probe: (file, timeoutMs) => { probed.push([file, timeoutMs]); clock += 2000; return bootstrap.probeNode(file, {}, timeoutMs) },
  }))
  assert.deepEqual(probed.map(([file]) => path.basename(path.dirname(file))), ["a", "b"])
  assert.deepEqual(probed.map(([, timeoutMs]) => timeoutMs), [3000, 1000])
  // Once the budget is spent, the choice is not probed again.
  assert.equal(selection.node.path, path.join(root, "a", "node"))

  const shims = await mkTempRoot("desk-bootstrap-shims-")
  const home = path.join(shims, "home")
  const voltaShim = fakeNode(path.join(home, ".volta", "bin", "volta-shim"), "0.0.0", "0")
  symlinkSync(voltaShim, path.join(home, ".volta", "bin", "node"))
  fakeNode(path.join(home, ".asdf", "shims", "node"), "22.9.0", "127")
  fakeNode(path.join(home, ".local", "share", "mise", "shims", "node"), "22.9.0", "127")
  mkdirSync(path.join(shims, "linked"))
  symlinkSync(voltaShim, path.join(shims, "linked", "node"))
  const onPath = [path.join(home, ".volta", "bin"), path.join(home, ".asdf", "shims"), path.join(home, ".local", "share", "mise", "shims"), path.join(shims, "linked")]
  assert.deepEqual(bootstrap.candidatePaths({ env: { PATH: onPath.join(":") }, platform: "darwin", homeDir: path.join(shims, "nobody"), systemPrefix: path.join(shims, "none") }), [])
})

test("the Claude inline launcher answers the handshake when bootstrap.cjs itself cannot load", async () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.desk
  const plugin = await mkTempRoot("desk-bootstrap-broken-plugin-")
  mkdirSync(path.join(plugin, "mcp"))
  writeFileSync(path.join(plugin, "mcp", "bootstrap.cjs"), "module.exports = {\n  run: function (\n")
  const result = spawnSync(process.execPath, claude.args, {
    cwd: plugin,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", DESK_PLUGIN_ROOT: plugin, NODE_OPTIONS: "" },
    input: [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "desk_status" } },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n",
  })
  assert.equal(result.status, 0, result.stderr)
  const [list, status] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  assert.deepEqual(list.result.tools.map((tool) => tool.name), TOOL_NAMES)
  const payload = JSON.parse(status.result.content[0].text)
  assert.equal(payload.state, "degraded:bootstrap_failed")
  assert.match(result.stderr, /\[desk-mcp\] launcher: /u)
})

test("with no pack for this platform the node_missing fix still names a command", async () => {
  const root = await mkTempRoot("desk-bootstrap-nopack-")
  const input = new PassThrough()
  const output = new PassThrough()
  const read = collect(output)
  const running = bootstrap.run({ ...machine(root, { platform: "sunos", arch: "sparc" }), args: [], stdin: input, stdout: output, stderr: { write() {} } })
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desk_status" } })}\n`)
  await running
  const payload = toolPayload(read()[0])
  assert.equal(payload.recommended_node_major, null)
  assert.doesNotMatch(payload.summary, /ideally/u)
  assert.match(payload.fix, /nvm install --lts|brew install node`/u)
})
