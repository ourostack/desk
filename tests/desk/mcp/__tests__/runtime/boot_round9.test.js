// Round 9 boot fixes: boot does the work instead of ordering ceremony (AGENTS.md text included, deferred-tool hint
// instead of a desk_status check), readable text output with `--json` for tools, and plain sync wording.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce, repoStates, runBootCli } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { AGENTS_MD_CAP_BYTES, formatBootText, lastSyncedAt, readAgentsMd, syncSummary } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { DEFERRED_TOOLS_HINT, DEFERRED_TOOLS_LOAD_HINT } from "../../../../../plugins/desk/mcp/src/util/deferred-tools.js"

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

test("readAgentsMd returns the desk's AGENTS.md, null without one, and cuts a long file at the cap on a character boundary", async () => {
  const root = await mkTempRoot("desk-agents-")
  assert.equal(readAgentsMd(root), null)
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Rules\n")
  assert.deepEqual(readAgentsMd(root), { path: path.join(root, "AGENTS.md"), text: "# Rules\n", truncated: false })
  await fs.writeFile(path.join(root, "AGENTS.md"), "x".repeat(AGENTS_MD_CAP_BYTES))
  assert.equal(readAgentsMd(root).truncated, false, "a file of exactly the cap is whole")
  assert.equal(AGENTS_MD_CAP_BYTES, 6144)
  await fs.writeFile(path.join(root, "AGENTS.md"), "x".repeat(AGENTS_MD_CAP_BYTES + 1))
  const cut = readAgentsMd(root)
  assert.equal(cut.truncated, true)
  assert.equal(cut.text.length, AGENTS_MD_CAP_BYTES)
  await fs.writeFile(path.join(root, "AGENTS.md"), `${"x".repeat(AGENTS_MD_CAP_BYTES - 1)}é and more`)
  const split = readAgentsMd(root)
  assert.equal(split.truncated, true)
  assert.equal(split.text, "x".repeat(AGENTS_MD_CAP_BYTES - 1), "half of a two-byte character is dropped, not printed as a replacement mark")
  assert.equal(readAgentsMd(root, { cap: 4 }).text, "xxxx")
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

test("the deferred-tools hint names ToolSearch select: with the exact Desk tools", () => {
  assert.match(DEFERRED_TOOLS_LOAD_HINT, /ToolSearch `select:` naming the exact tools/u)
  assert.match(DEFERRED_TOOLS_LOAD_HINT, /mcp__plugin_desk_desk__task_update,mcp__plugin_desk_desk__desk_status/u)
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
  assert.equal(syncSummary({ sync: { state: "quarantined", quarantinedPaths: ["a"] } }), "sync ok: moved 1 stray untracked path to _cache/ first, then pulled")
  assert.equal(syncSummary({ sync: { state: "quarantined", quarantinedPaths: ["a", "b"] } }), "sync ok: moved 2 stray untracked paths to _cache/ first, then pulled")
  assert.equal(syncSummary({ sync: { state: "quarantined" } }), "sync ok: moved 0 stray untracked paths to _cache/ first, then pulled")
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

test("lastSyncedAt reads FETCH_HEAD's modified time, and is null when git or the file is missing", () => {
  const when = Date.parse("2026-09-30T10:00:00.000Z")
  assert.equal(lastSyncedAt("/d", { runGit: () => "/d/.git\n", stat: (file) => { assert.equal(file, "/d/.git/FETCH_HEAD"); return { mtimeMs: when } } }), "2026-09-30T10:00:00.000Z")
  assert.equal(lastSyncedAt("/d", { runGit: () => { throw new Error("not a repo") } }), null)
  assert.equal(lastSyncedAt("/d", { runGit: () => "/d/.git", stat: () => { throw new Error("ENOENT") } }), null)
})

test("lastSyncedAt answers for a real desk repository with the defaults", async () => {
  const root = await mkTempRoot("desk-lastsync-")
  assert.equal(lastSyncedAt(root), null)
  execFileSync("git", ["init", "-q", root])
  assert.equal(lastSyncedAt(root), null, "never fetched")
  await fs.writeFile(path.join(root, ".git", "FETCH_HEAD"), "")
  assert.match(lastSyncedAt(root), /^\d{4}-\d{2}-\d{2}T/u)
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
    degraded: ["sync: unresolved (unreachable)"],
    pending: ["repo state for r: boot_budget_exceeded"],
    instructions: ["First thing.", "Second thing."],
    root: { path: "/work/desk", source: "env" },
    host: { hostname: "mac", user: "ari", agent: "claude" },
    sync_summary: "sync failed: remote unreachable; nothing was pulled or pushed; local desk is as of unknown",
    active_tasks: {
      task_count: 2,
      tracks: [
        { track: "ops", tasks: [{ slug: "flash-valves", title: "Flash valves", status: "processing", updated: "2026-09-28T15:30:00Z", handle: "task-1" }, { slug: "same", title: "same", status: null, updated: null, handle: "task-2" }] },
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

test("formatBootText leads with the status and the numbered instructions, then the data and the desk's AGENTS.md", () => {
  const text = formatBootText(sampleResult())
  const order = ["Desk boot: degraded", "- degraded: sync: unresolved (unreachable)", "- pending (not finished in time, carry it): repo state", "Desk: /work/desk (bound by env)", "Host: mac / ari / claude", "Instructions, in order:", "1. First thing.", "2. Second thing.", "sync failed: remote unreachable", "Active tasks (2):", "Open pull requests:", "Repos of open tasks:", "AGENTS.md (/work/desk/AGENTS.md)"]
  let at = -1
  for (const piece of order) {
    const next = text.indexOf(piece)
    assert.ok(next > at, `${piece} comes after the previous section`)
    at = next
  }
  assert.match(text, /- ops\/flash-valves "Flash valves": processing, updated 2026-09-28\n/u)
  assert.match(text, /- ops\/same: no status\n/u)
  assert.match(text, /- crew\/<redacted segment>\/<redacted segment>: drafting \(handle task-3\)\n/u)
  assert.match(text, /- acme\/w#4 Fix it \(draft\), REVIEW_REQUIRED: https:\/\/github\.com\/acme\/w\/pull\/4\n/u)
  assert.match(text, /- acme\/w#5 Plain: /u)
  assert.match(text, /- valves \(ops\/flash-valves\): branch main, uncommitted changes, fetched\n/u)
  assert.match(text, /- other \(ops\/flash-valves\): branch unknown, clean, fetch failed\n/u)
  assert.match(text, /- solo \(ops\/flash-valves\): branch feature\/x, clean, no remote \(local-only: a commit here is valid done evidence\)\n/u)
  assert.match(text, /- gone \(crew\/t\/s\): not at ~\/code\/gone; clone url https:\/\/example\.com\/g\.git\n/u)
  assert.match(text, /- gone2 \(ops\/flash-valves\): not at ~\/code\/gone2\n/u)
  assert.match(text, /-----\nRule one\.\n-----\n$/u)
  assert.doesNotMatch(text, /Cut at/u)
})

test("formatBootText marks a cut AGENTS.md with the path to the rest, and skips what it does not have", () => {
  const cut = formatBootText(sampleResult({ agents_md: { path: "/work/desk/AGENTS.md", text: "start", truncated: true } }))
  assert.match(cut, /\[Cut at 6 KB: read the rest at \/work\/desk\/AGENTS\.md\]\n$/u)
  const bare = formatBootText({ status: "ready" })
  assert.equal(bare, "Desk boot: ready\n\nInstructions, in order:\n\nActive tasks: unavailable (see degraded)\n")
  const empty = formatBootText({ status: "ready", active_tasks: { task_count: 0, tracks: [] }, root: { path: "/d" }, host: {} })
  assert.match(empty, /Desk: \/d\n/u)
  assert.match(empty, /Host: unknown \/ unknown \/ unknown\n/u)
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
  assert.match(text, /^Desk boot: ready\n/u)
  assert.match(text, /Instructions, in order:\n1\. Use the absolute path /u)
  assert.match(text, /Be brief\./u)
  assert.throws(() => JSON.parse(text))
  const json = JSON.parse(await run(["--json"]))
  assert.equal(json.status, "ready")
  assert.equal(json.agents_md.text, "Be brief.\n")
  const failing = []
  await runBootCli({ env: {}, io: { stdout: { write: (text) => failing.push(text) } }, bootFn: async () => { throw new Error("kaput") } })
  assert.match(failing[0], /^Desk boot: degraded\n- degraded: boot: kaput\n/u)
})

test("the shipped script prints text by default and JSON with --json", async () => {
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-boot.js", import.meta.url))
  const home = await mkTempRoot("desk-boot-text-home-")
  const env = { ...process.env, HOME: home, DESK: "", CLAUDE_PROJECT_DIR: "", DESK_ACTIVATION_CONFIG: "", CODEX_HOME: "", CLAUDE_PLUGIN_DATA: "" }
  const text = execFileSync(process.execPath, [script], { encoding: "utf8", cwd: home, env })
  assert.match(text, /^Desk boot: setup_required\n/u)
  assert.match(text, /1\. No desk is bound on this host/u)
  assert.equal(JSON.parse(execFileSync(process.execPath, [script, "--json"], { encoding: "utf8", cwd: home, env })).status, "setup_required")
})
