// Round 9 boot fixes: boot does the work instead of ordering ceremony (AGENTS.md text included, deferred-tool hint
// instead of a desk_status check), readable text output with `--json` for tools, and plain sync wording.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { osEnv } from "../_os_env.js"
import { recordPullOutcome } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { bootOnce, parseBootArgs, repoStates, runBootCli } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { TASKS_SHOWN_CAP, AGENTS_MD_CAP_BYTES, NO_TASK_INSTRUCTION, UNMATCHED_TASK_INSTRUCTION, formatBootText, lastSyncedAt, readAgentsMd, syncSummary, syncWords } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { activeTasks } from "../../../../../plugins/desk/mcp/src/desk/active-tasks.js"
import { DEFERRED_TOOLS_HINT, DEFERRED_TOOLS_LOAD_HINT, deferredToolsHint, deferredToolsLoadHint } from "../../../../../plugins/desk/mcp/src/util/deferred-tools.js"

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const gh = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "unexpected call" }
}

async function desk() {
  const root = await mkTempRoot("desk-boot-round9-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  const dir = path.join(root, "ops", "flash-valves")
  await fs.mkdir(dir, { recursive: true })
  const card = ["schema_version: 1", "title: Flash valves", "status: processing", "created: '2026-01-01T00:00:00Z'", "updated: '2026-01-02T00:00:00Z'", "track: ops", "repos:\n  - name: valves\n    local_path: ~/code/valves\n    mode: local"].join("\n")
  await fs.writeFile(path.join(dir, "task.md"), `---\n${card}\n---\n\nBody.\n`)
  return root
}

const boot = (root, extra = {}) => bootOnce({
  env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
  syncFn: async () => ({ state: "synced" }),
  factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  repoFn: () => ({ states: [], pending: [] }),
  lastSyncFn: () => "2026-09-30T10:00:00.000Z",
  ...extra,
})

// ── AGENTS.md ───────────────────────────────────────────────────────────

test("readAgentsMd returns the desk's AGENTS.md, null without one, and cuts a long file at its last line break inside the cap", async () => {
  const root = await mkTempRoot("desk-agents-")
  assert.equal(readAgentsMd(root), null)
  const file = path.join(root, "AGENTS.md")
  await fs.writeFile(file, "# Rules\n")
  assert.deepEqual(readAgentsMd(root), { path: file, text: "# Rules\n", truncated: false, bytes: 8, shownBytes: 8 })
  assert.equal(AGENTS_MD_CAP_BYTES, 16384)
  await fs.writeFile(file, "x".repeat(AGENTS_MD_CAP_BYTES))
  assert.equal(readAgentsMd(root).truncated, false, "a file of exactly the cap is whole")
  await fs.writeFile(file, "line one\nline two\nline three")
  const cut = readAgentsMd(root, { cap: 22 })
  assert.deepEqual([cut.text, cut.truncated, cut.bytes, cut.shownBytes], ["line one\nline two", true, 28, 17], "cut after the last whole line, never mid-rule")
  await fs.writeFile(file, `${"x".repeat(9)}é and more`)
  assert.equal(readAgentsMd(root, { cap: 10 }).text, "x".repeat(9), "with no line break, half of a two-byte character is dropped, not printed as a replacement mark")
  await fs.writeFile(file, "x".repeat(20))
  assert.equal(readAgentsMd(root, { cap: 4 }).text, "xxxx")
  await fs.writeFile(file, "a \u{FFFD}")
  assert.equal(readAgentsMd(root).text, "a \u{FFFD}", "a replacement character the file itself holds is kept")
})

test("boot carries AGENTS.md in its result, and nothing orders the agent to read it or to confirm desk_status", async () => {
  const root = await desk()
  await fs.writeFile(path.join(root, "AGENTS.md"), "Keep replies short.\n")
  const result = await boot(root)
  assert.equal(result.agents_md.text, "Keep replies short.\n")
  assert.equal(result.instructions.some((line) => /AGENTS\.md/u.test(line)), false)
  assert.equal(result.instructions.some((line) => /Confirm this session can call/u.test(line)), false)
  assert.equal(result.instructions.filter((line) => line === DEFERRED_TOOLS_HINT).length, 1)
  const throwing = await boot(root, { agentsFn: () => { throw new Error("denied") } })
  assert.equal(throwing.agents_md, null)
})

const CALL_IT = " Once a lookup returns a Desk tool it is loaded: call it directly as a tool, never through Bash, Node or file edits. If the card cannot be updated, say so in your reply and give the task's real status."

test("boot's tool-naming instruction, on both hosts, says a looked-up tool is loaded and is called directly, never through Bash, Node or file edits, and that an unupdated card is said so with the real status", () => {
  for (const host of ["claude", "copilot", "unknown"]) {
    const hint = deferredToolsHint(host)
    assert.ok(hint.endsWith(CALL_IT), host)
    assert.match(hint, /Once a lookup returns a Desk tool it is loaded: call it directly as a tool, never through Bash, Node or file edits/u)
    assert.match(hint, /If the card cannot be updated, say so in your reply and give the task's real status/u)
  }
})

test("the deferred-tools hint names the exact Desk tools for the host it runs on", () => {
  assert.match(deferredToolsLoadHint("claude"), /^If your host defers tools.*\(Claude Code: ToolSearch `select:/su)
  assert.match(deferredToolsLoadHint("claude"), /mcp__plugin_desk_desk__task_update,mcp__plugin_desk_desk__desk_status/u)
  assert.doesNotMatch(deferredToolsLoadHint("claude"), /desk-task_update/u)
  // Copilot CLI exposes the server `desk` and the tool as `desk-task_update` (round I event logs); it has no ToolSearch.
  const copilot = deferredToolsLoadHint("copilot")
  assert.match(copilot, /`desk-task_update`/u)
  assert.match(copilot, /never through the shell/u)
  assert.doesNotMatch(copilot, /ToolSearch|mcp__plugin_desk_desk__/u)
  // No length comparison: what makes the Copilot hint right is what it names and omits (above), not how it compares in size with the Claude one.
  // Codex and an unknown host (and the hostless git hook) get both names.
  for (const host of ["codex", "unknown", undefined]) {
    assert.match(deferredToolsLoadHint(host), /ToolSearch `select:mcp__plugin_desk_desk__task_update/u)
    assert.match(deferredToolsLoadHint(host), /`desk-<name>`, such as `desk-task_update`/u)
  }
  assert.equal(DEFERRED_TOOLS_LOAD_HINT, deferredToolsLoadHint("unknown"))
  assert.equal(deferredToolsHint("copilot"), `${copilot} If a Desk tool is still absent after that, repair first (see the session-start skill) and never continue silently in local-only mode.${CALL_IT}`)
  assert.ok(DEFERRED_TOOLS_HINT.startsWith(DEFERRED_TOOLS_LOAD_HINT))
  assert.match(DEFERRED_TOOLS_HINT, /never continue silently in local-only mode/u)
})

// ── Sync wording ────────────────────────────────────────────────────────

test("syncSummary says plainly what happened: a failure pulled and pushed nothing and names when the desk was last current", () => {
  const asOf = "2026-09-30T10:00:00.000Z"
  const failed = (cause) => syncSummary({ sync: { state: "unresolved", cause }, lastSyncAt: asOf })
  assert.equal(failed("unreachable"), `sync failed: remote unreachable; nothing was pulled or pushed; local desk is as of ${asOf}`)
  assert.match(failed("auth_failed"), /^sync failed: remote refused this host's credentials; nothing was pulled or pushed/u)
  assert.match(failed("deadline"), /^sync failed: git timed out;/u)
  assert.match(failed("conflict"), /^sync failed: the pull hit a conflict;/u)
  assert.match(failed("diverged"), /^sync failed: the desk and its remote have diverged;/u)
  assert.match(failed("other"), /^sync failed: the pull did not complete;/u)
  assert.match(syncSummary({ sync: { state: "unresolved", cause: "unreachable" } }), /local desk is as of unknown$/u)
  assert.match(syncSummary({ sync: null, timedOut: true }), /^sync failed: it did not finish within the boot's time budget; nothing was pulled or pushed; local desk is as of unknown$/u)
  assert.match(syncSummary({ sync: null }), /^sync failed: it did not run;/u)
  assert.match(syncSummary({ sync: undefined }), /^sync failed: it did not run;/u)
  assert.equal(syncSummary({ sync: { state: "synced" } }), "sync ok")
  assert.equal(syncSummary({ sync: { state: "synced", nothingToSync: "no_remote" } }), "no remote; nothing to sync")
  assert.equal(syncSummary({ sync: { state: "synced", nothingToSync: "no_upstream" } }), "no upstream branch; nothing to sync")
  const moved = ["_cache/stray-2026-09-30/a.md", "_cache/stray-2026-09-30/b.md"]
  assert.equal(syncSummary({ sync: { state: "quarantined", quarantinedPaths: moved }, root: "/work/desk" }), "sync ok: moved 2 stray untracked paths to /work/desk/_cache/stray-2026-09-30/ first, then pulled")
  assert.equal(syncSummary({ sync: { state: "quarantined", quarantinedPaths: [moved[0]] } }), "sync ok: moved 1 stray untracked path to _cache/stray-2026-09-30/ first, then pulled")
  assert.equal(syncSummary({ sync: { state: "quarantined" } }), "sync ok: moved 0 stray untracked paths to _cache/ first, then pulled")
})

test("syncSummary tells a pop conflict (the pull worked) from a failed pull, and says where quarantined files went", () => {
  const pop = syncSummary({ sync: { state: "unresolved", reason: "autostash_pop_conflict", cause: "conflict", conflicted: ["a.md", "b.md"] }, lastSyncAt: "2026-09-30T10:00:00.000Z" })
  assert.equal(pop, "sync: the pull succeeded, but the desk's uncommitted local changes conflict with what came in (conflicted: a.md, b.md); nothing was pushed; resolve them before changing the desk")
  assert.doesNotMatch(pop, /sync failed|nothing was pulled/u)
  assert.match(syncSummary({ sync: { state: "unresolved", reason: "autostash_pop_conflict_after_quarantine", conflicted: [], quarantinedPaths: ["_cache/stray-d/x"] }, root: "/d" }), /^sync: the pull succeeded, but the desk's uncommitted local changes conflict with what came in; nothing was pushed; resolve them before changing the desk \(1 stray untracked path had been moved to \/d\/_cache\/stray-d\/ first\)$/u)
  assert.match(syncSummary({ sync: { state: "unresolved", reason: "pull_rebase_failed_after_quarantine", cause: "conflict", quarantinedPaths: ["_cache/stray-d/x", "_cache/stray-d/y"] }, root: "/d" }), /^sync failed: the pull hit a conflict; nothing was pulled or pushed; local desk is as of unknown \(2 stray untracked paths had been moved to \/d\/_cache\/stray-d\/ first\)$/u)
})

test("boot reports the sync summary for a failed sync, a timed-out one and one whose last-fetch lookup throws", async () => {
  const root = await desk()
  const failed = await boot(root, { syncFn: async () => ({ state: "unresolved", cause: "unreachable", reason: "pull_rebase_failed" }) })
  assert.equal(failed.sync_summary, "sync failed: remote unreachable; nothing was pulled or pushed; local desk is as of 2026-09-30T10:00:00.000Z")
  const unknown = await boot(root, { syncFn: async () => ({ state: "unresolved", cause: "unreachable" }), lastSyncFn: () => { throw new Error("no git") } })
  assert.match(unknown.sync_summary, /local desk is as of unknown$/u)
  const slow = await boot(root, { budgetMs: 1, syncFn: () => new Promise(() => {}) })
  assert.match(slow.sync_summary, /did not finish within the boot's time budget/u)
  const threw = await boot(root, { syncFn: async () => { throw new Error("boom") } })
  assert.match(threw.sync_summary, /^sync failed: it did not run/u)
})

test("lastSyncedAt reads the recorded last success, never FETCH_HEAD, and is null without a usable record", () => {
  const at = "2026-09-30T10:00:00.000Z"
  const reads = (status) => lastSyncedAt({ root: "/d", env: {} }, { readStatus: () => status })
  assert.equal(reads({ last_success_at: at }), at)
  assert.equal(reads({ last_success_at: "not a time" }), null)
  assert.equal(reads({ last_success_at: 5 }), null)
  assert.equal(reads({ last_pull: { state: "unresolved" } }), null)
  assert.equal(reads(null), null)
  assert.equal(lastSyncedAt({ root: "/d", env: {} }, { readStatus: () => { throw new Error("bad json") } }), null)
})

test("a failed fetch that bumps FETCH_HEAD does not move the 'as of' time: only a real success does", async () => {
  const root = await mkTempRoot("desk-lastsync-")
  const state = await mkTempRoot("desk-lastsync-state-")
  const env = osEnv({ DESK: root, XDG_STATE_HOME: state, HOME: state })
  execFileSync("git", ["init", "-q", root])
  assert.equal(lastSyncedAt({ root, env }), null, "never synced")
  recordPullOutcome({ root, env, result: { state: "synced" } })
  const first = lastSyncedAt({ root, env })
  assert.match(first, /^\d{4}-\d{2}-\d{2}T/u)
  // The failed fetch touches FETCH_HEAD, as git does, and the pull is recorded as failed.
  await fs.writeFile(path.join(root, ".git", "FETCH_HEAD"), "")
  const later = new Date(Date.parse(first) + 3600_000)
  await fs.utimes(path.join(root, ".git", "FETCH_HEAD"), later, later)
  recordPullOutcome({ root, env, result: { state: "unresolved", cause: "unreachable", reason: "pull_rebase_failed" } })
  assert.equal(lastSyncedAt({ root, env }), first, "FETCH_HEAD's newer mtime is not the sync time")
  recordPullOutcome({ root, env, result: { state: "unresolved" } })
  assert.equal(lastSyncedAt({ root, env }), first, "a failure with no reason or cause still keeps the last success")
  recordPullOutcome({ root, env, result: { state: "synced", nothingToSync: "no_remote" } })
  assert.equal(lastSyncedAt({ root, env }), first, "a desk with nothing to sync records no success")
  recordPullOutcome({ root, env, result: { state: "quarantined", quarantinedPaths: [] } })
  assert.ok(Date.parse(lastSyncedAt({ root, env })) >= Date.parse(first))
})

test("repoStates marks a clone with no remote at all as local-only, and nothing else", () => {
  const card = { track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "r", local_path: "/clones/r", mode: "local" }] } }
  const states = (remotes) => repoStates({
    cards: [card], now: () => 0, deadline: 60000,
    spawnGit: (cmd, args) => (args.includes("remote") ? remotes : args.includes("status") ? { status: 0, stdout: "## main\n" } : { status: 1, stdout: "" }),
  }).states[0]
  assert.equal(states({ status: 0, stdout: "\n" }).local_only, true)
  assert.equal(states({ status: 0, stdout: "origin\n" }).local_only, undefined)
  assert.equal(states({ status: 1, stdout: "" }).local_only, undefined)
  assert.equal(states({ status: 0, stdout: null }).local_only, undefined)
  assert.equal(states(undefined).local_only, undefined)
})

// ── Readable output ─────────────────────────────────────────────────────

function sampleResult(extra = {}) {
  return {
    status: "degraded",
    degraded: ["sync: unresolved (unreachable)", "card: bad"],
    pending: ["repo state for r: boot_budget_exceeded"],
    instructions: ["First thing.", "Second thing."],
    root: { path: "/work/desk", source: "env" },
    host: { hostname: "mac", user: "ari", agent: "claude" },
    push_accounts: [
      { track: "ops", slug: "flash-valves", repo: "valves", store: "acme/valves", result: "account_found", account: "ari", route: "direct" },
      { track: "ops", slug: "other-task", repo: "valves", store: "acme/valves", result: "account_found", account: "ari", route: "direct" },
      { desk: "crew", track: "<redacted segment>", slug: "<redacted segment>", repo: "forked", store: "acme/forked", result: "account_found", account: "me", route: "fork" },
      { track: "ops", slug: "flash-valves", repo: "valves-again", store: "acme/valves", result: "account_found", account: "ari", route: "direct" },
      { track: "ops", slug: "flash-valves", repo: "plain", store: "acme/plain", result: "account_found", account: "ari" },
      { track: "ops", slug: "flash-valves", repo: "x", store: "acme/x", result: "no_account_can_deliver" },
      { track: "ops", slug: "flash-valves", repo: "local", result: "not_a_github_repo" },
      { track: "ops", slug: "flash-valves", repo: "slow", store: "acme/slow", result: "pending", reason: "boot_budget_exceeded" },
      { track: "ops", slug: "flash-valves", repo: "odd", store: "acme/odd", result: "gh_failed" },
    ],
    sync_summary: "sync failed: remote unreachable; nothing was pulled or pushed; local desk is as of unknown",
    active_tasks: {
      task_count: 2,
      tracks: [
        { track: "ops", tasks: [{ slug: "flash-valves", title: "Flash valves", status: "processing", updated: "2026-09-28T15:30:00Z", handle: "task-1", next_step: "Wire the relay, then run the suite." }, { slug: "same", title: "same", status: null, updated: null, handle: "task-2" }] },
        { desk: "crew", track: "<redacted segment>", tasks: [{ slug: "<redacted segment>", title: null, status: "drafting", updated: null, handle: "task-3" }] },
      ],
    },
    open_prs: [{ store: "acme/w", number: 4, title: "Fix it", draft: true, review: "REVIEW_REQUIRED", url: "https://github.com/acme/w/pull/4" }, { store: "acme/w", number: 5, title: "Plain", draft: false, review: null, url: "https://github.com/acme/w/pull/5" }],
    repo_states: [
      { track: "ops", slug: "flash-valves", repo: "valves", present: true, branch: "main", dirty: true, fetched: true },
      { track: "ops", slug: "flash-valves", repo: "other", present: true, branch: null, dirty: false, fetched: false },
      { track: "ops", slug: "flash-valves", repo: "solo", present: true, branch: "feature/x", dirty: false, fetched: false, local_only: true },
      { desk: "crew", track: "t", slug: "s", repo: "gone", local_path: "~/code/gone", url: "https://example.com/g.git", present: false },
      { track: "ops", slug: "flash-valves", repo: "gone2", local_path: "~/code/gone2", present: false },
    ],
    task: null,
    agents_md: { path: "/work/desk/AGENTS.md", text: "Rule one.\n\n", truncated: false },
    ...extra,
  }
}

test("formatBootText leads with the work: one status line, then the tasks by state, then the instructions and the desk's AGENTS.md", () => {
  const text = formatBootText(sampleResult())
  const order = ["Desk boot: degraded (sync failed: remote unreachable; showing local state and card: bad) | desk /work/desk (bound by env) | host mac / ari / claude", "- pending (not finished in time, carry it): repo state", "Active tasks (2):", "Open pull requests:", "Repos of open tasks:", "Instructions, in order:", "1. First thing.", "2. Second thing.", "## The desk's AGENTS.md (/work/desk/AGENTS.md)"]
  let at = -1
  for (const piece of order) {
    const next = text.indexOf(piece)
    assert.ok(next > at, `${piece} comes after the previous section`)
    at = next
  }
  assert.doesNotMatch(text, /- degraded: sync: /u, "the status line already says why the sync failed")
  assert.doesNotMatch(text, /- degraded: card: bad\n/u, "the headline already names it")
  assert.doesNotMatch(text, /Desk synced|Desk could not sync/u, "a failed sync is never worded as a sync")
  assert.doesNotMatch(text, /Push routes:|Desk: \/work\/desk|\nHost: /u, "the push routes sit on their tasks, and desk and host are on the status line")
  assert.match(text, /\nprocessing \(1\)\n- ops\/flash-valves "Flash valves" \(updated 2026-09-28\)\n  next: Wire the relay, then run the suite\.\n  push: acme\/x: no signed-in account can push\. Do not push; ask the operator which account to use, or fork\. Say this route in one line when you report on the task\.\n  push: acme\/slow: push route not checked in time/u)
  assert.match(text, /  push: acme\/odd: push access could not be checked \(gh_failed\); verify with `gh auth status` before pushing\.\n/u)
  assert.doesNotMatch(text, /no GitHub remote/u, "a repo with no GitHub remote has no route to print")
  assert.doesNotMatch(text, /acme\/valves|acme\/plain/u, "a plain direct push by the active account has no line")
  assert.match(text, /\nno status \(1\)\n- ops\/same\n  next: no next step recorded\n/u)
  assert.match(text, /\ndrafting \(1\)\n- crew\/<redacted segment>\/<redacted segment> \(handle task-3\)\n  next: no next step recorded\n  push: acme\/forked: push as me via fork me\/forked\. Push your branch to the fork and open the pull request from it; never push to acme\/forked itself\. Say this route in one line when you report on the task\.\n/u)
  assert.match(text, /- acme\/w#4 Fix it \(draft\), REVIEW_REQUIRED: https:\/\/github\.com\/acme\/w\/pull\/4\n/u)
  assert.match(text, /- acme\/w#5 Plain: /u)
  assert.match(text, /- valves \(ops\/flash-valves\): branch main, uncommitted changes, fetched\n/u)
  assert.match(text, /- other \(ops\/flash-valves\): branch unknown, clean, fetch failed\n/u)
  assert.match(text, /- solo \(ops\/flash-valves\): branch feature\/x, clean, no remote configured\n/u)
  assert.match(text, /- gone \(crew\/t\/s\): not at ~\/code\/gone; clone url https:\/\/example\.com\/g\.git\n/u)
  assert.match(text, /- gone2 \(ops\/flash-valves\): not at ~\/code\/gone2\n/u)
  assert.match(text, /\n## The desk's AGENTS\.md \(\/work\/desk\/AGENTS\.md\); its rules bind this session\n\nRule one\.\n$/u)
  assert.doesNotMatch(text, /^-----$/mu, "no fence for the file's own text to collide with")
  assert.doesNotMatch(text, /Cut at/u)
})

test("syncWords says the sync in plain words and passes any other wording through", () => {
  assert.equal(syncWords("sync ok"), "Desk synced with origin")
  assert.equal(syncWords("sync ok: moved 2 stray untracked paths to /d/_cache/stray-x/ first, then pulled"), "Desk synced with origin (moved 2 stray untracked paths to /d/_cache/stray-x/ first)")
  assert.equal(syncWords("sync failed: remote unreachable; nothing was pulled or pushed; local desk is as of unknown"), "Desk could not sync: remote unreachable; local state shown")
  assert.equal(syncWords("sync failed: git timed out; nothing was pulled or pushed; local desk is as of 2026-09-30T10:00:00.000Z (1 stray untracked path had been moved to /d/_cache/stray-d/ first)"), "Desk could not sync: git timed out; local state shown, as of 2026-09-30T10:00:00.000Z (1 stray untracked path had been moved to /d/_cache/stray-d/ first)")
  assert.equal(syncWords("no remote; nothing to sync"), "Desk has no remote; nothing to sync")
  assert.equal(syncWords("no upstream branch; nothing to sync"), "Desk has no upstream branch; nothing to sync")
  assert.equal(syncWords("sync: the pull succeeded, but the desk's uncommitted local changes conflict with what came in (conflicted: a.md); nothing was pushed; resolve them before changing the desk"), "Desk pulled from origin, but the desk's uncommitted local changes conflict with what came in (conflicted: a.md); nothing was pushed; resolve them before changing the desk")
  assert.equal(syncWords("something else"), "something else")
  assert.equal(syncWords(null), null)
  assert.equal(syncWords(""), null)
})

test("blocked tasks sit under their own marked heading, ahead of the other states, and every state is a heading", () => {
  const text = formatBootText({ status: "ready", active_tasks: { task_count: 3, tracks: [{ track: "ops", tasks: [
    { slug: "a", title: "a", status: "processing", updated: "2026-09-28T00:00:00Z", next_step: "go" },
    { slug: "b", title: "b", status: "blocked", updated: "2026-09-01T00:00:00Z", blocker: "the key" },
    { slug: "c", title: "c", status: "drafting", updated: "2026-09-27T00:00:00Z" },
  ] }] } })
  assert.match(text, /Active tasks \(3\):\n\nBLOCKED \(1\): these cannot move until the blocker clears\n- ops\/b \(updated 2026-09-01\)\n  blocker: the key\n\nprocessing \(1\)\n- ops\/a \(updated 2026-09-28\)\n  next: go\n\ndrafting \(1\)\n- ops\/c \(updated 2026-09-27\)\n  next: no next step recorded\n/u)
})

test("formatBootText marks a cut AGENTS.md with the path to the rest, and skips what it does not have", () => {
  const cut = formatBootText(sampleResult({ agents_md: { path: "/work/desk/AGENTS.md", text: "start\n-----\nmiddle", truncated: true, bytes: 30000, shownBytes: 20 } }))
  assert.match(cut, /\[Cut after 20 of 30000 bytes \(limit 16 KB\): read the rest at \/work\/desk\/AGENTS\.md\]\n$/u)
  assert.match(cut, /start\n-----\nmiddle\n\n\[Cut/u, "a rule line inside the file is just text")
  const bare = formatBootText({ status: "ready" })
  assert.equal(bare, "Desk boot: ready\n\nActive tasks: unavailable (see degraded)\n")
  const empty = formatBootText({ status: "ready", active_tasks: { task_count: 0, tracks: [] }, root: { path: "/d" }, host: {} })
  assert.match(empty, /^Desk boot: ready \| desk \/d \| host unknown \/ unknown \/ unknown\n/u)
  assert.match(empty, /Active tasks \(0\):\n- none\n/u)
})

test("formatBootText shows the named task, an ambiguous name and a name that matches nothing", () => {
  const resolved = formatBootText(sampleResult({ task: { status: "resolved", task: { track: "ops", slug: "flash-valves", status: "processing", card: "ops/flash-valves/task.md" } } }))
  assert.match(resolved, /Named task: ops\/flash-valves \(processing\), card ops\/flash-valves\/task\.md\n/u)
  const ambiguous = formatBootText(sampleResult({ task: { status: "ambiguous", candidates: [{ track: "a", slug: "x" }, { track: "b", slug: "y" }] } }))
  assert.match(ambiguous, /Named task: ambiguous, matches a\/x, b\/y\n/u)
  assert.match(formatBootText(sampleResult({ task: { status: "not_found" } })), /Named task: matches no open task\n/u)
})

test("runBootCli prints readable text by default and the one-line JSON with --json", async () => {
  const root = await desk()
  await fs.writeFile(path.join(root, "AGENTS.md"), "Be brief.\n")
  const run = async (argv) => {
    let written = ""
    const code = await runBootCli({ argv, env: { DESK: root }, io: { stdout: { write: (text) => { written += text } } }, bootFn: (options) => boot(root, options) })
    assert.equal(code, 0)
    return written
  }
  const text = await run([])
  assert.match(text, /^Desk boot: ready \| desk /u)
  assert.match(text, /Instructions, in order:\n1\. Use \S+ as the desk path in every command/u)
  assert.match(text, /Be brief\./u)
  assert.throws(() => JSON.parse(text))
  const json = JSON.parse(await run(["--json"]))
  assert.equal(json.status, "ready")
  assert.equal(Object.hasOwn(json, "text_instructions"), false, "the text-only wording stays out of --json")
  assert.ok(Array.isArray(json.instructions))
  assert.equal(json.agents_md.text, "Be brief.\n")
  const failing = []
  await runBootCli({ env: {}, io: { stdout: { write: (text) => failing.push(text) } }, bootFn: async () => { throw new Error("kaput") } })
  assert.match(failing[0], /^Desk boot: degraded \(boot: kaput\)\n\nActive tasks: unavailable/u)
})

test("the shipped script prints text by default and JSON with --json", async () => {
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-boot.js", import.meta.url))
  const home = await mkTempRoot("desk-boot-text-home-")
  const env = { ...process.env, HOME: home, DESK: "", CLAUDE_PROJECT_DIR: "", DESK_ACTIVATION_CONFIG: "", CODEX_HOME: "", CLAUDE_PLUGIN_DATA: "" }
  const text = execFileSync(process.execPath, [script], { encoding: "utf8", cwd: home, env })
  assert.match(text, /^Desk boot: setup_required\b/u)
  assert.match(text, /1\. No desk is bound on this host/u)
  assert.equal(JSON.parse(execFileSync(process.execPath, [script, "--json"], { encoding: "utf8", cwd: home, env })).status, "setup_required")
})

// ── Review fixes ────────────────────────────────────────────────────────

test("parseBootArgs: a flag after --task is never the task name", () => {
  assert.deepEqual(parseBootArgs(["--task", "--json"]), { taskQuery: null, json: true })
  assert.deepEqual(parseBootArgs(["--json", "--task", "flash"]), { taskQuery: "flash", json: true })
  assert.deepEqual(parseBootArgs(["--task"]), { taskQuery: null, json: false })
  assert.deepEqual(parseBootArgs(["--task", "  "]), { taskQuery: null, json: false })
})

test("boot hands every card to the local-only recorder, and a recorder that throws never degrades the boot", async () => {
  const root = await desk()
  const seen = []
  const ok = await boot(root, { localOnlyFn: async (args) => { seen.push(args) } })
  assert.equal(ok.status, "ready")
  assert.equal(seen.length, 1)
  assert.equal(seen[0].deskRoot, root)
  assert.equal(seen[0].cards.length, 1)
  const threw = await boot(root, { localOnlyFn: async () => { throw new Error("denied") } })
  assert.equal(threw.status, "ready")
})

test("active_tasks carries each task's next step on one line, whole and redacted, and null when the card has none", async () => {
  const root = await mkTempRoot("desk-next-step-")
  const card = (slug, body) => fs.mkdir(path.join(root, "ops", slug), { recursive: true }).then(() => fs.writeFile(path.join(root, "ops", slug, "task.md"), `---\ntitle: ${slug}\nstatus: processing\nupdated: '2026-01-02T00:00:00Z'\n---\n\n${body}`))
  await card("with-step", "Intro.\n\n**Next step:** Wire the relay\nthen run the suite.\n\n- a list item\n")
  await card("long-step", `**Next step:** ${"word ".repeat(80)}\n`)
  await card("no-step", "Just a body.\n")
  await card("empty-step", "**Next step:**\n\nMore.\n")
  await card("secret-step", "**Next step:** use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to push\n")
  const tasks = Object.fromEntries(activeTasks(root).tracks[0].tasks.map((task) => [task.slug, task.next_step]))
  assert.equal(tasks["with-step"], "Wire the relay then run the suite.")
  assert.equal(tasks["long-step"], "word ".repeat(80).trim(), "a long next step is kept whole")
  assert.equal(tasks["no-step"], null)
  assert.equal(tasks["empty-step"], null)
  assert.doesNotMatch(tasks["secret-step"], /ghp_abcdefghijklmnopqrstuvwxyz0123456789/u)
})

test("plain-text boot with no named task tells the agent to report every task under Active tasks, without the JSON field names; --json keeps them", () => {
  const noTask = { status: "ready", instructions: [NO_TASK_INSTRUCTION, UNMATCHED_TASK_INSTRUCTION] }
  const text = formatBootText(noTask)
  assert.match(text, /1\. No task was named: report every task under "Active tasks" above, each with its status and its next step or blocker/u)
  assert.match(text, /then ask which one to resume or whether to start new\./u)
  assert.match(text, /2\. The name matches no open task: report every task under "Active tasks" above/u)
  assert.doesNotMatch(text, /active_tasks|open_prs|repo_states/u)
  // The structured result keeps the field names for JSON consumers.
  assert.match(NO_TASK_INSTRUCTION, /active_tasks, open_prs and repo_states/u)
})

test("the named task is always shown first with its push route, even when it ranks below the cap", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ slug: `t${index}`, title: `t${index}`, status: "processing", updated: `2026-09-${String(10 + index).padStart(2, "0")}T00:00:00Z`, next_step: "n" }))
  const named = { ...rows[0], slug: "oldest" }
  rows[0] = named
  const result = {
    status: "ready",
    active_tasks: { task_count: 20, tracks: [{ track: "ops", tasks: rows }] },
    task: { status: "resolved", task: { track: "ops", slug: "oldest", status: "processing", card: "ops/oldest/task.md" } },
    push_accounts: [{ track: "ops", slug: "oldest", repo: "r", store: "acme/r", result: "account_found", account: "me", route: "fork", accounts: [{ account: "me" }] }],
  }
  const text = formatBootText(result)
  assert.deepEqual([...text.matchAll(/^- ops\/(\S+)/gmu)].map((match) => match[1]), ["oldest"], "a named task is shown alone, with one line for the rest")
  assert.match(text, /- ops\/oldest [^\n]*\n  next: n\n  push: acme\/r: push as me via fork me\/r\./u)
  assert.match(text, /\nOther active tasks: 19 \(say 'where were we' to list them\)/u)
  // Ambiguous and unmatched names keep the full capped list.
  const full = formatBootText({ ...result, task: { status: "ambiguous", candidates: [{ track: "ops", slug: "a" }, { track: "ops", slug: "b" }] } })
  assert.equal([...full.matchAll(/^- ops\/(\S+)/gmu)].length, TASKS_SHOWN_CAP)
  assert.match(full, /\n\.\.\.and 5 more active tasks/u)
  const unnamed = formatBootText({ ...result, task: null })
  assert.ok(!unnamed.includes("- ops/oldest"), "without a name the oldest task falls under the cap")
  const last = formatBootText({ ...result, task: { status: "resolved", task: { track: "ops", slug: "t19", card: "c" } } })
  assert.equal([...last.matchAll(/^- ops\/(\S+)/gmu)][0][1], "t19")
})

test("a sync call that threw keeps its error on the status line, and a thrown reason replaces 'it did not run'", () => {
  const text = formatBootText({ status: "degraded", degraded: ["sync: spawn git ENOENT"], sync_summary: "sync failed: it did not run; nothing was pulled or pushed; local desk is as of unknown" })
  assert.match(text, /^Desk boot: degraded \(sync failed: spawn git ENOENT; showing local state\)\n/u)
  assert.doesNotMatch(text, /- degraded: sync/u)
})

test("the headline names what failed, caps itself, and lists a long entry below; an auth warning prints as a warning", () => {
  const long = `auth: ${"x".repeat(90)}`
  const text = formatBootText({ status: "degraded", degraded: ["a: 1", "b: 2", "c: 3", "d: 4", long], pending: ["auth: Could not verify GitHub sign-in (rate limited); continuing; pushes may fail until it clears"] })
  assert.match(text, /^Desk boot: degraded \(a: 1 and b: 2 and c: 3 and 2 more\)\n/u)
  assert.match(text, /\n- degraded: d: 4\n- degraded: auth: x{90}\n/u)
  assert.match(text, /\n- warning: Could not verify GitHub sign-in \(rate limited\); continuing; pushes may fail until it clears\n/u)
  assert.match(formatBootText({ status: "degraded", sync_summary: "sync: the pull succeeded, but local changes conflict" }), /^Desk boot: degraded \| Desk pulled from origin, but local changes conflict\n/u)
  assert.match(formatBootText({ status: "ready", sync_summary: "sync ok" }), /^Desk boot: ready \| Desk synced with origin\n/u)
})
