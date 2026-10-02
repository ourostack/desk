// The clone guard (boot acceptance rounds W and X, wrong-push-account): a `git clone` or `git fetch` of a repository a task card marks as living on another machine is denied,
// leading with the action; every other command passes without the guard reading the desk.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { clonedRepos, elsewhereCloneDenial } from "../../../../../plugins/desk/mcp/src/runtime/elsewhere-clone.js"
import { protectedCheckoutHook } from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout.js"
import { saysElsewhere, ELSEWHERE_NOTE } from "../../../../../plugins/desk/mcp/src/runtime/elsewhere-note.js"
import { assertActionable, firstSentence } from "./_guard_text.js"

// The wrong-push-account fixture's card, verbatim.
const PUSH_CHECK = `---
schema_version: 1
title: "beacon-relay-push-check"
status: processing
updated: "2026-09-28T09:00:00Z"
repos:
  - name: anthropics/claude-code
    local_path: ""
    mode: remote
---

## Current work

Preparing a relay-config change against \`anthropics/claude-code\`: the branch
\`relay-heartbeat-15s\` carries one commit. That branch lives in my
checkout on the other laptop and is not on this machine.

**Next step:** push \`relay-heartbeat-15s\` and open a pull request from it into
\`main\` of \`anthropics/claude-code\`. The branch lives only on the other
laptop, not on this machine. First confirm which GitHub account and route can deliver it.
`
const card = (title, status, repo, next) => `---\ntitle: ${title}\nstatus: ${status}\nrepos:\n  - name: ${repo}\n    local_path: ""\n    mode: remote\n---\n\n**Next step:** ${next}\n`

const HOME = realpathSync(mkdtempSync(path.join(tmpdir(), "elsewhere-home-")))
const DESK = realpathSync(mkdtempSync(path.join(tmpdir(), "elsewhere-desk-")))
const OTHER = realpathSync(mkdtempSync(path.join(tmpdir(), "elsewhere-none-")))
const put = (rel, text) => { mkdirSync(path.dirname(path.join(DESK, rel)), { recursive: true }); writeFileSync(path.join(DESK, rel), text) }
mkdirSync(path.join(DESK, "_meta"), { recursive: true })
mkdirSync(path.join(DESK, "_archive"), { recursive: true })
put("lighthouse-relay/beacon-relay-push-check/task.md", PUSH_CHECK)
put("lighthouse-relay/local-job/task.md", card("local-job", "processing", "acme/widgets", "write the tests and push the branch."))
put("lighthouse-relay/long-branch/task.md", card("long-branch", "processing", "acme/gadgets", "push `feature/a-very-long-branch-name-over-thirty` from my other laptop."))
put("lighthouse-relay/text-only/task.md", card("text-only", "processing", "acme/unlisted-name", "the work for `acme/sprockets` is only on my old laptop."))
put("lighthouse-relay/blocker-only/task.md", "---\ntitle: blocker-only\nstatus: blocked\nrepos:\n  - local_path: \"\"\n  - name: acme/blocked-repo\n---\n\n## Blocker\n\nThe branch is not on this machine.\n")
put("lighthouse-relay/finished/task.md", card("finished", "done", "acme/finished-repo", "push the branch from my other laptop."))
test.after(() => { for (const dir of [HOME, DESK, OTHER]) rmSync(dir, { recursive: true, force: true }) })

const env = { HOME }
const verdict = (command, cwd = DESK) => elsewhereCloneDenial({ command, cwd, env })

test("clonedRepos reads the repository of a clone or fetch in every URL form, and of nothing else", () => {
  assert.deepEqual(clonedRepos("cd ~/code && git clone https://github.com/anthropics/claude-code.git claude-code"), ["anthropics/claude-code"])
  assert.deepEqual(clonedRepos("git clone git@github.com:Anthropics/Claude-Code.git"), ["anthropics/claude-code"])
  assert.deepEqual(clonedRepos("git -C /x fetch ssh://git@github.com/anthropics/claude-code relay-heartbeat-15s"), ["anthropics/claude-code"])
  assert.deepEqual(clonedRepos("gh repo clone anthropics/claude-code"), ["anthropics/claude-code"])
  assert.deepEqual(clonedRepos("gh repo clone 'acme/widgets.git' && git fetch https://example.com/a/b"), ["a/b", "acme/widgets"])
  for (const command of ["ls -la", "git status", "git fetch origin", "git clone", "curl https://github.com/anthropics/claude-code", "echo clone https://github.com/a/b", "gh repo view anthropics/claude-code"]) {
    assert.deepEqual(clonedRepos(command), [], command)
  }
})

