import { test } from "node:test"
import { ACTIVE_VECTOR_SPACE } from "../../../../../plugins/desk/mcp/src/indexer/text-vectors.js"
import { strict as assert } from "node:assert"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import Database from "better-sqlite3"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import fsNative from "node:fs"
import { syncBuiltinESMExports } from "node:module"

import { closeDb, indexDbPath, openDb, setMeta } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../../../../plugins/desk/mcp/src/indexer/spec.js"
import { callTool, TOOL_IMPLS } from "../../../../../plugins/desk/mcp/src/server.js"
import { desk_status } from "../../../../../plugins/desk/mcp/src/tools/status.js"
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from "../../../../../plugins/desk/mcp/src/tool-names.js"

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../../plugins/desk/mcp/package.json", import.meta.url)), "utf8"),
)

const deskPluginVersion = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../plugins/desk/plugin.json", import.meta.url)), "utf8")).version

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), "desk-status-"))
}

function parseToolResult(response) {
  assert.equal(response.isError, undefined, response.content?.[0]?.text)
  return JSON.parse(response.content[0].text)
}

test("desk_status is registered with a session-start-safe description", () => {
  assert.ok(TOOL_NAMES.includes("desk_status"), `registered tools: ${TOOL_NAMES.join(", ")}`)
  assert.equal(typeof TOOL_IMPLS.desk_status, "function")
  assert.match(TOOL_DESCRIPTIONS.desk_status, /health|status/iu)
  assert.match(TOOL_DESCRIPTIONS.desk_status, /session-start|fast|repair/iu)
})

