import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import matter from "gray-matter"

import { callTool, TOOL_IMPLS } from "../../src/server.js"
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from "../../src/tool-names.js"
import { doctorRuntime } from "../../src/tools/doctor.js"

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), "desk-doctor-"))
}

function writeCard(root, relPath, data, body = "") {
  const filePath = path.join(root, relPath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, matter.stringify(body, data), "utf8")
}

function parseToolResult(response) {
  assert.equal(response.isError, undefined, response.content?.[0]?.text)
  return JSON.parse(response.content[0].text)
}

test("desk_doctor is registered as the healthy counterpart to diagnostic recovery", () => {
  assert.ok(TOOL_NAMES.includes("desk_doctor"), `registered tools: ${TOOL_NAMES.join(", ")}`)
  assert.equal(typeof TOOL_IMPLS.desk_doctor, "function")
  assert.match(TOOL_DESCRIPTIONS.desk_doctor, /runtime|diagnostic|recover/iu)
})

test("healthy desk_doctor uses the same dependency-free diagnostic vocabulary", async () => {
  const root = makeRoot()
  try {
    const statusContext = {
      runtime: {
        target: {
          id: "darwin-arm64-node-127",
          platform: "darwin",
          arch: "arm64",
          node_abi: "127",
        },
        shipped_targets: [
          {
            id: "darwin-arm64-node-127",
            platform: "darwin",
            arch: "arm64",
            node_abi: "127",
          },
        ],
        paths_checked: ["/plugin/artifacts/runtime-deps/1.3.2/support-matrix.json"],
        runtime_cache_dir: "/cache/desk/runtime",
        support_matrix_path: "/plugin/artifacts/runtime-deps/1.3.2/support-matrix.json",
      },
    }
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_doctor",
      input: {},
      statusContext,
    }))

    assert.deepEqual(Object.keys(body).sort(), [
      "mode",
      "organization",
      "reason",
      "remediation",
      "runtime",
      "status",
      "summary",
    ])
    assert.equal(body.status, "ok")
    assert.equal(body.mode, "healthy")
    assert.equal(body.reason, "ready")
    assert.match(body.summary, /ready|healthy/iu)
    assert.match(body.summary, /Organization/u)
    assert.deepEqual(body.organization, [])
    assert.deepEqual(body.runtime, {
      state: "ready",
      current_target: statusContext.runtime.target,
      shipped_targets: statusContext.runtime.shipped_targets,
      paths_checked: statusContext.runtime.paths_checked,
      runtime_cache_path: statusContext.runtime.runtime_cache_dir,
      support_matrix_path: statusContext.runtime.support_matrix_path,
    })

    assert.deepEqual(body.remediation, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("healthy desk_doctor tolerates empty context and prefers normalized runtime fields", () => {
  assert.deepEqual(doctorRuntime().runtime, {
    state: "ready",
    current_target: undefined,
    shipped_targets: [],
    paths_checked: [],
    runtime_cache_path: undefined,
    support_matrix_path: undefined,
  })
  assert.deepEqual(doctorRuntime({
    statusContext: {
      runtime: {
        current_target: "darwin-arm64-node-127",
        target: "ignored-target",
        runtime_cache_path: "/normalized-cache",
        runtime_cache_dir: "/ignored-cache",
        shipped_targets: [],
        paths_checked: [],
        support_matrix_path: "/matrix",
      },
    },
  }).runtime, {
    state: "ready",
    current_target: "darwin-arm64-node-127",
    shipped_targets: [],
    paths_checked: [],
    runtime_cache_path: "/normalized-cache",
    support_matrix_path: "/matrix",
  })
})

test("preview doctor emits only a versioned local snapshot without workspace or personal data", async () => {
  const root = makeRoot()
  try {
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_doctor",
      input: { format: "preview", feedback: "private text must not enter diagnostics" },
      person: "private-person",
      statusContext: { runtime: { runtime_cache_path: "/private/cache" }, secret: "private-token" },
    }))
    assert.deepEqual(Object.keys(body).sort(), [
      "architecture", "collection", "mcp_version", "node_abi", "node_major",
      "platform", "purpose", "runtime_state", "schema_version",
    ])
    assert.equal(body.schema_version, 1)
    assert.equal(body.purpose, "preview-runtime-diagnostics")
    assert.equal(body.collection, "local-on-demand")
    assert.equal(body.runtime_state, "ready")
    assert.match(body.mcp_version, /^\d+\.\d+\.\d+/u)
    assert.equal(body.platform, process.platform)
    assert.equal(body.architecture, process.arch)
    assert.equal(body.node_major, Number(process.versions.node.split(".")[0]))
    assert.equal(body.node_abi, process.versions.modules)
    assert.doesNotMatch(JSON.stringify(body), /private|desk-doctor-/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("doctor rejects a misspelled preview format instead of falling back to identifying output", async () => {
  for (const format of [null, "", "prevew", {}, []]) {
    const response = await callTool({
      deskRoot: "/private/workspace",
      name: "desk_doctor",
      input: { format },
      statusContext: { runtime: { runtime_cache_path: "/private/cache" } },
    })
    assert.equal(response.isError, true)
    assert.match(response.content[0].text, /unsupported diagnostic format/u)
    assert.doesNotMatch(response.content[0].text, /private/u)
  }
  assert.equal(doctorRuntime({ input: { format: "full" } }).mode, "healthy")
})

// ── Organization section (M4-3) ─────────────────────────────────────────

test("desk_doctor reports organization findings for the caller's own desk", async () => {
  const root = makeRoot()
  try {
    writeCard(root, "inbox/track.md", { schema_version: 1, title: "inbox", status: "active" })
    writeCard(root, "inbox/some-real-outcome/task.md", {
      schema_version: 1,
      title: "some-real-outcome",
      status: "processing",
      created: "2026-09-20T00:00:00Z",
      updated: "2026-09-20T00:00:00Z",
      track: "inbox",
    })

    const body = parseToolResult(await callTool({ deskRoot: root, name: "desk_doctor", input: {} }))

    assert.ok(Array.isArray(body.organization))
    const codes = body.organization.map((f) => f.code)
    assert.ok(codes.includes("track_catch_all"))
    assert.ok(codes.includes("track_missing_scope"))
    for (const finding of body.organization) {
      assert.equal(typeof finding.code, "string")
      assert.equal(typeof finding.path, "string")
      assert.equal(typeof finding.hint, "string")
    }
    assert.match(body.summary, /Organization/u)
    assert.match(body.summary, /track_catch_all/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_doctor's organization section reports clean when there is nothing to tidy", async () => {
  const root = makeRoot()
  try {
    const body = parseToolResult(await callTool({ deskRoot: root, name: "desk_doctor", input: {} }))
    assert.deepEqual(body.organization, [])
    assert.match(body.summary, /Organization/u)
    assert.match(body.summary, /clean/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_doctor scopes organization findings to the caller's own crew subtree", async () => {
  const root = makeRoot()
  try {
    // A peer's messy desk — must never surface in another caller's report.
    writeCard(root, "desks/alice/inbox/track.md", { schema_version: 1, title: "inbox", status: "active" })

    // The caller's own (clean) desk.
    writeCard(root, "desks/bob/billing-disputes/track.md", {
      schema_version: 1,
      title: "billing-disputes",
      status: "active",
      scope: "billing disputes and refund flows; not payroll",
    })
    writeCard(root, "desks/bob/billing-disputes/refund-flow-cleanup/task.md", {
      schema_version: 1,
      title: "refund-flow-cleanup",
      status: "processing",
      created: "2026-09-20T00:00:00Z",
      updated: "2026-09-20T00:00:00Z",
      track: "billing-disputes",
    })

    const body = parseToolResult(
      await callTool({ deskRoot: root, name: "desk_doctor", input: {}, person: "bob" }),
    )
    assert.deepEqual(body.organization, [])
    assert.doesNotMatch(JSON.stringify(body), /alice/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_doctor's organization section truncates a code past the first five paths", async () => {
  const root = makeRoot()
  try {
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(path.join(root, `stray-${i}.txt`), "loose\n", "utf8")
    }
    const body = parseToolResult(await callTool({ deskRoot: root, name: "desk_doctor", input: {} }))
    assert.equal(findByCode(body.organization, "loose_file").length, 6)
    assert.match(body.summary, /loose_file: 6/u)
    assert.match(body.summary, /\.\.\. and 1 more/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function findByCode(findings, code) {
  return findings.filter((f) => f.code === code)
}

test("desk_doctor treats a blank deskRoot the same as no deskRoot at all", async () => {
  const body = doctorRuntime({ input: {}, deskRoot: "   " })
  assert.deepEqual(body.organization, [])
  assert.equal(body.summary, "Desk MCP runtime dependencies are ready.")
})

test("preview desk_doctor never runs organization checks or leaks workspace data", async () => {
  const root = makeRoot()
  try {
    writeCard(root, "inbox/track.md", { schema_version: 1, title: "inbox", status: "active" })
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_doctor",
      input: { format: "preview" },
    }))
    assert.equal(body.organization, undefined)
    assert.doesNotMatch(JSON.stringify(body), /inbox/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
