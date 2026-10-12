// Copilot CLI asks its agent for a `Co-authored-by: Copilot` commit trailer unless `includeCoAuthoredBy` is false in the operator's
// Copilot settings. Desk forbids AI attribution, so its Copilot session start turns the setting off once, only when it is unset.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, statSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { disableCoAuthorTrailer } from "../../../../../plugins/desk/mcp/src/runtime/copilot-commit-trailer.js"

const ROOT = mkdtempSync(path.join(tmpdir(), "copilot-trailer-"))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))
let counter = 0
function home({ settings, copilot = true } = {}) {
  const dir = path.join(ROOT, `home-${(counter += 1)}`)
  mkdirSync(copilot ? path.join(dir, ".copilot") : dir, { recursive: true })
  if (settings !== undefined) writeFileSync(path.join(dir, ".copilot", "settings.json"), settings)
  return dir
}
const file = (dir) => path.join(dir, ".copilot", "settings.json")
const run = (dir, extra = {}) => disableCoAuthorTrailer({ env: { HOME: dir }, ...extra })

test("an unset setting is turned off once, the other settings are kept, and the session is told in one line", () => {
  const dir = home({ settings: JSON.stringify({ model: "x", enabledPlugins: { desk: true } }) })
  const first = run(dir)
  assert.equal(first.state, "set")
  assert.equal(first.line, `Desk startup: set \`includeCoAuthoredBy: false\` in ${file(dir)}, so Copilot stops asking for an AI co-author trailer on commits from the next session; add none in this session either.`)
  assert.deepEqual(JSON.parse(readFileSync(file(dir), "utf8")), { model: "x", enabledPlugins: { desk: true }, includeCoAuthoredBy: false })
  assert.deepEqual(readdirSync(path.dirname(file(dir))), ["settings.json"], "no temporary file is left")
  assert.deepEqual(run(dir), { state: "already", line: "" }, "the next session says nothing")
})

test("a Copilot folder with no settings file gets one", () => {
  const dir = home()
  assert.equal(run(dir).state, "set")
  assert.deepEqual(JSON.parse(readFileSync(file(dir), "utf8")), { includeCoAuthoredBy: false })
})

test("an explicit value is the operator's: on or off, it is left alone and nothing is said", () => {
  for (const value of [true, "yes", null]) {
    const text = JSON.stringify({ includeCoAuthoredBy: value })
    const dir = home({ settings: text })
    assert.deepEqual(run(dir), { state: "kept", line: "" }, String(value))
    assert.equal(readFileSync(file(dir), "utf8"), text)
  }
})

test("no Copilot folder means no Copilot to configure: nothing is created", () => {
  const dir = home({ copilot: false })
  assert.deepEqual(run(dir), { state: "no_copilot_home", line: "" })
  assert.deepEqual(readdirSync(dir), [])
  writeFileSync(path.join(dir, ".copilot"), "a file, not a folder")
  assert.equal(run(dir).state, "no_copilot_home")
})

test("COPILOT_HOME names the folder, and USERPROFILE or the real home stands in for HOME", () => {
  const dir = home()
  const elsewhere = path.join(dir, "elsewhere")
  mkdirSync(elsewhere)
  assert.equal(disableCoAuthorTrailer({ env: { HOME: path.join(dir, "none"), COPILOT_HOME: elsewhere } }).state, "set")
  assert.deepEqual(JSON.parse(readFileSync(path.join(elsewhere, "settings.json"), "utf8")), { includeCoAuthoredBy: false })
  assert.equal(disableCoAuthorTrailer({ env: { USERPROFILE: dir } }).state, "set")
  assert.equal(disableCoAuthorTrailer({ env: {}, home: dir }).state, "already")
  assert.equal(typeof disableCoAuthorTrailer({ env: { COPILOT_HOME: path.join(dir, "none") } }).state, "string", "the real home is the last fallback and is not written here")
})

