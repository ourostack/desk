import { test } from "node:test"
import { strict as assert } from "node:assert"
import { handoffReference, isHandoffPath } from "../../../../../plugins/desk/mcp/src/desk/handoff-reference.js"
import { scratchCardNote, scratchPathCount, scratchPathWarning } from "../../../../../plugins/desk/mcp/src/desk/scratch-paths.js"

// A fake Git that answers by the config key or ref it is asked about; anything not listed fails.
const gitSays = (answers) => (command, args) => {
  const key = args.slice(2).join(" ")
  return key in answers ? { status: 0, stdout: `${answers[key]}\n` } : { status: 1, stdout: "" }
}
const REMOTE = "remote.origin.url"
const BRANCH = "symbolic-ref --quiet --short HEAD"

test("a handoffs/ path is recognised on both slash styles, and nothing else is", () => {
  assert.equal(isHandoffPath("track/work/handoffs/brief.md"), true)
  assert.equal(isHandoffPath("track\\work\\handoffs\\brief.md"), true)
  assert.equal(isHandoffPath("handoffs/brief.md"), true)
  assert.equal(isHandoffPath("track/work/notes.md"), false)
  assert.equal(isHandoffPath("track/work/my-handoffs/brief.md"), false)
})

test("a hand-off URL names the branch the checkout tracks, else the remote's default branch, else main", () => {
  const base = { [`config --get ${REMOTE}`]: "https://token@github.com/sample/context.git", "rev-parse --show-prefix": "desks/ari/" }
  assert.equal(
    handoffReference("/desk", "track/work/handoffs/a b.md", gitSays({ ...base, [BRANCH]: "work", "config branch.work.merge": "refs/heads/release/1", "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/trunk" })),
    "https://github.com/sample/context/blob/release/1/desks/ari/track/work/handoffs/a%20b.md",
  )
  assert.equal(
    handoffReference("/desk", "h/handoffs/a.md", gitSays({ ...base, [BRANCH]: "work", "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/trunk" })),
    "https://github.com/sample/context/blob/trunk/desks/ari/h/handoffs/a.md",
  )
  assert.equal(
    handoffReference("/desk", "h\\handoffs\\a.md", gitSays({ [`config --get ${REMOTE}`]: "git@example.com:sample/context", "rev-parse --show-prefix": "" })),
    "https://example.com/sample/context/blob/main/h/handoffs/a.md",
  )
})

test("a desk with no GitHub-style origin, or a Git that throws, has no hand-off URL", () => {
  assert.equal(handoffReference("/desk", "h/handoffs/a.md", gitSays({})), undefined)
  assert.equal(handoffReference("/desk", "h/handoffs/a.md", gitSays({ [`config --get ${REMOTE}`]: "/srv/bare.git" })), undefined)
  assert.equal(handoffReference("/desk", "h/handoffs/a.md", () => { throw new Error("no git") }), undefined)
  assert.equal(handoffReference("/desk", "h/handoffs/a.md", () => ({ status: 0, stdout: undefined })), undefined)
})

test("scratch paths are found in a session folder, a history folder and a temp folder, once each, and never in a URL", () => {
  const text = "See ~/.copilot/session-state/abc/files/x.md, /Users/me/.claude/projects/p/s.jsonl, /tmp/a, /private/var/folders/zz/T/b and ~/.copilot/session-state/abc/files/x.md. Not https://example.com/tmp/x or src/tmp/y."
  assert.equal(scratchPathCount(text), 4)
  assert.equal(scratchPathCount(undefined), 0)
  assert.equal(scratchPathCount(""), 0)
  assert.equal(scratchPathCount("nothing here"), 0)
})

test("the warning leads with the fix, shows three paths and counts the rest, and is undefined with none", () => {
  assert.equal(scratchPathWarning("clean text"), undefined)
  assert.equal(scratchPathWarning([undefined, 4, "also clean"]), undefined)
  const warning = scratchPathWarning(["/tmp/a /tmp/b", "/tmp/c /tmp/d /tmp/e"])
  assert.match(warning, /^Copy the file into the task's folder with desk_save/u)
  assert.match(warning, /what you wrote names `\/tmp\/a`, `\/tmp\/b`, `\/tmp\/c` and 2 more, which dies with the session/u)
  assert.match(scratchPathWarning("/tmp/a", "This entry"), /This entry names `\/tmp\/a`, which dies/u)
})

test("a card's task-list note is singular for one path and plural for several", () => {
  assert.match(scratchCardNote(1), /^Copy the file into the task's folder with desk_save and link that: this card names 1 path in a session or temp folder that dies with the session\.$/u)
  assert.match(scratchCardNote(3), /^Copy those files .* names 3 paths in a session or temp folder that die with the session\.$/u)
})
