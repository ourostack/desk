import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")

async function loadDiagnostics() {
  return import("../../../../../plugins/desk/mcp/src/runtime/diagnostics.js")
}

const currentTarget = {
  id: "darwin-arm64-node-115",
  platform: "darwin",
  arch: "arm64",
  node_abi: "115",
}
const shippedTargets = [{
  id: "darwin-arm64-node-127",
  platform: "darwin",
  arch: "arm64",
  node_abi: "127",
}]

test("runtime diagnostic vocabulary distinguishes every recoverable first-boot failure", async () => {
  const { createRuntimeDiagnostic } = await loadDiagnostics()
  for (const reason of [
    "unsupported_target",
    "missing_pack",
    "corrupt_pack",
    "runtime_restore_failed",
    "runtime_inspection_failed",
    "node_selection_failed",
    "no_compatible_node",
    "guarded_reexec_failure",
  ]) {
    const diagnostic = createRuntimeDiagnostic({
      reason,
      failureKind: reason === "corrupt_pack" ? "checksum_mismatch" : undefined,
      currentTarget,
      shippedTargets,
      pathsChecked: ["/usr/bin/node", "/plugin/runtime-deps/support-matrix.json"],
      runtimeCachePath: "/cache/desk/runtime",
      supportMatrixPath: "/plugin/runtime-deps/support-matrix.json",
      cause: new Error("SECRET internal failure\n    at private-frame.js:42:1"),
    })
    assert.equal(diagnostic.status, "degraded")
    assert.equal(diagnostic.activation_status, "terminal")
    assert.equal(diagnostic.retryable, false)
    assert.equal(diagnostic.phase, "VERIFYING")
    assert.equal(diagnostic.observed.reason, reason)
    assert.equal(diagnostic.mode, "diagnostic")
    assert.equal(diagnostic.reason, reason)
    assert.equal(
      diagnostic.failure_kind,
      reason === "corrupt_pack" ? "checksum_mismatch" : undefined,
    )
    assert.equal(diagnostic.runtime.current_target, currentTarget)
    assert.equal(diagnostic.runtime.shipped_targets, shippedTargets)
    assert.deepEqual(diagnostic.runtime.paths_checked, [
      "/usr/bin/node",
      "/plugin/runtime-deps/support-matrix.json",
    ])
    assert.equal(diagnostic.runtime.runtime_cache_path, "/cache/desk/runtime")
    assert.equal(diagnostic.runtime.support_matrix_path, "/plugin/runtime-deps/support-matrix.json")
    assert.deepEqual(diagnostic.automatic_actions, [])
    assert.ok(diagnostic.remediation.length > 0)
    assert.ok(diagnostic.remediation.every(({ action, message }) => action && message))
    assert.ok(diagnostic.remediation.some(({ action }) => action === "refresh_plugin"))
    if (diagnostic.code === "runtime_unsupported") {
      assert.ok(diagnostic.remediation.some(({ action, message }) =>
        action === "use_shipped_node" && message.includes("Install Node 22")))
    }
    if (reason === "runtime_restore_failed") {
      assert.ok(diagnostic.remediation.some(({ action, message }) =>
        action === "check_runtime_cache" && message.includes("/cache/desk/runtime")))
    }
    assert.match(diagnostic.summary, /Desk|runtime|pack|Node/iu)
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|private-frame|stack/iu)
  }
})

test("corrupt-pack diagnostics retain actionable failure kinds", async () => {
  const { createRuntimeDiagnostic } = await loadDiagnostics()
  for (const failureKind of [
    "checksum_mismatch",
    "manifest_mismatch",
    "archive_corrupt",
  ]) {
    const diagnostic = createRuntimeDiagnostic({
      reason: "corrupt_pack",
      failureKind,
      currentTarget,
      shippedTargets,
      pathsChecked: [],
      runtimeCachePath: "/cache",
      supportMatrixPath: "/matrix.json",
    })

    assert.equal(diagnostic.failure_kind, failureKind)
    assert.equal(diagnostic.code, "artifact_integrity_invalid")
  }
})

