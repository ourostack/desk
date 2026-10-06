// Scaffold test: assert the server registers every canonical tool name.
//
// Boots the server in-process (no actual stdio transport, no actual desk
// dir) and pulls the TOOL_NAMES export.
// present. Real per-tool behavioural tests live alongside in tools/.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { homedir, tmpdir } from "node:os"
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import * as path from "node:path"

// Import from tool-names directly (not server.js) so the test doesn't pull
// the @modelcontextprotocol/sdk dep. Tool list is the canonical source.
import { TOOL_NAMES } from "../../../../plugins/desk/mcp/src/tool-names.js"

const EXPECTED_TOOLS = [
  // Runtime CRUD (Unit 3)
  "task_create",
  "task_update",
  "task_archive",
  "task_move",
  "task_focus",
  "task_signoff",
  "track_create",
  "track_update",
  "track_rename",
  "friction_add",
  "lesson_add",
  "desk_save",
  // Search (Units 4-6)
  "desk_search",
  "desk_recall",
  "desk_similar",
  "desk_timeline",
  "desk_thread",
  // Index management
  "desk_reindex",
  // Health/status
  "desk_status",
  "desk_doctor",
]

// A folder with the desk layout: home-folder guesses bind only these.
function makeDesk(dir) {
  mkdirSync(path.join(dir, "_meta"), { recursive: true })
  mkdirSync(path.join(dir, "_archive"), { recursive: true })
}

test("server scaffolds every expected tool name", () => {
  for (const name of EXPECTED_TOOLS) {
    assert.ok(
      TOOL_NAMES.includes(name),
      `expected tool '${name}' to be registered; got: ${TOOL_NAMES.join(", ")}`,
    )
  }
  assert.equal(
    TOOL_NAMES.length,
    EXPECTED_TOOLS.length,
    `expected exactly ${EXPECTED_TOOLS.length} tools; got ${TOOL_NAMES.length}`,
  )
})

test("the README advertises the number of tools the server exposes", () => {
  const readme = readFileSync(new URL("../../../../plugins/desk/mcp/README.md", import.meta.url), "utf8")
  const count = TOOL_NAMES.length
  assert.match(readme, new RegExp(`All ${count} tools are wired to real implementations`, "u"))
  assert.match(readme, new RegExp(`full set of ${count} tools`, "u"))
  for (const name of TOOL_NAMES) assert.ok(readme.split("\n").some((line) => line.startsWith("- ") && line.includes(`\`${name}\``)), `the README lists ${name}`)
})

test("path resolver expands ~ and rejects nonexistent roots", async () => {
  const { resolveDeskRoot, expandHome } = await import("../../../../plugins/desk/mcp/src/util/paths.js")
  assert.equal(expandHome("~"), homedir())
  assert.ok(expandHome("~/foo").endsWith("/foo"))
  assert.equal(expandHome("/abs/path"), "/abs/path")
  assert.throws(
    () => resolveDeskRoot("/definitely/does/not/exist/" + Date.now()),
    /does not exist/,
  )
})