test("desk_status reports the exact workspace write scope for OFF person values", async () => {
  const root = makeRoot()
  try {
    for (const person of [undefined, null, 42, {}, true, "", "   ", "\t\n"]) {
      const body = parseToolResult(await callTool({
        deskRoot: root,
        name: "desk_status",
        input: {},
        person,
      }))
      assert.deepEqual(body.write_scope, {
        mode: "workspace",
        person: null,
        relative_path: ".",
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status reports the exact normalized person write scope", async () => {
  const root = makeRoot()
  try {
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      person: "  ari  ",
    }))
    assert.deepEqual(body.write_scope, {
      mode: "person",
      person: "ari",
      relative_path: "desks/ari",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status rejects every traversal and multi-segment alias family", async () => {
  const root = makeRoot()
  try {
    for (const person of [".", "..", "../evil", "a..b", "a/b", "a\\b", "/etc/passwd"]) {
      const response = await callTool({
        deskRoot: root,
        name: "desk_status",
        input: {},
        person,
      })
      assert.equal(response.isError, true)
      assert.match(JSON.parse(response.content[0].text).message, /alias/iu)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status reports root, runtime and search without creating .state", async () => {
  const root = makeRoot()
  const runtimeCacheDir = path.join(root, "..", "runtime-cache")
  const sourceMirrorPath = path.join(runtimeCacheDir, "source-mirror", "abc123")
  const dbPath = indexDbPath(root)
  try {
    mkdirSync(path.join(root, "ops", "status-check"), { recursive: true })
    writeFileSync(
      path.join(root, "ops", "status-check", "task.md"),
      "---\nschema_version: 1\nstatus: in_progress\n---\n\n# Status Check\n",
      "utf8",
    )

    assert.equal(existsSync(dbPath), false, "fixture must start without a local DB")

    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        root: {
          source: "activation-config",
          tried: [{ source: "activation-config", path: root }],
        },
        runtime: {
          runtime_cache_dir: runtimeCacheDir,
          source_mirror_path: sourceMirrorPath,
          target: `${process.platform}-${process.arch}-node-${process.versions.modules}`,
        },
      },
    }))

    assert.equal(body.status, "ok")
    assert.equal(body.root.path, root)
    assert.equal(body.root.source, "activation-config")
    assert.deepEqual(body.root.tried, [{ source: "activation-config", path: root }])
    // One Desk version: the plugin release, never the runtime package's version.
    assert.equal(body.runtime.plugin.name, "desk")
    assert.equal(body.runtime.plugin.version, deskPluginVersion)
    assert.notEqual(body.runtime.plugin.version, packageJson.version)
    assert.equal(body.runtime.runtime_cache_dir, runtimeCacheDir)
    assert.equal(body.runtime.source_mirror_path, sourceMirrorPath)
    assert.deepEqual(body.search, { state: "starting", message: "Desk search is starting." })
    assert.match(body.summary, /activation-config/iu)
    assert.equal(body.active_tasks.task_count, 1, "desk_status serves the redacted active-task listing session start renders")
    assert.equal(body.active_tasks.tracks[0].track, "ops")
    assert.equal(body.active_tasks.tracks[0].tasks[0].slug, "status-check")
    assert.match(body.active_tasks.tracks[0].tasks[0].handle, /^task-[0-9a-f]{10}$/u)
    assert.equal(existsSync(dbPath), false, "status must not create the local index DB")
    assert.equal(existsSync(path.dirname(dbPath)), false, "status must not create .state during first-run checks")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status reports active activation target and overlay chain when provided", async () => {
  const root = makeRoot()
  try {
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        root: {
          source: "activation-config",
          tried: [{ source: "activation-config", path: root }],
        },
        activation: {
          selected_id: "ms-area:worker",
          chain: [
            { id: "desk:worker" },
            { id: "ms-desk:worker" },
            { id: "ms-area:worker" },
          ],
          mode: "global-personal",
          source: "activation-config",
        },
      },
    }))

    assert.equal(body.status, "ok")
    assert.deepEqual(body.activation, {
      selected_id: "ms-area:worker",
      chain: ["desk:worker", "ms-desk:worker", "ms-area:worker"],
      mode: "global-personal",
      source: "activation-config",
    })
    assert.match(body.summary, /Active activation: ms-area:worker/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status normalizes activation aliases and ignores malformed chain entries", async () => {
  const root = makeRoot()
  try {
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        activation: {
          selectedActivationId: "ms-desk:worker",
          chain: [
            "desk:worker",
            "",
            { id: "ms-desk:worker" },
            { id: 42 },
            null,
            false,
          ],
        },
      },
    }))

    assert.deepEqual(body.activation, {
      selected_id: "ms-desk:worker",
      chain: ["desk:worker", "ms-desk:worker"],
      mode: null,
      source: "unknown",
    })

    const camelCaseBody = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        activation: {
          selectedId: "ms-desk:worker",
          chain: "desk:worker -> ms-desk:worker",
          source: " ",
        },
      },
    }))
    assert.deepEqual(camelCaseBody.activation, {
      selected_id: "ms-desk:worker",
      chain: [],
      mode: null,
      source: "unknown",
    })

    const idBody = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        activation: {
          id: "desk:worker",
          chain: [],
        },
      },
    }))
    assert.equal(idBody.activation.selected_id, "desk:worker")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status reports no desk root", async () => {
  const body = parseToolResult(await callTool({
    name: "desk_status",
    input: {},
  }))

  assert.equal(body.status, "error")
  assert.equal(body.root.path, null)
  assert.equal(body.root.exists, false)
  assert.equal(body.root.valid, false)
  assert.equal(body.root.diagnostic, "missing_desk_root")
  assert.equal(body.active_tasks, null, "no listing without a valid root")
  assert.match(body.summary, /missing_desk_root/u)
})

test("desk_status sanitizes malformed root context and reports nonexistent roots", async () => {
  const parent = makeRoot()
  const root = path.join(parent, "removed")
  try {
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        root: {
          source: 42,
          tried: "this is not a tried list",
        },
      },
    }))

    assert.equal(body.status, "error")
    assert.equal(body.root.path, root)
    assert.equal(body.root.source, "unknown")
    assert.deepEqual(body.root.tried, [])
    assert.equal(body.root.exists, false)
    assert.equal(body.root.valid, false)
    assert.equal(body.root.diagnostic, "desk_root_not_found")
    assert.equal(body.root.malformed_context, true)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("desk_status reports search in plain words from the session's engine, with the old-index line when it was removed", async () => {
  const root = makeRoot()
  try {
    const search = { state: "preparing", message: "Search is preparing 3 of 10 sections for meaning-based search; exact-word search is ready.", old_index_removed: "Desk removed its old search index (9.7 GB), which this version no longer uses." }
    const body = parseToolResult(await callTool({
      deskRoot: root, name: "desk_status", input: {},
      statusContext: { admission: { controller: { searchStatus: () => search } } },
    }))
    assert.deepEqual(body.search, search)
    assert.match(body.summary, /Search is preparing 3 of 10 sections.*Desk removed its old search index \(9\.7 GB\)/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
