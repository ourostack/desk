// Which desk receives this machine's findings: the person's own desk, never the desk a session happens to be opened in.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { isOwnDesk, ownDesk } from "../../../../../plugins/desk/mcp/src/factory/route-desk.js"

const desk = (folder) => {
  mkdirSync(path.join(folder, "_meta"), { recursive: true })
  mkdirSync(path.join(folder, "_archive"), { recursive: true })
  return folder
}

test("the own desk comes from the saved binding, $DESK or the home folder, never from the project folder", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "route-desk-")))
  try {
    const home = path.join(base, "home")
    const project = desk(path.join(base, "project"))
    const saved = desk(path.join(base, "saved"))
    const pluginData = path.join(base, "plugin-data")
    mkdirSync(pluginData, { recursive: true })
    const plain = { HOME: home }
    assert.equal(ownDesk(plain), null, "no settings, no home desk: no own desk")
    assert.equal(isOwnDesk({ ...plain, CLAUDE_PROJECT_DIR: project }, project), false, "a project desk is not the person's own")
    const homeDesk = desk(path.join(home, "desk"))
    assert.equal(ownDesk(plain), homeDesk)
    assert.equal(isOwnDesk({ ...plain, DESK: project }, project), true, "$DESK names the person's own desk")
    writeFileSync(path.join(pluginData, "desk.activation.json"), JSON.stringify({ schema_version: 1, desk: { root: saved } }))
    const claude = { ...plain, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_PROJECT_DIR: project }
    assert.equal(isOwnDesk(claude, saved), true)
    assert.equal(isOwnDesk(claude, project), false)
    // A saved binding to a folder that is gone names no own desk rather than another one.
    writeFileSync(path.join(pluginData, "desk.activation.json"), JSON.stringify({ schema_version: 1, desk: { root: path.join(base, "gone") } }))
    assert.equal(ownDesk(claude), null)
    assert.equal(isOwnDesk(claude, homeDesk), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