test("path resolver — explicit --root wins over env + fallbacks", async () => {
  const { resolveDeskRoot } = await import("../../../../plugins/desk/mcp/src/util/paths.js")
  const tmp = mkdtempSync(path.join(tmpdir(), "desk-paths-"))
  try {
    const explicit = path.join(tmp, "explicit")
    mkdirSync(explicit)
    const prevDesk = process.env.DESK
    process.env.DESK = "/nonexistent/should/be/ignored"
    try {
      assert.equal(resolveDeskRoot(explicit), explicit)
    } finally {
      if (prevDesk === undefined) delete process.env.DESK
      else process.env.DESK = prevDesk
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("path resolver — $DESK env var used when --root absent", async () => {
  const { resolveDeskRoot } = await import("../../../../plugins/desk/mcp/src/util/paths.js")
  const tmp = mkdtempSync(path.join(tmpdir(), "desk-paths-"))
  try {
    const envRoot = path.join(tmp, "env-root")
    mkdirSync(envRoot)
    const prevDesk = process.env.DESK
    const prevHome = process.env.HOME
    process.env.DESK = envRoot
    // Point HOME at a fresh empty dir so the fallback chain finds nothing
    // and $DESK is what wins.
    process.env.HOME = path.join(tmp, "empty-home")
    mkdirSync(process.env.HOME)
    try {
      assert.equal(resolveDeskRoot(null), envRoot)
    } finally {
      if (prevDesk === undefined) delete process.env.DESK
      else process.env.DESK = prevDesk
      process.env.HOME = prevHome
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("path resolver — falls through $HOME canonical locations when env unset", async () => {
  const { resolveDeskRoot } = await import("../../../../plugins/desk/mcp/src/util/paths.js")
  const tmp = mkdtempSync(path.join(tmpdir(), "desk-paths-"))
  try {
    const fakeHome = path.join(tmp, "home")
    mkdirSync(fakeHome)
    // Create ~/desk only — verify ~/desk is found.
    makeDesk(path.join(fakeHome, "desk"))
    const prevDesk = process.env.DESK
    const prevHome = process.env.HOME
    delete process.env.DESK
    process.env.HOME = fakeHome
    try {
      assert.equal(resolveDeskRoot(null), path.join(fakeHome, "desk"))
    } finally {
      if (prevDesk !== undefined) process.env.DESK = prevDesk
      process.env.HOME = prevHome
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("path resolver — prefers desk over worker-workspace and never binds a work overlay's ms-desk", async () => {
  const { resolveDeskRoot } = await import("../../../../plugins/desk/mcp/src/util/paths.js")
  const tmp = mkdtempSync(path.join(tmpdir(), "desk-paths-"))
  try {
    const fakeHome = path.join(tmp, "home")
    mkdirSync(fakeHome)
    // Create all three — plain Desk skips ~/ms-desk, which belongs to the ms-desk overlay.
    makeDesk(path.join(fakeHome, "ms-desk"))
    makeDesk(path.join(fakeHome, "desk"))
    makeDesk(path.join(fakeHome, "worker-workspace"))
    const prevDesk = process.env.DESK
    const prevHome = process.env.HOME
    delete process.env.DESK
    process.env.HOME = fakeHome
    try {
      assert.equal(resolveDeskRoot(null), path.join(fakeHome, "desk"))
    } finally {
      if (prevDesk !== undefined) process.env.DESK = prevDesk
      process.env.HOME = prevHome
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("path resolver — falls back to worker-workspace as last resort", async () => {
  const { resolveDeskRoot } = await import("../../../../plugins/desk/mcp/src/util/paths.js")
  const tmp = mkdtempSync(path.join(tmpdir(), "desk-paths-"))
  try {
    const fakeHome = path.join(tmp, "home")
    mkdirSync(fakeHome)
    makeDesk(path.join(fakeHome, "worker-workspace"))
    const prevDesk = process.env.DESK
    const prevHome = process.env.HOME
    delete process.env.DESK
    process.env.HOME = fakeHome
    try {
      assert.equal(resolveDeskRoot(null), path.join(fakeHome, "worker-workspace"))
    } finally {
      if (prevDesk !== undefined) process.env.DESK = prevDesk
      process.env.HOME = prevHome
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("path resolver — fatal error lists every path tried", async () => {
  const { resolveDeskRoot } = await import("../../../../plugins/desk/mcp/src/util/paths.js")
  const tmp = mkdtempSync(path.join(tmpdir(), "desk-paths-"))
  try {
    const fakeHome = path.join(tmp, "home-empty")
    mkdirSync(fakeHome)
    const prevDesk = process.env.DESK
    const prevHome = process.env.HOME
    delete process.env.DESK
    process.env.HOME = fakeHome
    try {
      assert.throws(
        () => resolveDeskRoot(null),
        (err) => {
          assert.match(err.message, /no desk workspace found/)
          assert.doesNotMatch(err.message, /ms-desk/)
          assert.match(err.message, /worker-workspace/)
          return true
        },
      )
    } finally {
      if (prevDesk === undefined) delete process.env.DESK
      else process.env.DESK = prevDesk
      process.env.HOME = prevHome
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
