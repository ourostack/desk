import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { deskStartupDirection } from "../../src/util/startup-direction.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))

test("the startup line names the bound root and where it came from", () => {
  for (const [source, label] of [
    ["explicit-root", "the root passed to Desk"],
    ["host-session-root", "the root passed to Desk"],
    ["host-project", "this session's project folder is a desk"],
    ["activation-config", "the saved desk binding"],
    ["env:DESK", "the DESK environment variable"],
    ["fallback:worker-workspace", "a home-folder fallback"],
    ["fallback:desk", "a home-folder fallback"],
  ]) {
    const line = deskStartupDirection({ root: "/desks/one", source })
    assert.ok(line.startsWith(`Desk startup: $DESK is /desks/one (${label}). `), `${source}: ${line}`)
    assert.match(line, /Invoke desk:session-start now for the authoritative workspace scan before other work/u)
    // A hook cannot see an overlay launcher's --root, so the line defers to desk_status instead of claiming more.
    assert.match(line, /An overlay that launches Desk with its own root binds that root instead; desk_status reports the root Desk actually bound/u)
  }
})

test("the startup line routes to setup when no desk is bound", () => {
  for (const resolution of [null, undefined, { root: null, source: null }]) {
    const line = deskStartupDirection(resolution)
    assert.match(line, /^Desk startup: no desk is bound yet, so Desk is in setup mode\./u)
    assert.match(line, /desk:first-run-bootstrap by default/u)
    assert.match(line, /crew:join-crew/u)
    assert.match(line, /Do not offer to continue without Desk/u)
  }
})

test("resolve-desk-root --startup-line prints the line the server's resolution implies", () => {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-startup-line-")))
  try {
    const script = path.join(mcpRoot, "scripts", "resolve-desk-root.js")
    const home = path.join(scratch, "home")
    const crew = path.join(scratch, "crew")
    for (const dir of [path.join(home, "desk"), path.join(crew, "_meta"), path.join(crew, "desks")]) {
      mkdirSync(dir, { recursive: true })
    }
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home }
    assert.equal(
      execFileSync(process.execPath, [script, "--startup-line"], { encoding: "utf8", env }),
      deskStartupDirection({ root: path.join(home, "desk"), source: "fallback:desk" }),
    )
    assert.equal(
      execFileSync(process.execPath, [script, "--startup-line"], { encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: crew } }),
      deskStartupDirection({ root: crew, source: "host-project" }),
    )
    rmSync(path.join(home, "desk"), { recursive: true })
    assert.equal(
      execFileSync(process.execPath, [script, "--startup-line"], { encoding: "utf8", env }),
      deskStartupDirection(null),
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
