// The clone guard (boot acceptance rounds W and X, wrong-push-account): a `git clone` or `git fetch` of a repository a task card marks as living on another machine is denied,
// leading with the action; every other command passes without the guard reading the desk.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { clonedRepos, elsewhereCloneDenial, loadDeskTasks } from "../../../../../plugins/desk/mcp/src/runtime/elsewhere-clone.js"
import { task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
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
// The repository only in the card's `repos:` list, as in the boot acceptance `elsewhere-clone` card: nothing in its text names it, so only a reader that parses `repos:` finds it.
put("lighthouse-relay/listed-only/task.md", card("listed-only", "processing", "ari-fixture/listed-only", "push `listed-branch` from my other laptop, then review the branch here."))
put("lighthouse-relay/finished/task.md", card("finished", "done", "acme/finished-repo", "push the branch from my other laptop."))
test.after(() => { for (const dir of [HOME, DESK, OTHER]) rmSync(dir, { recursive: true, force: true }) })

const env = { HOME }
const verdict = (command, cwd = DESK) => elsewhereCloneDenial({ command, cwd, env })

test("clonedRepos reads the repository of a clone or fetch in every URL form, and of nothing else", () => {
  assert.deepEqual(clonedRepos("cd ~/code && git clone https://github.com/anthropics/claude-code.git claude-code"), ["anthropics/claude-code"])
  assert.deepEqual(clonedRepos("git clone git@github.com:Anthropics/Claude-Code.git"), ["anthropics/claude-code"])
  assert.deepEqual(clonedRepos("git -C /x fetch ssh://git@github.com/anthropics/claude-code relay-heartbeat-15s"), ["anthropics/claude-code"])
  assert.deepEqual(clonedRepos("gh repo clone anthropics/claude-code"), ["anthropics/claude-code"])
  assert.deepEqual(clonedRepos("gh repo clone 'acme/widgets.git' && git fetch https://example.com/a/b"), ["acme/widgets", "a/b"])
  // The verb and the URL must be one command's own: a URL in another command (a pull request, a curl) is no clone.
  assert.deepEqual(clonedRepos("git fetch origin && gh pr view https://github.com/anthropics/claude-code/pull/3"), [])
  assert.deepEqual(clonedRepos("git fetch origin; curl -s https://github.com/anthropics/claude-code.git"), [])
  assert.deepEqual(clonedRepos("git pull origin main | tee https://github.com/anthropics/claude-code"), [])
  assert.deepEqual(clonedRepos("git clone https://github.com/anthropics/claude-code/tree/main"), [])
  assert.deepEqual(clonedRepos("git fetch origin\ngit clone https://github.com/a/b"), ["a/b"])
  assert.deepEqual(clonedRepos("GIT_TERMINAL_PROMPT=0 git -C /x -c core.x=1 clone --depth 1 'https://github.com/a/b.git' dir"), ["a/b"])
  assert.deepEqual(clonedRepos("git --no-pager fetch https://github.com/a/b"), ["a/b"])
  assert.deepEqual(clonedRepos("git --git-dir /x pull https://github.com/a/b"), ["a/b"])
  assert.deepEqual(clonedRepos('bash -c "cd /tmp && git clone https://github.com/a/b.git"'), ["a/b"])
  assert.deepEqual(clonedRepos("/usr/bin/git.exe fetch ssh://git@github.com:22/a/b"), ["a/b"])
  assert.deepEqual(clonedRepos("gh repo clone --help; gh repo clone https://github.com/a/b"), ["a/b"])
  assert.deepEqual(clonedRepos("gh repo clone"), [])
  assert.deepEqual(clonedRepos("git -C; bash -c; git clone; sh -c 'bash -c \"git fetch https://github.com/a/b\"'"), ["a/b"])
  for (const command of ["ls -la", "git status", "git fetch origin", "git clone", "curl https://github.com/anthropics/claude-code", "echo clone https://github.com/a/b", "gh repo view anthropics/claude-code", "git remote add up https://github.com/a/b", "bash -c"]) {
    assert.deepEqual(clonedRepos(command), [], command)
  }
})

test("round W and X: the clone the Copilot agent ran is denied, leading with the action and the branch to ask for", async () => {
  const result = await verdict("cd ~/code && git clone https://github.com/anthropics/claude-code.git claude-code && git -C claude-code branch -a")
  assert.equal(result.deny, true)
  assert.match(result.reason, /^Record relay-heartbeat-15s as pushed with task_update if the operator said so; else ask them to push it\. Do not clone or fetch to look for it\. /u)
  assert.match(result.reason, /task beacon-relay-push-check/u)
  // The way out comes right after the first sentence: record the operator's word in the card, then retry.
  assert.match(result.reason, /\. If the operator's own message in this conversation already says it is pushed, that counts: rewrite the next step with task_update so it no longer says the work is on another machine, then retry, and do not ask again\. /u)
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
    assert.match(result.reason, new RegExp(`^Record ${expected} as pushed with task_update if the operator said so; else ask them to push it\\. `, "u"))
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
  assert.match(result.reason, /^Record the branch as pushed with task_update if the operator said so; else ask them to push it\. Do not clone or fetch to look for it\. .*The card for task blocker-only /u)
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
    assert.match(copilot.permissionDecisionReason, /^Record relay-heartbeat-15s as pushed with task_update/u)
    assert.deepEqual(await protectedCheckoutHook({ tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: DESK }, "claude"), {})
    assert.deepEqual(await protectedCheckoutHook({ tool_name: "Bash", tool_input: { command: "git clone https://github.com/acme/widgets.git" }, cwd: DESK }, "claude"), {})
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  }
})

test("the way out works: a clone is denied, task_update rewrites the next step, and the same clone is then allowed", async () => {
  const command = "git clone https://github.com/acme/rewrite-me.git"
  put("lighthouse-relay/rewrite-me/task.md", card("rewrite-me", "processing", "acme/rewrite-me", "push `fork-branch` from my other laptop."))
  const before = await verdict(command)
  assert.equal(before.deny, true)
  assert.match(before.reason, /task_update/u)
  await task_update({ deskRoot: DESK, input: { track: "lighthouse-relay", slug: "rewrite-me", next_step: "The operator pushed `fork-branch` to the fork; clone it and continue." }, schedulePush: () => {} })
  assert.deepEqual(await verdict(command), { deny: false })
})

test("a command that only mentions a repository URL (a pull request, a curl) is not a clone, even beside a fetch", async () => {
  for (const command of ["git fetch origin && gh pr view https://github.com/anthropics/claude-code/pull/3", "git fetch origin; curl https://github.com/anthropics/claude-code.git"]) {
    assert.deepEqual(await verdict(command), { deny: false }, command)
  }
  for (const command of ["git clone https://github.com/anthropics/claude-code.git", "git fetch https://github.com/anthropics/claude-code.git", "git pull https://github.com/anthropics/claude-code.git relay-heartbeat-15s"]) {
    assert.equal((await verdict(command)).deny, true, command)
  }
})

test("a card that names owner/name is matched by owner/name; a short-name match applies only when the card itself names the repo short", async () => {
  put("lighthouse-relay/owned/task.md", card("owned", "processing", "acme/gizmo", "push it from my other laptop."))
  put("lighthouse-relay/short/task.md", card("short", "processing", "widget-tool", "push it from my other laptop."))
  assert.deepEqual(await verdict("git clone https://github.com/other/gizmo.git"), { deny: false })
  assert.equal((await verdict("git clone https://github.com/acme/gizmo.git")).deny, true)
  assert.equal((await verdict("git clone https://github.com/anyone/widget-tool.git")).deny, true)
  assert.deepEqual(await verdict("git clone https://github.com/anyone/widget.git"), { deny: false })
})

test("the guard fails open: an error reading a card allows the command and the hook never turns it into a deny", async () => {
  const broken = realpathSync(mkdtempSync(path.join(tmpdir(), "elsewhere-broken-")))
  try {
    mkdirSync(path.join(broken, "_meta")); mkdirSync(path.join(broken, "_archive"))
    mkdirSync(path.join(broken, "track", "unreadable", "task.md"), { recursive: true }) // a card that cannot be read as a file
    const command = "git clone https://github.com/anthropics/claude-code.git"
    await assert.rejects(elsewhereCloneDenial({ command, cwd: broken, env: { HOME } }), "the reading itself throws here")
    for (const [input, host] of [[{ tool_name: "Bash", tool_input: { command }, cwd: broken }, "claude"], [{ toolName: "bash", toolArgs: JSON.stringify({ command }), cwd: broken }, "copilot"]]) {
      assert.deepEqual(await protectedCheckoutHook(input, host), {}, host)
    }
    // A malformed card and an unreadable one beside a good card: the good card still decides.
    writeFileSync(path.join(broken, "track", "malformed.md"), "x")
    rmSync(path.join(broken, "track", "unreadable"), { recursive: true })
    mkdirSync(path.join(broken, "track", "bad"), { recursive: true })
    writeFileSync(path.join(broken, "track", "bad", "task.md"), "---\ntitle: [unclosed\nstatus: processing\n---\n")
    assert.deepEqual(await elsewhereCloneDenial({ command, cwd: broken, env: { HOME } }), { deny: false })
  } finally {
    rmSync(broken, { recursive: true, force: true })
  }
})

// Boot acceptance round AA: the hook runs from the plugin folder, where no node_modules is installed. Reading a card's nested `repos:` list needs gray-matter, so the guard restores the runtime pack first (as boot does).
// Under the dependency-free reader every card has no repos, and 4 of 4 `elsewhere-clone` runs cloned freely. The unit tests above run beside node_modules and never saw it.
test("the desk's cards are read only after the runtime dependencies are restored", async () => {
  const calls = []
  const tasks = await loadDeskTasks({ cwd: DESK, env, ensureDependencies: async (given) => { calls.push(given) } })
  assert.deepEqual(calls, [env])
  assert.ok(tasks.some((task) => task.slug === "beacon-relay-push-check"))
  await assert.rejects(loadDeskTasks({ cwd: DESK, env, ensureDependencies: async () => { throw new Error("no pack") } }), /no pack/u)
})

test("the hook run from a bare plugin folder (no node_modules) still denies the clone, and still passes another repository", () => {
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), "elsewhere-bare-")))
  try {
    const plugin = path.join(bare, "desk")
    cpSync(path.resolve(import.meta.dirname, "../../../../../plugins/desk"), plugin, { recursive: true, dereference: true, filter: (file) => path.basename(file) !== "node_modules" })
    const run = (command) => spawnSync(process.execPath, [path.join(plugin, "hooks", "protected-checkout.cjs"), "claude"], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: DESK }),
      env: { PATH: process.env.PATH, HOME: bare, DESK_RUNTIME_CACHE_DIR: path.join(bare, "cache") },
      encoding: "utf8",
    })
    const denied = run("cd ~/code && git clone https://github.com/ari-fixture/listed-only.git listed-only")
    assert.equal(denied.status, 0, denied.stderr)
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny")
    assert.equal(run("git clone https://github.com/acme/widgets.git").stdout.trim(), "{}")
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

test("the first sentence, the way out for an operator who already said it is pushed, fits within 120 characters even with a 30-character branch", async () => {
  const load = async () => [{ slug: "long-branch", repos: [{ name: "gadgets" }], next_step: "push `abcdefghijklmnopqrstuvwxyz1234` from my other laptop.", blocker: "" }]
  const result = await elsewhereCloneDenial({ command: "git clone https://github.com/acme/gadgets.git", cwd: "/nowhere", env: {}, load })
  assert.equal(result.deny, true)
  assertActionable(assert, result.reason)
  assert.match(firstSentence(result.reason), /^Record abcdefghijklmnopqrstuvwxyz1234 as pushed with task_update if the operator said so; else ask them to push it\.$/u)
})