test("a settings file with comments or trailing commas is read as Copilot reads it and never rewritten", () => {
  const commented = (body) => `\uFEFF{\n  // the model, with a "quote" and a \\ in a comment\n  "model": "a // b \\" /* c */", /* block */\n${body}}\n// trailing`
  for (const [body, state] of [['  "includeCoAuthoredBy": false,\n', "already"], ['  "includeCoAuthoredBy": true,\n', "kept"]]) {
    const dir = home({ settings: commented(body) })
    assert.deepEqual(run(dir), { state, line: "" })
    assert.equal(readFileSync(file(dir), "utf8"), commented(body))
  }
  const dir = home({ settings: commented('  "beep": true,\n') })
  assert.deepEqual(run(dir), { state: "not_plain_json", line: `Desk startup: ${file(dir)} has comments or trailing commas, so Desk did not rewrite it; add \`"includeCoAuthoredBy": false\` to it once so Copilot stops asking for an AI co-author trailer on commits, and add no AI co-author trailer to commits in this session.` })
  assert.equal(readFileSync(file(dir), "utf8"), commented('  "beep": true,\n'))
  for (const text of ['[1, 2,] // a list', '{ "a": 1 /* never closed', '{ "a": "never closed \\']) assert.equal(run(home({ settings: text })).state, "unreadable", text)
})

test("an empty settings file is one with nothing set", () => {
  for (const text of ["", " \n"]) {
    const dir = home({ settings: text })
    assert.equal(run(dir).state, "set")
    assert.deepEqual(JSON.parse(readFileSync(file(dir), "utf8")), { includeCoAuthoredBy: false })
  }
})

test("the settings file keeps its permissions", { skip: process.platform === "win32" }, () => {
  const dir = home({ settings: "{}" })
  chmodSync(file(dir), 0o644)
  assert.equal(run(dir).state, "set")
  assert.equal(statSync(file(dir)).mode & 0o777, 0o644)
  const fresh = home()
  assert.equal(run(fresh).state, "set")
  assert.equal(statSync(file(fresh)).mode & 0o777, 0o600)
})

test("a settings file that is not a JSON object is left alone, and the line gives the command to run", () => {
  for (const text of ["{ not json", "[]", "null", "7"]) {
    const dir = home({ settings: text })
    const result = run(dir)
    assert.equal(result.state, "unreadable", text)
    assert.equal(result.line, `Desk startup: could not read ${file(dir)} as a JSON object, so Copilot's commit trailer setting is unchanged; run \`copilot config includeCoAuthoredBy false\` once, and add no AI co-author trailer to commits in this session.`)
    assert.equal(readFileSync(file(dir), "utf8"), text)
  }
  const dir = home()
  mkdirSync(file(dir))
  assert.equal(run(dir).state, "unreadable", "a folder where the file should be")
})

test("a file that changed while this ran is left alone, and a write that fails says so", () => {
  const text = JSON.stringify({ model: "x" })
  const dir = home({ settings: text })
  assert.deepEqual(run(dir, { recheck: () => `${text}\n` }), { state: "changed", line: "" })
  assert.deepEqual(run(dir, { recheck: () => null }), { state: "changed", line: "" }, "the file was removed meanwhile")
  assert.deepEqual(run(dir, { recheck: () => { throw new Error("boom") } }), { state: "failed", line: `Desk startup: could not write ${file(dir)}, so Copilot still asks for an AI co-author trailer on commits; run \`copilot config includeCoAuthoredBy false\` once, and add no AI co-author trailer to commits in this session.` })
  assert.equal(readFileSync(file(dir), "utf8"), text)
  assert.deepEqual(readdirSync(path.dirname(file(dir))), ["settings.json"], "no temporary file is left")
})

test("a settings file kept as a symlink is edited where it lives, and the link stays", { skip: process.platform === "win32" }, () => {
  const dir = home()
  const real = path.join(dir, "dotfiles-settings.json")
  writeFileSync(real, JSON.stringify({ model: "x" }))
  symlinkSync(real, file(dir))
  assert.equal(run(dir).state, "set")
  assert.equal(lstatSync(file(dir)).isSymbolicLink(), true)
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { model: "x", includeCoAuthoredBy: false })
})

test("with no options it reads the process environment, which the test preload points at a Copilot folder that does not exist", () => {
  assert.deepEqual(disableCoAuthorTrailer(), { state: "no_copilot_home", line: "" })
})