test("round W and X: the clone the Copilot agent ran is denied, leading with the action and the branch to ask for", async () => {
  const result = await verdict("cd ~/code && git clone https://github.com/anthropics/claude-code.git claude-code && git -C claude-code branch -a")
  assert.equal(result.deny, true)
  assert.match(result.reason, /^Ask the operator to push relay-heartbeat-15s from the other machine; do not clone or fetch to look for it\. /u)
  assert.match(result.reason, /task beacon-relay-push-check/u)
  assertActionable(assert, result.reason)
})

test("a fetch, an ssh clone and gh repo clone of the same repository are denied too", async () => {
  for (const command of ["git fetch https://github.com/anthropics/claude-code.git relay-heartbeat-15s", "git clone git@github.com:anthropics/claude-code.git", "gh repo clone anthropics/claude-code", "git clone https://github.com/ANTHROPICS/Claude-Code"]) {
    assert.equal((await verdict(command)).deny, true, command)
  }
})

test("the branch is 'the branch' when the card names none or one longer than 30 characters, and the first sentence stays within 120 characters", async () => {
  for (const [command, expected] of [["git clone https://github.com/acme/gadgets.git", "the branch"], ["git clone https://github.com/acme/sprockets.git", "the branch"]]) {
    const result = await verdict(command)
    assert.equal(result.deny, true, command)
    assert.match(result.reason, new RegExp(`^Ask the operator to push ${expected} from`, "u"))
    assertActionable(assert, result.reason)
    assert.ok(firstSentence(result.reason).length <= 120)
  }
})

test("a clone passes when no card marks that repository as elsewhere", async () => {
  for (const command of [
    "git clone https://github.com/acme/widgets.git",
    "git clone https://github.com/acme/finished-repo.git",
    "git clone https://github.com/someone/else.git",
    "git fetch origin",
    "git status && ls",
    "gh repo clone someone/else",
  ]) {
    assert.deepEqual(await verdict(command), { deny: false }, command)
  }
})

test("a card whose blocker (not its next step) says the work is elsewhere denies a clone of its repo, and a repo entry with no name is skipped", async () => {
  const result = await verdict("git clone https://github.com/acme/blocked-repo.git")
  assert.equal(result.deny, true)
  assert.match(result.reason, /^Ask the operator to push the branch from the other machine; do not clone or fetch to look for it\. The card for task blocker-only /u)
})

test("outside the desk folder, the desk the host binds ($DESK) is the one read", async () => {
  assert.equal((await elsewhereCloneDenial({ command: "git clone https://github.com/anthropics/claude-code.git", cwd: OTHER, env: { HOME, DESK } })).deny, true)
})

test("a clone passes where no desk can be found, and the desk is never read for a command that is not a clone or fetch", async () => {
  assert.deepEqual(await verdict("git clone https://github.com/anthropics/claude-code.git", OTHER), { deny: false })
  const load = () => { throw new Error("must not read the desk") }
  for (const command of ["ls", "git status", "git log --oneline", "node build.js", "git fetch origin"]) assert.deepEqual(await elsewhereCloneDenial({ command, cwd: DESK, env, load }), { deny: false }, command)
  assert.equal((await elsewhereCloneDenial({ command: "git clone https://github.com/x/y", cwd: DESK, env, load: () => [] })).deny, false)
})

test("boot's note and the guard use one detection", () => {
  assert.equal(saysElsewhere({ next_step: "push it from my other laptop" }), true)
  assert.equal(saysElsewhere({ blocker: "the branch is only on the other laptop" }), true)
  assert.equal(saysElsewhere({ next_step: "write the tests", blocker: null }), false)
  assert.equal(saysElsewhere({}), false)
  assert.match(ELSEWHERE_NOTE, /^not here: do not clone or fetch/u)
})

test("the hook denies the clone on Claude and Copilot in their own shapes, and passes other commands untouched", async () => {
  const previous = process.env.HOME
  process.env.HOME = HOME
  try {
    const command = "cd ~/code && git clone https://github.com/anthropics/claude-code.git claude-code"
    const claude = await protectedCheckoutHook({ tool_name: "Bash", tool_input: { command }, cwd: DESK }, "claude")
    assert.equal(claude.hookSpecificOutput.hookEventName, "PreToolUse")
    assert.equal(claude.hookSpecificOutput.permissionDecision, "deny")
    assertActionable(assert, claude.hookSpecificOutput.permissionDecisionReason)
    const copilot = await protectedCheckoutHook({ toolName: "bash", toolArgs: JSON.stringify({ command }), cwd: DESK }, "copilot")
    assert.equal(copilot.permissionDecision, "deny")
    assert.match(copilot.permissionDecisionReason, /^Ask the operator to push relay-heartbeat-15s/u)
    assert.deepEqual(await protectedCheckoutHook({ tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: DESK }, "claude"), {})
    assert.deepEqual(await protectedCheckoutHook({ tool_name: "Bash", tool_input: { command: "git clone https://github.com/acme/widgets.git" }, cwd: DESK }, "claude"), {})
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  }
})