test("runtime diagnostics provide safe defaults for unknown failures", async () => {
  const { createRuntimeDiagnostic } = await loadDiagnostics()
  const diagnostic = createRuntimeDiagnostic({ reason: "unexpected_failure" })
  assert.equal(diagnostic.reason, "unexpected_failure")
  assert.match(diagnostic.summary, /could not prepare/u)
  assert.deepEqual(diagnostic.runtime.shipped_targets, [])
  assert.deepEqual(diagnostic.runtime.paths_checked, [])
  assert.equal(diagnostic.runtime.runtime_cache_path, null)
  assert.equal(diagnostic.runtime.support_matrix_path, null)
  assert.equal(diagnostic.code, "artifact_integrity_invalid")
  assert.deepEqual(diagnostic.automatic_actions, [])
  assert.equal(diagnostic.status, "degraded")
  assert.ok(diagnostic.remediation.some(({ action }) => action === "refresh_plugin"))
})

test("use_shipped_node names this platform's Node majors and a per-user install", async () => {
  const { createRuntimeDiagnostic } = await loadDiagnostics()
  const diagnostic = createRuntimeDiagnostic({
    reason: "no_compatible_node",
    currentTarget: { id: "win32-x64-node-147", platform: "win32", arch: "x64", node_abi: "147" },
    shippedTargets: [
      { id: "darwin-arm64-node-127", platform: "darwin", arch: "arm64", node_abi: "127" },
      { id: "win32-x64-node-137", platform: "win32", arch: "x64", node_abi: "137" },
    ],
  })
  const message = diagnostic.remediation.find(({ action }) => action === "use_shipped_node").message
  assert.equal(
    message.split(". Install ")[0],
    "This machine runs Node 26 (module ABI 147), and Desk ships runtime packs for Node 24 on win32-x64",
  )
  assert.match(message, /Install Node 24 for your user: a per-user install is enough and needs no administrator rights/u)
  assert.match(message, /reconnect the Desk MCP server \(in Claude Code run \/mcp and reconnect desk\)/u)
  assert.doesNotMatch(message, /darwin|module ABI 137|module ABI 127/u)
  assert.equal(diagnostic.fix, diagnostic.remediation[0].message)
})

test("use_shipped_node says Desk ships no pack for a platform it does not support", async () => {
  const { createRuntimeDiagnostic } = await loadDiagnostics()
  const diagnostic = createRuntimeDiagnostic({
    reason: "no_compatible_node",
    currentTarget: { id: "win32-arm64-node-147", platform: "win32", arch: "arm64", node_abi: "147" },
    shippedTargets: [
      { id: "darwin-arm64-node-137", platform: "darwin", arch: "arm64", node_abi: "137" },
      { id: "win32-x64-node-137", platform: "win32", arch: "x64", node_abi: "137" },
    ],
  })
  const message = diagnostic.remediation[0].message
  assert.equal(
    message,
    "Desk ships no runtime pack for this platform and architecture (win32-arm64) yet. Desk ships packs for darwin-arm64 and win32-x64, so use one of those platforms until a pack ships for this one.",
  )
  assert.doesNotMatch(message, /Install Node/u)
})

test("use_shipped_node shows a module ABI with no known Node major as an ABI", async () => {
  const { createRuntimeDiagnostic } = await loadDiagnostics()
  const diagnostic = createRuntimeDiagnostic({
    reason: "no_compatible_node",
    currentTarget: { id: "win32-x64-node-137", platform: "win32", arch: "x64", node_abi: "137" },
    shippedTargets: [
      { id: "win32-x64-node-137", platform: "win32", arch: "x64", node_abi: "137" },
      { id: "win32-x64-node-153", platform: "win32", arch: "x64", node_abi: "153" },
    ],
  })
  const message = diagnostic.remediation[0].message
  assert.match(message, /^This machine runs Node 24 \(module ABI 137\), and Desk ships runtime packs for Node 24 and Node with module ABI 153 on win32-x64\./u)
  assert.match(message, /Install Node with module ABI 153 for your user/u)
})
