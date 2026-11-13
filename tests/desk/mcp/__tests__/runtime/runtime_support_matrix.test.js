import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")

async function loadRuntimeDeps() {
  return import("../../../../../plugins/desk/mcp/src/runtime/runtime-deps.js")
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function clone(value) {
  return structuredClone(value)
}

test("Darwin Node 24 admits a verified shipped pack instead of requiring an older source mirror", async () => {
  const { inspectRuntimeDependencyPack } = await import("../../../../../plugins/desk/mcp/src/runtime/bootstrap.js")
  const inspection = inspectRuntimeDependencyPack({
    mcpRoot,
    platform: "darwin",
    arch: "arm64",
    nodeAbi: "137",
  })
  assert.equal(inspection.ok, true, inspection.summary)
  assert.equal(inspection.reason, "ready")
  assert.equal(inspection.runtime.state, "ready")
  assert.equal(inspection.target.id, "darwin-arm64-node-137")
  assert.equal(inspection.manifest.plugin.version, loadJson(path.join(mcpRoot, "package.json")).version)
})

test("Darwin release provenance identifies the installed production build", () => {
  const packageJson = loadJson(path.join(mcpRoot, "package.json"))
  const root = path.join(mcpRoot, "artifacts", "runtime-deps", packageJson.version)
  const matrix = loadJson(path.join(root, "support-matrix.json"))
  const target = matrix.targets.find(entry => entry.id === "darwin-arm64-node-127")
  assert.ok(target)
  const manifest = loadJson(path.join(root, target.artifact_path, "runtime-deps.manifest.json"))
  // The bytes are rebuilt on CI's own macOS runner, so the earlier curated repack claim no longer describes them.
  assert.deepEqual(manifest.provenance, {
    builder: "runtime:deps-pack:build",
    source: "runtime dependency pack build script",
  })
})

test("committed runtime support matrix equals the physically shipped runtime packs", async () => {
  const {
    buildRuntimeSupportMatrix,
    deriveRuntimeSupportMatrixPath,
    validateRuntimeSupportMatrix,
  } = await loadRuntimeDeps()
  const packageJson = loadJson(path.join(mcpRoot, "package.json"))
  const matrixPath = deriveRuntimeSupportMatrixPath({
    mcpRoot,
    packageJson,
  })
  const committed = loadJson(matrixPath)
  const generated = buildRuntimeSupportMatrix({
    mcpRoot,
    packageJson,
  })

  assert.deepEqual(committed, generated)
  assert.deepEqual(
    validateRuntimeSupportMatrix({
      matrix: committed,
      mcpRoot,
      packageJson,
    }),
    [],
  )
  // Repacked metadata retains the previously native-verified dependency payload for each target.
  assert.deepEqual(committed, {
    schema_version: 1,
    plugin: {
      name: "@ourostack/desk-mcp",
      version: "1.4.0-alpha.6",
    },
    targets: [
      {
        id: "darwin-arm64-node-127",
        platform: "darwin",
        arch: "arm64",
        node_abi: "127",
        prod_dependency_lock_hash: "3b0cb8b1e7dd77a982b38375fe88a5278bd77974213e18be025d7dc8deea800f",
        archive_sha256: "45a1c48c46ae0b24b8feba3c471aecd254587e5e39395d4fa2ee1adad8ca0019",
        artifact_path: "darwin-arm64-node-127/3b0cb8b1e7dd77a982b38375fe88a5278bd77974213e18be025d7dc8deea800f",
      },
      {
        id: "darwin-arm64-node-137",
        platform: "darwin",
        arch: "arm64",
        node_abi: "137",
        prod_dependency_lock_hash: "3b0cb8b1e7dd77a982b38375fe88a5278bd77974213e18be025d7dc8deea800f",
        archive_sha256: "69bc056c13385c253a733b5fc72f300c2c6e6b656f880befbfe3cba154b4a278",
        artifact_path: "darwin-arm64-node-137/3b0cb8b1e7dd77a982b38375fe88a5278bd77974213e18be025d7dc8deea800f",
      },
      {
        id: "linux-x64-node-127",
        platform: "linux",
        arch: "x64",
        node_abi: "127",
        prod_dependency_lock_hash: "3b0cb8b1e7dd77a982b38375fe88a5278bd77974213e18be025d7dc8deea800f",
        archive_sha256: "08a3a092e16e06044df8f3acf054e116b6b12d3e70e5bb3f172ebeb0b3d5a085",
        artifact_path: "linux-x64-node-127/3b0cb8b1e7dd77a982b38375fe88a5278bd77974213e18be025d7dc8deea800f",
      },
      {
        id: "win32-x64-node-137",
        platform: "win32",
        arch: "x64",
        node_abi: "137",
        prod_dependency_lock_hash: "3b0cb8b1e7dd77a982b38375fe88a5278bd77974213e18be025d7dc8deea800f",
        archive_sha256: "4c06671ce44de60be84b1943b46f8171940046889864c049a947b7bb8564d42f",
        artifact_path: "win32-x64-node-137/3b0cb8b1e7dd77a982b38375fe88a5278bd77974213e18be025d7dc8deea800f",
      },
      {
        id: "win32-x64-node-147",
        platform: "win32",
        arch: "x64",
        node_abi: "147",
        prod_dependency_lock_hash: "3b0cb8b1e7dd77a982b38375fe88a5278bd77974213e18be025d7dc8deea800f",
        archive_sha256: "d402ca53dbfcbbe769e2ce88f206c3c008e383f01215bda08cbfd5813c178d16",
        artifact_path: "win32-x64-node-147/3b0cb8b1e7dd77a982b38375fe88a5278bd77974213e18be025d7dc8deea800f",
      },
    ],
  })
})

test("runtime support matrix defaults retain owning-root routing and required metadata failures", async () => {
  const {
    buildRuntimeSupportMatrix,
    deriveRuntimeSupportMatrixPath,
    loadRuntimeSupportMatrix,
    validateRuntimeSupportMatrix,
    verifyRuntimeSupportMatrix,
  } = await loadRuntimeDeps()
  const packageJson = loadJson(path.join(mcpRoot, "package.json"))
  const matrixPath = deriveRuntimeSupportMatrixPath({ packageJson })
  assert.equal(matrixPath, path.join(mcpRoot, "artifacts", "runtime-deps", packageJson.version, "support-matrix.json"))
  const matrix = loadJson(matrixPath)
  assert.deepEqual(buildRuntimeSupportMatrix({ packageJson }), matrix)
  assert.deepEqual(loadRuntimeSupportMatrix({ packageJson }), matrix)
  assert.deepEqual(verifyRuntimeSupportMatrix({ packageJson }), { ok: true, matrix })
  assert.deepEqual(validateRuntimeSupportMatrix(), ["runtime support matrix must be a JSON object"])
  assert.throws(() => buildRuntimeSupportMatrix(), TypeError)
  assert.throws(() => loadRuntimeSupportMatrix(), TypeError)
  const missing = verifyRuntimeSupportMatrix()
  assert.equal(missing.ok, false)
  assert.match(missing.errors[0], /version/u)
  const unknown = clone(matrix)
  delete unknown.targets[0].id
  assert.match(validateRuntimeSupportMatrix({ matrix: unknown, packageJson }).join("\n"), /target <unknown> is missing id/u)
})

test("runtime support matrix validation catches omitted, phantom, and metadata-drifted targets", async () => {
  const {
    buildRuntimeSupportMatrix,
    validateRuntimeSupportMatrix,
  } = await loadRuntimeDeps()
  const packageJson = loadJson(path.join(mcpRoot, "package.json"))
  const generated = buildRuntimeSupportMatrix({
    mcpRoot,
    packageJson,
  })
  const cases = [
    {
      name: "omitted target",
      mutate: (matrix) => {
        matrix.targets = []
      },
      pattern: /must exactly match physically shipped runtime packs/u,
    },
    {
      name: "phantom target",
      mutate: (matrix) => {
        matrix.targets.push({
          ...matrix.targets[0],
          id: "linux-x64-node-127",
          platform: "linux",
          arch: "x64",
          artifact_path: "linux-x64-node-127/not-shipped",
        })
      },
      pattern: /must exactly match physically shipped runtime packs/u,
    },
    {
      name: "plugin version drift",
      mutate: (matrix) => {
        matrix.plugin.version = "0.0.0"
      },
      pattern: /plugin\.version/u,
    },
    {
      name: "platform drift",
      mutate: (matrix) => {
        matrix.targets[0].platform = "linux"
      },
      pattern: /platform/u,
    },
    {
      name: "architecture drift",
      mutate: (matrix) => {
        matrix.targets[0].arch = "x64"
      },
      pattern: /arch/u,
    },
    {
      name: "ABI drift",
      mutate: (matrix) => {
        matrix.targets[0].node_abi = "115"
      },
      pattern: /node_abi/u,
    },
    {
      name: "production lock hash drift",
      mutate: (matrix) => {
        matrix.targets[0].prod_dependency_lock_hash = "0".repeat(64)
      },
      pattern: /prod_dependency_lock_hash/u,
    },
    {
      name: "archive checksum drift",
      mutate: (matrix) => {
        matrix.targets[0].archive_sha256 = "0".repeat(64)
      },
      pattern: /archive_sha256/u,
    },
    {
      name: "artifact path drift",
      mutate: (matrix) => {
        matrix.targets[0].artifact_path = "darwin-arm64-node-127/not-the-pack"
      },
      pattern: /artifact_path/u,
    },
  ]

  for (const item of cases) {
    const matrix = clone(generated)
    item.mutate(matrix)
    const errors = validateRuntimeSupportMatrix({
      matrix,
      mcpRoot,
      packageJson,
    })
    assert.ok(errors.length > 0, item.name)
    assert.match(errors.join("\n"), item.pattern, item.name)
  }
})

test("runtime support matrix generation and verification are package scripts CI runs", () => {
  const packageJson = loadJson(path.join(mcpRoot, "package.json"))
  assert.equal(
    packageJson.scripts["runtime:support-matrix:generate"],
    "node ../../../tools/desk-build/scripts/generate-runtime-support-matrix.js",
  )
  assert.equal(
    packageJson.scripts["runtime:support-matrix:verify"],
    "node ../../../tools/desk-build/scripts/verify-runtime-support-matrix.js",
  )
  const workflow = readFileSync(
    path.join(mcpRoot, "..", "..", "..", ".github", "workflows", "desk-mcp-tests.yml"),
    "utf8",
  )
  assert.match(workflow, /npm run runtime:support-matrix:verify/u)
})

test("runtime support matrix generation ignores incomplete layouts and reads complete packs", async () => {
  const { buildRuntimeSupportMatrix } = await loadRuntimeDeps()
  const root = mkdtempSync(path.join(tmpdir(), "desk-support-matrix-layout-"))
  const packageJson = { name: "@fixture/desk-mcp", version: "9.9.9" }
  const versionRoot = path.join(root, "artifacts", "runtime-deps", packageJson.version)
  try {
    assert.deepEqual(buildRuntimeSupportMatrix({ mcpRoot: root, packageJson }).targets, [])

    mkdirSync(versionRoot, { recursive: true })
    writeFileSync(path.join(versionRoot, "not-a-target-directory"), "fixture", "utf8")

    const targetWithFile = path.join(versionRoot, "darwin-x64-node-127")
    mkdirSync(targetWithFile)
    writeFileSync(path.join(targetWithFile, "not-a-lock-directory"), "fixture", "utf8")

    mkdirSync(path.join(versionRoot, "linux-arm64-node-127", "missing-pack"), { recursive: true })

    const packDir = path.join(versionRoot, "linux-x64-node-127", "fixture-lock")
    mkdirSync(packDir, { recursive: true })
    writeFileSync(path.join(packDir, "runtime-deps.tgz"), "archive", "utf8")
    writeFileSync(path.join(packDir, "runtime-deps.manifest.json"), JSON.stringify({
      platform: {
        os: "linux",
        arch: "x64",
        node_abi: 127,
      },
      package_lock: {
        prod_dependency_lock_hash: "fixture-lock",
      },
    }), "utf8")

    const secondPackDir = path.join(versionRoot, "darwin-arm64-node-127", "second-lock")
    mkdirSync(secondPackDir, { recursive: true })
    writeFileSync(path.join(secondPackDir, "runtime-deps.tgz"), "second archive", "utf8")
    writeFileSync(path.join(secondPackDir, "runtime-deps.manifest.json"), JSON.stringify({
      platform: {
        os: "darwin",
        arch: "arm64",
        node_abi: 127,
      },
      package_lock: {
        prod_dependency_lock_hash: "second-lock",
      },
    }), "utf8")

    assert.deepEqual(buildRuntimeSupportMatrix({ mcpRoot: root, packageJson }).targets, [
      {
        id: "darwin-arm64-node-127",
        platform: "darwin",
        arch: "arm64",
        node_abi: "127",
        prod_dependency_lock_hash: "second-lock",
        archive_sha256: "cb7469f44122ba751d137a8fef6a36b8e56c6b524a35d7abfa7677955a252a4d",
        artifact_path: "darwin-arm64-node-127/second-lock",
      },
      {
        id: "linux-x64-node-127",
        platform: "linux",
        arch: "x64",
        node_abi: "127",
        prod_dependency_lock_hash: "fixture-lock",
        archive_sha256: "0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3",
        artifact_path: "linux-x64-node-127/fixture-lock",
      },
    ])

    writeFileSync(path.join(packDir, "runtime-deps.manifest.json"), "{", "utf8")
    assert.throws(
      () => buildRuntimeSupportMatrix({ mcpRoot: root, packageJson }),
      SyntaxError,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runtime support matrix rejects malformed schema and reports load failures", async () => {
  const {
    loadRuntimeSupportMatrix,
    validateRuntimeSupportMatrix,
    verifyRuntimeSupportMatrix,
  } = await loadRuntimeDeps()
  const root = mkdtempSync(path.join(tmpdir(), "desk-support-matrix-invalid-"))
  const packageJson = { name: "@fixture/desk-mcp", version: "9.9.9" }
  const matrixPath = path.join(
    root,
    "artifacts",
    "runtime-deps",
    packageJson.version,
    "support-matrix.json",
  )
  try {
    assert.deepEqual(validateRuntimeSupportMatrix({
      matrix: [],
      mcpRoot: root,
      packageJson,
    }), ["runtime support matrix must be a JSON object"])

    const invalid = {
      schema_version: 2,
      plugin: {},
      targets: [
        [],
        {
          id: "duplicate",
        },
        {
          id: "duplicate",
          platform: "linux",
          arch: "x64",
          node_abi: "127",
          prod_dependency_lock_hash: "hash",
          archive_sha256: "sha",
          artifact_path: "path",
        },
      ],
    }
    const errors = validateRuntimeSupportMatrix({
      matrix: invalid,
      mcpRoot: root,
      packageJson,
    })
    assert.match(errors.join("\n"), /schema_version must be 1/u)
    assert.match(errors.join("\n"), /plugin\.name/u)
    assert.match(errors.join("\n"), /plugin\.version/u)
    assert.match(errors.join("\n"), /target entries must be JSON objects/u)
    assert.match(errors.join("\n"), /is missing platform/u)
    assert.match(errors.join("\n"), /duplicate target duplicate/u)
    assert.match(errors.join("\n"), /target id must match/u)

    assert.deepEqual(validateRuntimeSupportMatrix({
      matrix: { schema_version: 1, plugin: packageJson, targets: null },
      mcpRoot: root,
      packageJson,
    }), ["runtime support matrix targets must be an array"])

    assert.throws(
      () => loadRuntimeSupportMatrix({ mcpRoot: root, packageJson }),
      /runtime support matrix is missing/u,
    )

    mkdirSync(path.dirname(matrixPath), { recursive: true })
    writeFileSync(matrixPath, JSON.stringify({
      schema_version: 2,
      plugin: packageJson,
      targets: [],
    }), "utf8")
    assert.throws(
      () => loadRuntimeSupportMatrix({ mcpRoot: root, packageJson }),
      /schema_version must be 1/u,
    )
    assert.equal(verifyRuntimeSupportMatrix({ mcpRoot: root, packageJson }).ok, false)

    const throwingPackageJson = {}
    Object.defineProperty(throwingPackageJson, "version", {
      get() {
        throw "version unavailable"
      },
    })
    assert.deepEqual(verifyRuntimeSupportMatrix({
      mcpRoot: root,
      packageJson: throwingPackageJson,
    }), {
      ok: false,
      errors: ["version unavailable"],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
