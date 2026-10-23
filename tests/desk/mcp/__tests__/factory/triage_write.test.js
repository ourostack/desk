// Real Git: a temporary bare remote and isolated clones, real hooks, real pushes. Nothing here mocks a commit or an
// acknowledgement; fault seams are used only to make a single Git call fail or to pause at a named step.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { promises as fs, readFileSync, realpathSync } from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { mkTempRoot } from "../_temp_roots.js"
import { openImprovement } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { installCardGuard } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"
import { acquireSyncLock } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { readTriageBasis } from "../../../../../plugins/desk/mcp/src/factory/triage-basis.js"
import {
  readAcknowledgedAnnotations, refreshTriage, resolveAcknowledgedTriage, toSafeTriageReview, triagePaths, validateTriageAnnotation, validateTriageIdentities,
} from "../../../../../plugins/desk/mcp/src/factory/triage-state.js"
import { publishOwnedTriage, writeProtectedTriageFile } from "../../../../../plugins/desk/mcp/src/factory/triage-write.js"

const fixture = JSON.parse(readFileSync(new URL("./fixtures/v12-triage-local.json", import.meta.url)))
const KEY = fixture.key
const STORE = fixture.store
const T0 = Date.parse("2026-10-11T12:00:00.000Z")
const HOUR = 3600 * 1000
const posix = process.platform !== "win32"
const RESOURCE_ALARM = "triage_resource_unrecoverable"
const hex = (n) => randomBytes(n).toString("hex")
const slash = (p) => p.split(path.sep).join("/")
const resolveIssue = async (pointer) => ({ revision: 3, public: { kind: "issue", ref: `https://github.com/example-org/example-repo/issues/${pointer.split("#")[1]}`, revision: 3 } })
const HUMAN = fixture.safe_review
const AGENT = { ...HUMAN, route: "agent_ready", gate: null, authority_code: "existing_scope", summary_codes: ["source:andon", "route:agent_ready"] }

const restrictiveProfile = {
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit",
  GIT_CONFIG_KEY_1: "credential.interactive", GIT_CONFIG_VALUE_1: "never",
  GIT_CONFIG_KEY_2: "core.fsmonitor", GIT_CONFIG_VALUE_2: "false",
  GIT_OPTIONAL_LOCKS: "0",
}

function git(cwd, args, { allowFail = false, env = process.env } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env })
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

async function world({ agents = true, attributes = null } = {}) {
  const base = await mkTempRoot("triage-write-")
  const origin = path.join(base, "origin.git")
  git(base, ["init", "-q", "--bare", origin])
  const seed = path.join(base, "seed")
  await fs.mkdir(seed)
  git(seed, ["init", "-q"])
  await fs.mkdir(path.join(seed, "_archive"))
  await fs.writeFile(path.join(seed, "_archive", ".keep"), "")
  if (agents) await fs.writeFile(path.join(seed, "AGENTS.md"), "Agents may fix factory defects in existing scope.\n")
  if (attributes !== null) await fs.writeFile(path.join(seed, ".gitattributes"), attributes)
  await fs.writeFile(path.join(seed, "README.md"), "desk\n")
  for (const key of [KEY, fixture.related_key]) {
    const opened = await openImprovement({ deskRoot: seed, personPrefix: "", key, source: "andon", evidence: [`issue:${key.slice(6)}`], plugin: "desk", signal: null, now: T0 })
    assert.equal(opened.result, "opened")
  }
  commitAll(seed, "seed")
  git(seed, ["remote", "add", "origin", origin])
  git(seed, ["push", "-q", "-u", "origin", "main"])
  const clones = {}
  const clone = (name, config = []) => {
    const deskRoot = path.join(base, name)
    git(base, ["clone", "-q", ...config, origin, deskRoot])
    configure(deskRoot)
    clones[name] = { name, deskRoot, env: { ...process.env, XDG_STATE_HOME: path.join(base, `${name}-state`) } }
    return clones[name]
  }
  return { base, origin, clone }
}

function configure(root) {
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
}

function commitAll(root, message) {
  configure(root)
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", message])
}

async function basisFor(desk, { now = T0, key = KEY } = {}) {
  return (await readTriageBasis({ deskRoot: desk.deskRoot, personPrefix: "", key, now, evidence: { resolve: resolveIssue } })).basis
}

async function publish(desk, overrides = {}) {
  return publishOwnedTriage({
    env: desk.env, deskRoot: desk.deskRoot, personPrefix: "", key: KEY, store: STORE,
    expectedBasis: overrides.expectedBasis ?? (await basisFor(desk)), review: { ...HUMAN, protected_result: hex(16) }, operation: "review", now: T0,
    evidence: { resolve: resolveIssue },
    ...overrides,
  })
}

const paths = triagePaths("/desk", "", KEY)
const remoteText = (origin, file) => spawnSync("git", ["-C", origin, "show", `main:${file}`], { encoding: "utf8" })
function remoteJson(origin, file) {
  const shown = remoteText(origin, file)
  return shown.status === 0 ? JSON.parse(shown.stdout) : null
}
// Every ID the remote's registry has ever held, across its whole history.
function idsEverPublished(origin) {
  const ids = new Set()
  for (const commit of git(origin, ["log", "--format=%H", "main", "--", paths.registry]).split("\n").filter(Boolean)) {
    for (const entry of JSON.parse(git(origin, ["show", `${commit}:${paths.registry}`])).entries) ids.add(entry.id)
  }
  return ids
}

function barrier(count) {
  let seen = 0
  let open
  const gate = new Promise((resolve) => { open = resolve })
  return async () => {
    seen += 1
    if (seen === count) open()
    await gate
  }
}

// Pushes a change to the remote through a separate clone, as another host would.
async function remoteChange(world_, name, change, message = "remote change") {
  const other = path.join(world_.base, `${name}-${hex(4)}`)
  git(world_.base, ["clone", "-q", world_.origin, other])
  await change(other)
  commitAll(other, message)
  git(other, ["push", "-q", "origin", "main"])
}

// Replaces one Git subcommand with a failing call (a real Git process that exits non-zero), leaving everything else real.
function failing(match, replacement = ["config", "--no-such-option"]) {
  return (command, args, options) => (match(args.slice(2)) ? spawn(command, [...args.slice(0, 2), ...replacement], options) : spawn(command, args, options))
}

function liveState(root) {
  return { head: git(root, ["rev-parse", "HEAD"]), index: git(root, ["diff", "--cached", "--binary"]), status: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) }
}

async function writeHook(desk, body) {
  const hooks = path.join(desk.deskRoot, ".git", "hooks")
  await fs.mkdir(hooks, { recursive: true })
  const file = path.join(hooks, "pre-commit")
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

test("simultaneous_assignment_requires_remote_ack", async () => {
  const w = await world()
  const a = w.clone("a")
  const b = w.clone("b")
  assert.deepEqual(readAcknowledgedAnnotations({ deskRoot: a.deskRoot, personPrefix: "" }), { source: "remote", annotations: [], damaged: 0 })
  const gate = barrier(2)
  const onStep = (name) => (name === "remote_read" ? gate() : undefined)
  const [ra, rb] = await Promise.all([publish(a, { git: { onStep } }), publish(b, { git: { onStep } })])
  const states = [ra.state, rb.state].sort()
  assert.deepEqual(states, ["acknowledged", "adopted"], JSON.stringify([ra, rb]))
  assert.equal(ra.id, rb.id, "the loser adopts the acknowledged ID")
  assert.equal(ra.revision, 1)
  assert.equal(rb.revision, 1, "the same review is adopted with no redundant revision")
  assert.deepEqual(idsEverPublished(w.origin), new Set([ra.id]), "the losing ID never reached the remote")
  const registry = remoteJson(w.origin, paths.registry)
  assert.deepEqual(registry.entries, [{ key: KEY, store: STORE.toLowerCase(), id: ra.id, revision: 1, public_basis: null }])
  const winner = ra.state === "acknowledged" ? ra : rb
  assert.equal(winner.ack.remote, "origin")
  assert.equal(winner.ack.ref, "refs/heads/main")
  assert.equal(winner.ack.commit, git(w.origin, ["rev-parse", "main"]))
  assert.equal(winner.ack.registry_blob, git(w.origin, ["rev-parse", `main:${paths.registry}`]))
  assert.equal(winner.ack.annotation_blob, git(w.origin, ["rev-parse", `main:${paths.annotation}`]))
  for (const result of [ra, rb]) assert.ok(result.resources.filter((r) => r.kind === "worktree").every((r) => r.disposition === "removed"), JSON.stringify(result.resources))
  // The loser keeps its equivalent basis under the adopted review's token, so its own mechanical refresh can recheck the review.
  const loser = ra.state === "adopted" ? a : b
  const loserRefresh = await refreshTriage({ env: loser.env, deskRoot: loser.deskRoot, personPrefix: "", now: T0, evidence: { resolve: resolveIssue } })
  assert.deepEqual(loserRefresh.changes, [], JSON.stringify(loserRefresh.changes))
  assert.equal(loserRefresh.coverage.reviewed, 1)

  // Concurrent new revisions on the same ID converge to distinct revisions, never an equal-revision conflict.
  const gate2 = barrier(2)
  const onStep2 = (name) => (name === "remote_read" ? gate2() : undefined)
  const [r2a, r2b] = await Promise.all([
    publish(a, { review: { ...AGENT, protected_result: hex(16) }, git: { onStep: onStep2 } }),
    publish(b, { review: { ...HUMAN, gate: "spend", summary_codes: ["source:andon", "route:human_decision", "gate:spend"], protected_result: hex(16) }, git: { onStep: onStep2 } }),
  ])
  assert.deepEqual([r2a.state, r2b.state], ["acknowledged", "acknowledged"], JSON.stringify([r2a, r2b]))
  assert.deepEqual([r2a.revision, r2b.revision].sort(), [2, 3])
  assert.equal(r2a.id, ra.id)
  assert.equal(r2b.id, ra.id)
  assert.equal(remoteJson(w.origin, paths.annotation).revision, 3)

  // A second store gets its own random ID for the same card; the first store's high-water mark is kept.
  const other = await publish(a, { store: "example-org/second-store", review: { ...AGENT, protected_result: hex(16) } })
  assert.equal(other.state, "acknowledged")
  assert.notEqual(other.id, ra.id)
  assert.equal(other.revision, 4)
  assert.deepEqual(remoteJson(w.origin, paths.registry).entries.map((entry) => [entry.store, entry.id, entry.revision]), [
    ["example-org/example-store", ra.id, 3], ["example-org/second-store", other.id, 4],
  ])
  assert.equal(validateTriageIdentities(remoteText(w.origin, paths.registry).stdout).ok, true)

  // The resolver reads only the acknowledged registry.
  git(a.deskRoot, ["fetch", "-q", "origin"])
  const protectedResult = remoteJson(w.origin, paths.annotation).review.protected_result
  assert.deepEqual(resolveAcknowledgedTriage({ deskRoot: a.deskRoot, personPrefix: "", store: "example-org/second-store", id: other.id, revision: 4 }), { state: "resolved", key: KEY, protected_result: protectedResult })
  assert.deepEqual(resolveAcknowledgedTriage({ deskRoot: a.deskRoot, personPrefix: "", store: STORE, id: ra.id, revision: 1 }), { state: "stale", key: KEY })
  assert.deepEqual(resolveAcknowledgedTriage({ deskRoot: a.deskRoot, personPrefix: "", store: STORE, id: other.id, revision: 4 }), { state: "not_resolved" })
  assert.deepEqual(resolveAcknowledgedTriage({ deskRoot: a.deskRoot, personPrefix: "", store: STORE, id: hex(16), revision: 1 }), { state: "not_resolved" })
  assert.equal(readAcknowledgedAnnotations({ deskRoot: a.deskRoot, personPrefix: "" }).source, "remote")
})

test("loser_with_a_different_review_writes_the_next_revision_under_the_winning_id", async () => {
  const w = await world()
  const a = w.clone("a")
  const b = w.clone("b")
  const gate = barrier(2)
  const onStep = (name) => (name === "remote_read" ? gate() : undefined)
  const [ra, rb] = await Promise.all([publish(a, { git: { onStep } }), publish(b, { review: { ...AGENT, protected_result: hex(16) }, git: { onStep } })])
  assert.deepEqual([ra.state, rb.state], ["acknowledged", "acknowledged"])
  assert.equal(ra.id, rb.id)
  assert.deepEqual([ra.revision, rb.revision].sort(), [1, 2])
  assert.equal(idsEverPublished(w.origin).size, 1)
})

test("changed_basis_during_push_holds_and_unrelated_advance_retries_once", async () => {
  const w = await world()
  const a = w.clone("a")
  let changed = false
  const stale = await publish(a, {
    git: {
      onStep: async (name) => {
        if (name !== "before_commit" || changed) return
        changed = true
        await remoteChange(w, "card", async (root) => {
          const file = path.join(root, triagePaths(root, "", KEY).card)
          await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(`["issue:example-org/example-repo#101"]`, `["issue:example-org/example-repo#101","issue:example-org/example-repo#5"]`))
        })
      },
    },
  })
  assert.equal(stale.state, "stale_basis")
  assert.equal(stale.id, undefined)
  assert.equal(remoteJson(w.origin, paths.registry), null, "nothing was emitted")

  const b = w.clone("b")
  let advanced = false
  const retried = await publish(b, {
    git: {
      onStep: async (name) => {
        if (name !== "before_commit" || advanced) return
        advanced = true
        await remoteChange(w, "unrelated", (root) => fs.writeFile(path.join(root, "unrelated.md"), "x\n"))
      },
    },
  })
  assert.equal(retried.state, "acknowledged", JSON.stringify(retried))

  const twice = await publish(b, {
    review: { ...AGENT, protected_result: hex(16) },
    git: { onStep: async (name) => { if (name === "before_commit") await remoteChange(w, "again", (root) => fs.writeFile(path.join(root, `u-${hex(3)}.md`), "x\n")) } },
  })
  assert.equal(twice.state, "unacknowledged", "a second rejection is not retried again")
  assert.equal(remoteJson(w.origin, paths.annotation).revision, 1)

  // Readback that no longer matches the basis (the card changed right after the push) is not an acknowledgement.
  git(b.deskRoot, ["pull", "-q"])
  const readback = await publish(b, {
    review: { ...AGENT, protected_result: hex(16) },
    git: {
      onStep: async (name) => {
        if (name === "pushed") {
          await remoteChange(w, "after", async (root) => {
            const file = path.join(root, triagePaths(root, "", KEY).card)
            await fs.writeFile(file, `${await fs.readFile(file, "utf8")}\n`)
          })
        }
      },
    },
  })
  assert.equal(readback.state, "unacknowledged")

  // Evidence revisions are resolved live at publication, not taken from the prepared basis.
  git(b.deskRoot, ["pull", "-q"])
  const head = git(w.origin, ["rev-parse", "main"])
  const edited = async (pointer) => ({ ...(await resolveIssue(pointer)), revision: 4 })
  assert.equal((await publish(b, { evidence: { resolve: edited } })).state, "stale_basis", "the public issue changed since the review")
  assert.equal((await publish(b, { evidence: {} })).state, "stale_basis", "no live resolver can answer for the issue")
  assert.equal((await publish(b, { evidence: { resolve: () => { throw new Error("offline") } } })).state, "stale_basis", "a failing resolver proves nothing")
  assert.equal(git(w.origin, ["rev-parse", "main"]), head, "nothing was pushed")
  // The resolver is handed the card as published, as readTriageBasis hands it.
  const seen = []
  const recording = async (pointer, card) => {
    seen.push(card?.key)
    return resolveIssue(pointer)
  }
  assert.equal((await publish(b, { evidence: { resolve: recording }, git: { onStep: (name) => { if (name === "remote_read") throw new Error("stop") } } })).state, "write_failed")
  assert.ok(seen.length > 0 && seen.every((key) => key === KEY), JSON.stringify(seen))
  // A checkout behind the remote card cannot hand over the expected card: the basis read elsewhere does not hold here.
  const c = w.clone(`c-${hex(3)}`)
  await remoteChange(w, "behind", async (root) => {
    const file = path.join(root, triagePaths(root, "", KEY).card)
    await fs.writeFile(file, `${await fs.readFile(file, "utf8")}\n`)
  })
  git(b.deskRoot, ["pull", "-q"])
  assert.equal((await publish(c, { expectedBasis: await basisFor(b) })).state, "stale_basis")
  let pushed = false
  const editedAfterPush = async (pointer) => (pushed ? edited(pointer) : resolveIssue(pointer))
  const late = await publish(b, {
    review: { ...HUMAN, gate: "intent", summary_codes: ["source:andon", "route:human_decision", "gate:intent"], protected_result: hex(16) },
    evidence: { resolve: editedAfterPush },
    git: { onStep: (name) => { if (name === "pushed") pushed = true } },
  })
  assert.equal(late.state, "unacknowledged", "evidence that changed by readback is not acknowledged")
})

test("dirty_siblings_are_preserved_and_relevant_local_state_holds", async () => {
  const w = await world()
  const a = w.clone("a")
  await fs.writeFile(path.join(a.deskRoot, "README.md"), "edited by another session\n")
  await fs.mkdir(path.join(a.deskRoot, "notes"))
  await fs.writeFile(path.join(a.deskRoot, "notes", "staged.md"), "staged\n")
  git(a.deskRoot, ["add", "notes/staged.md"])
  await fs.writeFile(path.join(a.deskRoot, "notes", "untracked.md"), "untracked\n")
  const before = liveState(a.deskRoot)
  const result = await publish(a)
  assert.equal(result.state, "acknowledged")
  assert.deepEqual(liveState(a.deskRoot), before, "live HEAD, index, tree and siblings are untouched")
  assert.equal(await fs.readFile(path.join(a.deskRoot, "README.md"), "utf8"), "edited by another session\n")
  await assert.rejects(fs.lstat(path.join(a.deskRoot, paths.dir)), "no annotation copy is left in the live checkout")

  // A relevant dirty, staged or untracked path holds: the local state could disagree with what would be published.
  const card = path.join(a.deskRoot, paths.card)
  const cardBytes = await fs.readFile(card)
  await fs.appendFile(card, "\n")
  assert.equal((await publish(a, { expectedBasis: await basisFor({ ...a }) })).state, "unsynchronized")
  await fs.writeFile(card, cardBytes)
  await fs.mkdir(path.join(a.deskRoot, paths.dir), { recursive: true })
  await fs.writeFile(path.join(a.deskRoot, paths.annotation), "{}\n")
  assert.equal((await publish(a)).state, "unsynchronized")
  await fs.unlink(path.join(a.deskRoot, paths.annotation))
})

test("local_only_canonical_or_ruling_commit_holds", async () => {
  const w = await world()
  const a = w.clone("a")
  await fs.writeFile(path.join(a.deskRoot, "AGENTS.md"), "Scope narrowed locally.\n")
  git(a.deskRoot, ["commit", "-q", "-am", "local ruling"])
  const head = git(a.deskRoot, ["rev-parse", "HEAD"])
  const result = await publish(a)
  assert.equal(result.state, "unsynchronized")
  assert.equal(result.id, undefined)
  assert.equal(git(a.deskRoot, ["rev-parse", "HEAD"]), head, "the local-only commit is preserved")
  assert.equal(remoteJson(w.origin, paths.registry), null)

  // Behind the remote on a relevant path: the prepared basis no longer equals the remote basis.
  const b = w.clone("b")
  await remoteChange(w, "rules", (root) => fs.writeFile(path.join(root, "AGENTS.md"), "Remote ruling change.\n"))
  assert.equal((await publish(b)).state, "stale_basis")
  // A ruling that appeared only on the remote changes the basis too.
  const c = w.clone("c")
  await remoteChange(w, "operator", async (root) => fs.writeFile(path.join(root, "_meta", "operator-rules.md"), "New rule.\n"))
  assert.equal((await publish(c)).state, "stale_basis")
  // An expired claim at publication time changes effective ownership.
  git(c.deskRoot, ["pull", "-q"])
  const basis = await basisFor(c)
  assert.equal((await publish(c, { expectedBasis: { ...basis, claim: { state: "live", expires_at: new Date(T0 - 1000).toISOString() } } })).state, "stale_basis")
})

test("damaged_or_disagreeing_identity_state_holds", async () => {
  const w = await world()
  const a = w.clone("a")
  const writeTriage = (registry, annotation) => remoteChange(w, "triage", async (root) => {
    await fs.mkdir(path.join(root, paths.dir), { recursive: true })
    if (registry !== undefined) await fs.writeFile(path.join(root, paths.registry), registry)
    if (annotation !== undefined) await fs.writeFile(path.join(root, paths.annotation), annotation)
  })
  const entry = (revision) => `${JSON.stringify({ schema: "desk.factory.triage-identities/1", entries: [{ key: KEY, store: STORE.toLowerCase(), id: hex(16), revision, public_basis: null }] })}\n`
  const annotation = (revision, key = KEY) => `${JSON.stringify({
    schema: "desk.factory.triage-local/1", key, revision,
    basis: { generation: hex(16), canonical_revision: "a".repeat(40), public_evidence_revisions: [], protected_basis: hex(16) },
    review: HUMAN, attempt: { state: "reviewed", at: new Date(T0).toISOString(), reason: "review_accepted" },
  })}\n`
  await writeTriage("{damaged")
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "identity_conflict")
  await writeTriage(entry(1))
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "identity_conflict", "a registry entry without its annotation")
  await writeTriage(entry(3), annotation(2))
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "identity_conflict", "the registry ahead of the annotation")
  await writeTriage(entry(1), annotation(1, fixture.related_key))
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "identity_conflict", "an annotation for another card at this card's path")
  await writeTriage(undefined, "{}\n")
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "identity_conflict", "a damaged annotation")
  await writeTriage(entry(Number.MAX_SAFE_INTEGER), annotation(Number.MAX_SAFE_INTEGER))
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "write_failed", "a high-water mark that cannot advance")
})

test("unsafe_triage_paths_in_the_remote_tree_hold", async () => {
  const w = await world()
  const a = w.clone("a")
  await remoteChange(w, "file", async (root) => fs.writeFile(path.join(root, paths.dir), "a file where the folder belongs\n"))
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "unsafe_path")
  await remoteChange(w, "folder", async (root) => {
    await fs.unlink(path.join(root, paths.dir))
    await fs.mkdir(path.join(root, paths.annotation), { recursive: true })
    await fs.writeFile(path.join(root, paths.annotation, "keep"), "x\n")
  })
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "unsafe_path")
})

test("crash_after_push_is_adopted_by_the_next_pass", async () => {
  const w = await world()
  const a = w.clone("a")
  const review = { ...HUMAN, protected_result: hex(16) }
  const crashed = await publish(a, { review, git: { onStep: (name) => { if (name === "pushed") throw new Error("killed") } } })
  assert.equal(crashed.state, "unacknowledged")
  assert.equal(crashed.id, undefined, "no ID is emitted before readback")
  assert.ok(crashed.resources.some((r) => r.kind === "worktree" && r.disposition === "active"), "the candidate is left for recovery")
  const pushed = remoteJson(w.origin, paths.registry).entries[0]
  const next = await publish(a, { review })
  assert.equal(next.state, "adopted")
  assert.equal(next.id, pushed.id)
  assert.equal(next.revision, 1)
  assert.ok(next.resources.some((r) => r.kind === "worktree" && r.disposition === "removed"), JSON.stringify(next.resources))

  // A crash before anything could be pushed is a write failure, also recovered.
  const early = await publish(a, { review: { ...AGENT, protected_result: hex(16) }, git: { onStep: (name) => { if (name === "remote_read") throw new Error("killed") } } })
  assert.equal(early.state, "write_failed")
})

test("withdrawal_restart_and_reappearance_keep_identity_and_advance_revision", async () => {
  const w = await world()
  const a = w.clone("a")
  const first = await publish(a)
  assert.equal(first.state, "acknowledged")
  // Invalidation keeps the last valid review as stale context: a failed or changed review never becomes empty success.
  const prior = remoteJson(w.origin, paths.annotation).review
  // The invalidation records the refresh's own reason; one an invalidation cannot have, or a reason on another operation, is refused.
  assert.equal((await publish(a, { operation: "invalidate", review: null, reason: "card_removed" })).state, "policy_refused")
  assert.equal((await publish(a, { reason: "claim_changed" })).state, "policy_refused")
  const invalidated = await publish(a, { operation: "invalidate", review: null, reason: "claim_changed" })
  assert.equal(invalidated.state, "acknowledged")
  assert.equal(invalidated.revision, 2)
  const staleAnnotation = remoteJson(w.origin, paths.annotation)
  assert.deepEqual(staleAnnotation.review, prior)
  assert.deepEqual(staleAnnotation.attempt.state, "stale")
  assert.equal(staleAnnotation.attempt.reason, "claim_changed")
  assert.equal((await publish(a, { operation: "invalidate", review: null })).state, "adopted", "already stale on this basis")
  assert.equal((await publish(a, { review: null })).state, "policy_refused", "a refused review is never published")
  assert.equal(remoteJson(w.origin, paths.annotation).revision, 2)

  await remoteChange(w, "remove", (root) => fs.unlink(path.join(root, triagePaths(root, "", KEY).card)))
  git(a.deskRoot, ["pull", "-q"])
  const gone = await basisFor(a)
  assert.equal(gone.canonical_revision, null)
  assert.equal((await publish(a, { expectedBasis: gone })).state, "policy_refused", "a review needs its card")
  const withdrawn = await publish(a, { operation: "withdraw", review: null, expectedBasis: gone })
  assert.equal(withdrawn.state, "acknowledged")
  assert.equal(withdrawn.id, first.id)
  assert.equal(withdrawn.revision, 3)
  assert.equal(remoteJson(w.origin, paths.annotation).review, null)
  assert.deepEqual(remoteJson(w.origin, paths.registry).entries.map((entry) => entry.id), [first.id], "identity is retained after removal")
  assert.equal((await publish(a, { operation: "withdraw", review: null, expectedBasis: gone })).state, "adopted")
  assert.equal((await publish(a, { operation: "invalidate", review: null, expectedBasis: { ...gone, canonical_revision: "a".repeat(40) } })).state, "stale_basis")

  // The card reappears: same ID, a higher revision, and a fresh review is required.
  await openImprovement({ deskRoot: a.deskRoot, personPrefix: "", key: KEY, source: "andon", evidence: [`issue:${KEY.slice(6)}`], plugin: "desk", signal: null, now: T0 + HOUR })
  commitAll(a.deskRoot, "reopen")
  git(a.deskRoot, ["pull", "-q", "--rebase"])
  git(a.deskRoot, ["push", "-q"])
  const refreshed = await refreshTriage({ env: a.env, deskRoot: a.deskRoot, personPrefix: "", now: T0 + HOUR })
  assert.equal(refreshed.changes.length, 0, "a withdrawn annotation is not live and is not rewritten")
  const back = await publish(a, { expectedBasis: await basisFor(a), review: { ...AGENT, protected_result: hex(16) } })
  assert.equal(back.state, "acknowledged")
  assert.equal(back.id, first.id)
  assert.equal(back.revision, 4)

  // Nothing to invalidate or withdraw for a card that never had an annotation.
  const other = await basisFor(a, { key: fixture.related_key })
  assert.equal((await publish(a, { key: fixture.related_key, expectedBasis: other, operation: "invalidate", review: null })).state, "policy_refused")
  // The mechanical refresh sees the acknowledged review as fresh on this host.
  const fresh = await refreshTriage({ env: a.env, deskRoot: a.deskRoot, personPrefix: "", now: T0 + HOUR, evidence: { resolve: resolveIssue } })
  assert.equal(fresh.coverage.reviewed, 1)
})

test("valid_private_result_never_enters_git_review", async () => {
  const w = await world()
  const a = w.clone("a")
  const basis = await basisFor(a)
  const safe = toSafeTriageReview({ result: fixture.private_candidate.result, basis, authorizedEvidence: fixture.private_candidate.authorized_evidence, protectedToken: hex(16), briefKeys: [KEY, fixture.related_key] })
  assert.equal(safe.state, "safe")
  // A candidate is never accepted as a review.
  assert.equal((await publish(a, { review: fixture.private_candidate.result })).state, "policy_refused")
  const result = await publish(a, { review: safe.review, expectedBasis: basis })
  assert.equal(result.state, "acknowledged")
  // Every committed blob, staged and pushed, holds only safe codes and tokens.
  const commit = result.ack.commit
  const diff = git(w.origin, ["show", "--format=", "--patch", commit])
  for (const sentinel of fixture.private_candidate.sentinels) assert.equal(diff.includes(sentinel), false, sentinel)
  assert.equal(diff.includes(basis.fingerprint), false, "the private basis digest stays out of Git")
  assert.equal(diff.includes("private-repo"), false)
  assert.equal(validateTriageAnnotation(remoteText(w.origin, paths.annotation).stdout).ok, true)
  assert.deepEqual(git(w.origin, ["show", "--name-only", "--format=", commit]).split("\n").sort(), [paths.annotation, paths.registry].sort())
})

test("chained_commit_policy_refusal_prevents_ack", async () => {
  const w = await world()
  const a = w.clone("a")
  const log = path.join(w.base, "hook.log")
  await writeHook(a, `echo "$(git rev-parse --show-toplevel)|$DESK_TOOL_COMMIT|$DESK_CARD_GUARD_RUNNING" >> "${slash(log)}"\nif git diff --cached | grep -q human_decision; then echo refused >&2; exit 1; fi\nexit 0`)
  const guard = installCardGuard(a.deskRoot)
  assert.equal(guard.chained, true, JSON.stringify(guard))
  const refused = await publish(a)
  assert.equal(refused.state, "policy_refused")
  assert.equal(remoteJson(w.origin, paths.registry), null, "no push")
  assert.ok(refused.resources.filter((r) => r.kind === "worktree").every((r) => r.disposition === "removed"))
  const accepted = await publish(a, { review: { ...AGENT, protected_result: hex(16) } })
  assert.equal(accepted.state, "acknowledged")
  const lines = (await fs.readFile(log, "utf8")).trim().split("\n")
  assert.equal(lines.length, 2, "the chained policy ran for both candidates")
  for (const line of lines) {
    const [top, tool, running] = line.split("|")
    assert.match(slash(top), /\/triage\/ops\/[0-9a-f]{32}\/wt$/u, "the hook ran in the candidate worktree, not the live checkout")
    assert.equal(tool, "1")
    assert.equal(running, "1", "Desk's own guard ran first and chained the policy")
  }
})

test("policy_reads_candidate_tree_not_live_head", async () => {
  const w = await world()
  const a = w.clone("a")
  await writeHook(a, `if [ -e "$(git rev-parse --show-toplevel)/poison.txt" ]; then exit 1; fi\nexit 0`)
  await fs.writeFile(path.join(a.deskRoot, "poison.txt"), "only in the live checkout\n")
  assert.equal((await publish(a)).state, "acknowledged")
})

test("policy_timeout_holds_without_bypass", async () => {
  const w = await world()
  const a = w.clone("a")
  const pidFile = path.join(w.base, "hook.pid")
  await writeHook(a, `"${slash(process.execPath)}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)" "${slash(pidFile)}"`)
  const result = await publish(a, { git: { timeoutMs: 3000 } })
  assert.equal(result.state, "policy_unknown")
  assert.equal(remoteJson(w.origin, paths.registry), null, "no push, no acknowledgement")
  const pid = Number(await fs.readFile(pidFile, "utf8"))
  let alive = true
  for (let tries = 0; tries < 50 && alive; tries += 1) {
    try {
      process.kill(pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch {
      alive = false
    }
  }
  assert.equal(alive, false, "the hung hook's process was ended with its group (its process tree on Windows)")
  assert.ok(result.resources.filter((r) => r.kind === "worktree").every((r) => r.disposition === "removed"), "only own staged files: removed")
})

test("changed_disabled_or_unreadable_policy_holds", async () => {
  const w = await world()
  const a = w.clone("a")
  const hook = await writeHook(a, `echo "# touched" >> "$0"\nexit 0`)
  assert.equal((await publish(a)).state, "policy_unknown", "the hook changed itself during the commit")
  await writeHook(a, "echo extra > extra.txt\ngit add extra.txt\nexit 0")
  assert.equal((await publish(a)).state, "policy_unknown", "an extra committed path")
  await writeHook(a, "echo left > leftover.txt\nexit 0")
  const left = await publish(a)
  assert.equal(left.state, "policy_unknown", "a file the hook left behind")
  const retained = left.resources.find((r) => r.kind === "worktree")
  assert.equal(retained.disposition, "retained", "the call that made it keeps what the hook left")
  // A file a hook left is never deleted: the worktree is kept, and every later call is busy with the stable alarm code.
  await fs.writeFile(hook, "#!/bin/sh\nexit 0\n")
  const blocked = await publish(a)
  assert.equal(blocked.state, "busy", "an unrecovered resource blocks new ones")
  assert.equal(blocked.alarm, RESOURCE_ALARM)
  assert.equal(blocked.resources[0].path, retained.path)
  assert.equal(blocked.resources[0].disposition, "retained")
  assert.equal(await fs.readFile(path.join(retained.path, "leftover.txt"), "utf8"), "left\n", "the hook's file survives recovery")
  assert.equal((await publish(a)).alarm, RESOURCE_ALARM, "still raised on the next call")
  // Once the leftover is dealt with, the next call recovers the worktree by itself.
  await fs.unlink(path.join(retained.path, "leftover.txt"))
  const recovered = await publish(a)
  assert.equal(recovered.state, "acknowledged", JSON.stringify(recovered))
  assert.equal(recovered.alarm, undefined)
  assert.equal(recovered.resources[0].disposition, "removed")

  git(a.deskRoot, ["config", "core.hooksPath", "/dev/null"])
  assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) } })).state, "policy_refused", "hooks turned off")
  git(a.deskRoot, ["config", "core.hooksPath", path.join(a.deskRoot, "README.md")])
  assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) } })).state, "policy_unknown", "a hooks folder that cannot be read")
  const hooks = path.join(w.base, "hooks")
  await fs.mkdir(path.join(hooks, "sub"), { recursive: true })
  // Links need privileges on Windows; a folder is enough there.
  if (posix) await fs.symlink("/nonexistent", path.join(hooks, "linked"))
  git(a.deskRoot, ["config", "core.hooksPath", hooks])
  assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) } })).state, "acknowledged", "links and folders in the hooks folder are fingerprinted, not run")
  if (posix && process.getuid?.() !== 0) {
    await fs.writeFile(path.join(hooks, "secret"), "x", { mode: 0o000 })
    assert.equal((await publish(a, { review: { ...HUMAN, gate: "voice", summary_codes: ["source:andon", "route:human_decision", "gate:voice"], protected_result: hex(16) } })).state, "policy_unknown", "a hook file that cannot be read")
    await fs.chmod(path.join(hooks, "secret"), 0o600)
  }
  git(a.deskRoot, ["config", "core.hooksPath", path.join(w.base, "no-hooks-here")])
  assert.equal((await publish(a, { review: { ...HUMAN, gate: "account", summary_codes: ["source:andon", "route:human_decision", "gate:account"], protected_result: hex(16) } })).state, "acknowledged", "an absent hooks folder is an empty policy")
})

test("unsafe_inputs_and_environment_are_refused_before_git", async () => {
  const w = await world()
  const a = w.clone("a")
  const basis = await basisFor(a)
  const cases = [
    [{ operation: "approve" }, "policy_refused"],
    [{ store: "not a store" }, "unsafe_path"],
    [{ deskRoot: "relative/desk" }, "unsafe_path"],
    [{ key: "not a key" }, "unsafe_path"],
    [{ personPrefix: "../escape" }, "unsafe_path"],
    [{ review: { ...HUMAN, decision: "private" } }, "policy_refused"],
    [{ operation: "invalidate", review: HUMAN }, "policy_refused"],
    [{ now: "not a time" }, "policy_refused"],
    [{ expectedBasis: { ...basis, key: fixture.related_key } }, "policy_refused"],
    [{ expectedBasis: { ...basis, rulings: [{ id: "../x", revision: "a".repeat(40) }] } }, "policy_refused"],
    [{ expectedBasis: { ...basis, claim: { state: "maybe" } } }, "policy_refused"],
    [{ expectedBasis: { ...basis, canonical_revision: "HEAD" } }, "policy_refused"],
    [{ expectedBasis: null }, "policy_refused"],
    [{ operation: "withdraw", review: null }, "policy_refused"],
    [{ env: { ...a.env, DESK_CARD_GUARD_RUNNING: "1" } }, "policy_refused"],
    [{ env: { ...a.env, GIT_DIR: path.join(a.deskRoot, ".git") } }, "policy_refused"],
    [{ env: { ...a.env, GIT_CONFIG_PARAMETERS: "'core.hookspath'='/dev/null'" } }, "policy_refused"],
  ]
  for (const [overrides, state] of cases) assert.equal((await publish(a, { expectedBasis: basis, ...overrides })).state, state, JSON.stringify(overrides))
  assert.equal((await publish(a, { expectedBasis: basis, review: undefined, operation: "invalidate" })).state, "policy_refused", "nothing to invalidate yet")
  assert.equal((await publish(a, { expectedBasis: { ...(await basisFor(a)), public_evidence_revisions: [{ kind: "issue", ref: "not a pointer", revision: 1 }] } })).state, "policy_refused", "an unsafe public pointer never reaches the annotation")
  assert.equal(remoteJson(w.origin, paths.registry), null)
})

test("restrictive_command_profile_keeps_command_scope_and_acknowledges_real_git", async () => {
  const w = await world()
  const a = w.clone("profile")
  const seen = []
  const result = await publish(a, {
    env: { ...a.env, ...restrictiveProfile },
    git: { spawn: (command, args, options) => {
      seen.push({ command, args, env: options.env })
      return spawn(command, args, options)
    } },
  })
  assert.equal(result.state, "acknowledged", JSON.stringify(result))
  assert.ok(result.ack)
  assert.ok(result.resources.filter((resource) => resource.kind === "worktree").every((resource) => resource.disposition === "removed"))
  assert.equal(remoteJson(w.origin, paths.registry).entries[0].id, result.id)
  for (const call of seen.filter((call) => !call.args.includes("--version"))) {
    for (const [name, value] of Object.entries(restrictiveProfile)) assert.equal(call.env[name], value, `${call.args}: ${name}`)
  }
})

test("restrictive_profile_accepts_all_six_bijections_and_optional_locks_zero_only", async () => {
  const w = await world()
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
  for (const [index, order] of permutations.entries()) {
    const a = w.clone(`permutation-${index}`)
    const profile = { GIT_CONFIG_COUNT: "3" }
    for (const [slot, source] of order.entries()) {
      profile[`GIT_CONFIG_KEY_${slot}`] = restrictiveProfile[`GIT_CONFIG_KEY_${source}`]
      profile[`GIT_CONFIG_VALUE_${slot}`] = restrictiveProfile[`GIT_CONFIG_VALUE_${source}`]
    }
    if (index % 2 === 0) profile.GIT_OPTIONAL_LOCKS = "0"
    const calls = []
    const result = await publish(a, {
      env: { ...a.env, ...profile },
      review: { ...HUMAN, protected_result: hex(16), gate: index % 2 ? "voice" : "account", summary_codes: ["source:andon", "route:human_decision", `gate:${index % 2 ? "voice" : "account"}`] },
      git: { spawn: (command, args, options) => {
        calls.push(args)
        if (!args.includes("--version")) {
          for (const [name, value] of Object.entries(profile)) assert.equal(options.env[name], value, `${args}: ${name}`)
          if (!Object.hasOwn(profile, "GIT_OPTIONAL_LOCKS")) assert.equal(Object.hasOwn(options.env, "GIT_OPTIONAL_LOCKS"), false)
        }
        return spawn(command, args, options)
      } },
    })
    assert.equal(result.state, "acknowledged", JSON.stringify({ index, result }))
    assert.ok(result.resources.filter((resource) => resource.kind === "worktree").every((resource) => resource.disposition === "removed"))
    assert.equal(calls.filter((args) => args.includes("--version")).length, 1)
    for (const subcommand of ["worktree", "add", "commit", "push", "fetch", "branch"]) assert.ok(calls.some((args) => args[2] === subcommand), subcommand)
  }
  for (const extra of [{}, { GIT_OPTIONAL_LOCKS: "0" }]) {
    const a = w.clone(`scalar-${hex(2)}`)
    assert.equal((await publish(a, { env: { ...a.env, ...extra }, review: { ...HUMAN, gate: "voice", summary_codes: ["source:andon", "route:human_decision", "gate:voice"], protected_result: hex(16) }, git: { spawn: (command, args, options) => {
      assert.equal(args.includes("--version"), false, "legacy/scalar callers do not acquire a semantic prerequisite")
      return spawn(command, args, options)
    } } })).state, "adopted")
  }
})

test("restrictive_profile_malformed_inputs_refuse_before_any_git_or_writer_effect", async () => {
  const w = await world()
  const a = w.clone("malformed")
  const expectedBasis = await basisFor(a)
  const before = liveState(a.deskRoot)
  const remoteBefore = git(w.origin, ["rev-parse", "main"])
  const invalid = []
  const change = (name, value) => invalid.push({ ...restrictiveProfile, [name]: value })
  for (const name of Object.keys(restrictiveProfile).filter((name) => name !== "GIT_OPTIONAL_LOCKS")) {
    const missing = { ...restrictiveProfile }
    delete missing[name]
    invalid.push(missing)
    for (const value of [undefined, null, 3, false, "", " ", "\n"]) change(name, value)
    change(name.toLowerCase(), restrictiveProfile[name])
  }
  invalid.push({ GIT_CONFIG_COUNT: "3" }, { GIT_CONFIG_KEY_0: "safe.bareRepository" }, { GIT_CONFIG_VALUE_0: "explicit" })
  for (const count of ["0", "1", "2", "4", "03", "+3", "-3", "3.0", " 3", "3 ", "3\n", "3\0"]) change("GIT_CONFIG_COUNT", count)
  for (const value of ["1", "false", "", "00", " 0", "0\n", 0, false, null, undefined]) {
    change("GIT_OPTIONAL_LOCKS", value)
    invalid.push({ GIT_OPTIONAL_LOCKS: value })
  }
  for (const name of [
    "GIT_CONFIG_KEY_3", "GIT_CONFIG_VALUE_3", "GIT_CONFIG_KEY_00", "GIT_CONFIG_VALUE_01",
    "GIT_CONFIG_KEY_-1", "GIT_CONFIG_VALUE_x", "GIT_CONFIG_KEY_1.0", "GIT_CONFIG_KEY_+1",
    "GIT_CONFIG_KEY", "GIT_CONFIG_VALUE", "GIT_CONFIG_COUNT_EXTRA", "Git_CONFIG_COUNT", "GIT_OPTIONAL_lockS",
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_SYSTEM", "GIT_FUTURE_OVERRIDE",
  ]) change(name, "0")
  for (const [name, value] of [
    ["GIT_CONFIG_KEY_0", "safe.barerepository"], ["GIT_CONFIG_KEY_0", "safe.bareRepository "],
    ["GIT_CONFIG_KEY_0", "core.hooksPath"], ["GIT_CONFIG_VALUE_0", "all"], ["GIT_CONFIG_VALUE_1", "Never"],
    ["GIT_CONFIG_VALUE_2", "0"], ["GIT_CONFIG_VALUE_2", "false "], ["GIT_CONFIG_KEY_1", "safe.bareRepository"],
    ["DESK_CARD_GUARD_RUNNING", "1"],
  ]) change(name, value)
  invalid.push({ ...restrictiveProfile, GIT_CONFIG_KEY_1: "safe.bareRepository", GIT_CONFIG_VALUE_1: "explicit" })
  let spawned = 0
  for (const profile of invalid) {
    const result = await publish(a, { expectedBasis, env: { ...a.env, ...profile }, git: { spawn: () => { spawned += 1; throw new Error("must not run") } } })
    assert.deepEqual(result, { state: "policy_refused", resources: [] }, JSON.stringify(profile))
  }
  assert.equal(spawned, 0)
  assert.deepEqual(liveState(a.deskRoot), before)
  assert.equal(git(w.origin, ["rev-parse", "main"]), remoteBefore)
  await assert.rejects(fs.stat(a.env.XDG_STATE_HOME), { code: "ENOENT" })
})

test("restrictive_profile_version_diagnostic_is_bounded_fail_closed_and_not_cached", async () => {
  const w = await world()
  const a = w.clone("versions")
  const expectedBasis = await basisFor(a)
  const env = { ...a.env, ...restrictiveProfile }
  const rejected = [
    "git version 2.35.99\n", "git version 2.35.1\n", "git version 1.99.99\n", "git version 3.0.0\n",
    "git version 2.36.0-rc1\n", "git version 2.36.0 arbitrary vendor\n", "git version 02.36.0\n",
    "git version 2.036.0\n", "git version 2.36.00\n", "git version 2.36\n", "git version 2.36.0.1\n",
    "git version 2.36.0\njunk", "git version 2.36.0\n\n", " git version 2.36.0\n",
    "git version 2.36.0 (Apple Git-157) junk\n", "git version 2.36.0.windows.0\n",
    "git version 2.9007199254740992.0\n", "git version 2.36.9007199254740992\n", "", "not git\n",
    "git version 2.36.0\n".repeat(200),
  ]
  const queries = []
  const attempt = (script, { throws = false, missing = false, timeoutMs = 1000 } = {}) => publish(a, {
    expectedBasis, env,
    git: { timeoutMs, spawn: (command, args, options) => {
      queries.push({ command, args, options })
      assert.deepEqual(args, ["--version"], "a rejected diagnostic must be the only Git invocation")
      assert.ok(path.isAbsolute(command))
      assert.equal(options.cwd, path.parse(a.deskRoot).root)
      assert.equal(options.shell, undefined)
      assert.equal(options.env.GIT_TERMINAL_PROMPT, "0")
      const wanted = { ...env, GIT_TERMINAL_PROMPT: "0" }
      for (const name of Object.keys(restrictiveProfile).filter((name) => name !== "GIT_OPTIONAL_LOCKS")) delete wanted[name]
      assert.deepEqual(options.env, wanted)
      if (throws) throw new Error("spawn failure")
      return spawn(missing ? `${command}-not-present` : process.execPath, ["-e", script], options)
    } },
  })
  for (const banner of rejected) assert.deepEqual(await attempt(`process.stdout.write(${JSON.stringify(banner)})`), { state: "policy_refused", resources: [] }, banner)
  for (const script of [
    "process.exit(1)", "process.kill(process.pid, 'SIGTERM')",
    "process.stderr.write('x'.repeat(4096))", "process.stdout.write('git version 2.36.0\\n'); process.stderr.write('warning')",
    "process.stdout.write('git version 2.36.0\\n'); setTimeout(() => {}, 60000)",
  ]) assert.equal((await attempt(script)).state, "policy_refused", script)
  assert.equal((await attempt("", { throws: true })).state, "policy_refused")
  assert.equal((await attempt("", { missing: true })).state, "policy_refused")
  assert.ok(queries.length > rejected.length)
  await assert.rejects(fs.stat(a.env.XDG_STATE_HOME), { code: "ENOENT" })

  for (const banner of ["git version 2.36.0\n", "git version 2.36.1", "git version 2.100.0\r\n", "git version 2.54.0 (Apple Git-157)\n", "git version 2.40.1 (Apple Git-157.1)\n", "git version 2.47.0.windows.1\n"]) {
    let count = 0
    const result = await publish(a, { expectedBasis, env, git: { spawn: (command, args, options) => {
      if (args.includes("--version")) {
        count += 1
        return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(banner)})`], options)
      }
      return spawn(command, args, options)
    } } })
    assert.ok(["acknowledged", "adopted"].includes(result.state), JSON.stringify({ banner, result }))
    assert.equal(count, 1, "every operation checks its own selected consumer")
  }
  assert.equal((await attempt("process.stdout.write('git version 2.35.99\\n')")).state, "policy_refused", "a prior accepted banner cannot license this operation")
})

test("restrictive_profile_resolves_once_and_never_checks_A_then_uses_PATH_B", { skip: !posix }, async () => {
  const w = await world()
  const a = w.clone("binding")
  const realGit = realpathSync(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim())
  const first = path.join(w.base, "first")
  const second = path.join(w.base, "second")
  await fs.mkdir(first)
  await fs.mkdir(second)
  const logA = path.join(w.base, "A.log")
  const logB = path.join(w.base, "B.log")
  const executable = path.join(first, "git")
  await fs.writeFile(executable, `#!/bin/sh\necho "$*|$GIT_CONFIG_COUNT|$GIT_CONFIG_KEY_0|$GIT_CONFIG_VALUE_0|$GIT_CONFIG_KEY_1|$GIT_CONFIG_VALUE_1|$GIT_CONFIG_KEY_2|$GIT_CONFIG_VALUE_2|$GIT_OPTIONAL_LOCKS" >> "${slash(logA)}"\nexec "${slash(realGit)}" "$@"\n`, { mode: 0o755 })
  await fs.writeFile(path.join(second, "git"), `#!/bin/sh\necho used >> "${slash(logB)}"\nexit 99\n`, { mode: 0o755 })
  const env = { ...a.env, ...restrictiveProfile, PATH: `${first}${path.delimiter}${process.env.PATH}` }
  const calls = []
  const result = await publish(a, { env, git: { spawn: (command, args, options) => {
    assert.equal(command, executable)
    calls.push(args)
    const child = spawn(command, args, options)
    if (args.includes("--version")) {
      env.PATH = second
      options.env.PATH = second
    }
    return child
  } } })
  assert.equal(result.state, "acknowledged", JSON.stringify(result))
  const lines = (await fs.readFile(logA, "utf8")).trim().split("\n").map((line) => line.split("|"))
  assert.equal(lines.filter(([args]) => !args.includes(" hash-object ")).length, calls.length)
  assert.ok(lines.some(([args]) => args.includes(" hash-object ")), "canonical card reads use the same verified executable too")
  assert.deepEqual(lines[0], ["--version", "", "", "", "", "", "", "", "0"])
  for (const [args, ...values] of lines.slice(1)) {
    assert.deepEqual(values, ["3", "safe.bareRepository", "explicit", "credential.interactive", "never", "core.fsmonitor", "false", "0"], args)
  }
  await assert.rejects(fs.stat(logB), { code: "ENOENT" })
})

test("restrictive_profile_missing_or_non_executable_PATH_refuses_before_git", async () => {
  const w = await world()
  const a = w.clone("no-git")
  const expectedBasis = await basisFor(a)
  const noExec = path.join(w.base, "no-exec")
  const directory = path.join(w.base, "directory")
  await fs.mkdir(noExec)
  await fs.mkdir(path.join(directory, "git"), { recursive: true })
  await fs.writeFile(path.join(noExec, "git"), "not executable", { mode: 0o600 })
  const env = { ...a.env, ...restrictiveProfile }
  for (const name of Object.keys(env).filter((name) => name.toUpperCase() === "PATH")) delete env[name]
  let spawns = 0
  for (const PATH of [undefined, "", noExec, directory, path.join(w.base, "missing")]) {
    assert.deepEqual(await publish(a, { expectedBasis, env: { ...env, PATH }, git: {
      spawn: () => { spawns += 1; throw new Error("not resolved") },
    } }), { state: "policy_refused", resources: [] })
  }
  assert.equal(spawns, 0)
})

test("restrictive_profile_windows_path_aliases_follow_node_order_without_mutation", async () => {
  const w = await world()
  const a = w.clone("windows-path-aliases")
  const expectedBasis = await basisFor(a)
  const bin = path.join(w.base, "selected-bin")
  const missing = path.join(w.base, "missing-bin")
  await fs.mkdir(bin)
  const executable = path.join(bin, "git.exe")
  await fs.writeFile(executable, "fixture; the existing spawn seam supplies the process", { mode: 0o755 })
  const baseEnv = { ...a.env, ...restrictiveProfile }
  for (const name of Object.keys(baseEnv).filter((name) => name.toUpperCase() === "PATH")) delete baseEnv[name]

  for (const upper of [
    { name: "undefined", value: undefined, valid: false },
    { name: "empty", value: "", valid: false },
    { name: "missing", value: missing, valid: false },
    { name: "valid", value: bin, valid: true },
  ]) {
    for (const mixedFirst of [true, false]) {
      const label = `${upper.name} uppercase PATH; ${mixedFirst ? "Path" : "PATH"} inserted first`
      const mixed = upper.valid ? missing : bin
      const env = { ...baseEnv, ...(mixedFirst ? { Path: mixed, PATH: upper.value } : { PATH: upper.value, Path: mixed }) }
      const before = { ...env }
      const seen = []
      const result = await publish(a, { expectedBasis, env, git: { platform: "win32", spawn: (command, args, options) => {
        seen.push({ command, args: [...args], env: { ...options.env }, cwd: options.cwd })
        if (!upper.valid) throw new Error("an invalid selected PATH must not reach the version query")
        if (args.includes("--version")) return spawn(process.execPath, ["-e", "process.stdout.write('git version 2.36.0.windows.1\\n')"], options)
        return spawn(process.execPath, ["-e", "process.exit(1)"], options)
      } } })
      assert.deepEqual(env, before, label)
      assert.deepEqual(result, { state: upper.valid ? "not_git" : "policy_refused", resources: [] }, label)
      if (!upper.valid) {
        assert.deepEqual(seen.map(({ command, args }) => ({ command, args })), [], label)
        continue
      }
      assert.deepEqual(seen.map(({ command, args }) => ({ command, args })), [
        { command: realpathSync(executable), args: ["--version"] },
        { command: realpathSync(executable), args: ["-C", a.deskRoot, "rev-parse", "--show-toplevel"] },
      ], label)
      const writerEnv = { ...before, GIT_TERMINAL_PROMPT: "0" }
      const queryEnv = { ...writerEnv }
      for (const name of Object.keys(restrictiveProfile).filter((name) => name !== "GIT_OPTIONAL_LOCKS")) delete queryEnv[name]
      assert.deepEqual(seen[0].env, queryEnv, label)
      assert.deepEqual(seen[1].env, writerEnv, label)
      assert.equal(seen[0].cwd, path.parse(a.deskRoot).root, label)
    }
  }
})

test("restrictive_profile_windows_resolution_uses_case_insensitive_PATH_and_exe", async () => {
  const w = await world()
  const a = w.clone("windows-resolution")
  const expectedBasis = await basisFor(a)
  const bin = path.join(w.base, "bin")
  await fs.mkdir(bin)
  const executable = path.join(bin, "git.exe")
  await fs.writeFile(executable, "fixture; the existing spawn seam supplies the process", { mode: 0o755 })
  const env = { ...a.env, ...restrictiveProfile }
  for (const name of Object.keys(env).filter((name) => name.toUpperCase() === "PATH")) delete env[name]
  env.Path = `${path.join(w.base, "absent")};${bin}`
  const seen = []
  const result = await publish(a, { expectedBasis, env, git: { platform: "win32", spawn: (command, args, options) => {
    assert.equal(command, realpathSync(executable))
    seen.push(args)
    if (args.includes("--version")) return spawn(process.execPath, ["-e", "process.stdout.write('git version 2.36.0.windows.1\\n')"], options)
    return spawn(process.execPath, ["-e", "process.exit(1)"], options)
  } } })
  assert.equal(result.state, "not_git", "the new profile was semantically admitted; only the subsequent repository read fails")
  assert.deepEqual(seen, [["--version"], ["-C", a.deskRoot, "rev-parse", "--show-toplevel"]])
})

test("restrictive_profile_preserves_real_parent_and_generated_worktree_precedence_and_hooks", async () => {
  const w = await world()
  const a = w.clone("precedence")
  const sentinel = path.join(w.base, "unexpected-execution")
  const disabled = path.join(w.base, "fsmonitor-or-askpass")
  await fs.writeFile(disabled, `#!/bin/sh\necho unsafe >> "${slash(sentinel)}"\nexit 1\n`, { mode: 0o755 })
  const global = path.join(w.base, "global.config")
  const parentInclude = path.join(w.base, "parent.config")
  const branchInclude = path.join(w.base, "branch.config")
  const worktreeInclude = path.join(w.base, "worktree.config")
  const opposed = `[safe]\n bareRepository = all\n[credential]\n interactive = always\n[core]\n fsmonitor = "${slash(disabled)}"\n`
  for (const file of [parentInclude, branchInclude, worktreeInclude]) await fs.writeFile(file, opposed)
  await fs.writeFile(global, `${opposed}[includeIf "gitdir:${slash(a.deskRoot)}/.git"]\n path = "${slash(parentInclude)}"\n[includeIf "onbranch:desk-triage/**"]\n path = "${slash(branchInclude)}"\n[includeIf "gitdir:${slash(a.deskRoot)}/.git/worktrees/**"]\n path = "${slash(worktreeInclude)}"\n`)
  git(a.deskRoot, ["config", "extensions.worktreeConfig", "true"])
  const conflicts = [["safe.bareRepository", "all"], ["credential.interactive", "always"], ["core.fsmonitor", slash(disabled)]]
  for (const [key, value] of conflicts) {
    git(a.deskRoot, ["config", "--local", key, value])
    git(a.deskRoot, ["config", "--worktree", key, value])
  }
  const env = { ...a.env, ...restrictiveProfile, GIT_CONFIG_GLOBAL: global, GIT_ASKPASS: disabled, SSH_ASKPASS: disabled }
  const hookLog = path.join(w.base, "normal-hook.log")
  await writeHook(a, `git config --show-scope --get safe.bareRepository >> "${slash(hookLog)}"\ngit config --show-scope --get credential.interactive >> "${slash(hookLog)}"\ngit config --show-scope --get core.fsmonitor >> "${slash(hookLog)}"\nexit 0`)
  const contexts = new Set()
  const original = { ...env }
  const seamErrors = []
  const result = await publish(a, { env, git: { spawn: (command, args, options) => {
    try {
      if (args.includes("--version")) return spawn(command, args, options)
      for (const [name, value] of Object.entries(restrictiveProfile)) assert.equal(options.env[name], value, `${args}: ${name}`)
      const cwd = args[1]
      if (!contexts.has(cwd)) {
        contexts.add(cwd)
        const rawEnv = { ...options.env }
        for (const name of Object.keys(restrictiveProfile).filter((name) => name !== "GIT_OPTIONAL_LOCKS")) delete rawEnv[name]
        for (const [key, value] of conflicts) {
          assert.equal(git(cwd, ["config", "--get", key], { env: rawEnv }), value)
          const effective = git(cwd, ["config", "--show-scope", "--get", key], { env: options.env })
          const wanted = key === "safe.bareRepository" ? "explicit" : key === "credential.interactive" ? "never" : "false"
          assert.equal(effective, `command\t${wanted}`)
        }
        const all = git(cwd, ["config", "--show-origin", "--show-scope", "--get-all", "core.fsmonitor"], { env: options.env })
        assert.match(all, /local\t/u)
        assert.match(all, /worktree\t/u)
        assert.ok(all.includes(slash(cwd === a.deskRoot ? parentInclude : branchInclude)), all)
        if (cwd !== a.deskRoot) assert.ok(all.includes(slash(worktreeInclude)), all)
      }
      const child = spawn(command, args, options)
      if (args[2] === "worktree" && args[3] === "add") child.on("close", (code) => {
        if (code !== 0) return
        const writer = args.at(-2)
        for (const [key, value] of conflicts) git(writer, ["config", "--worktree", key, value], { env: options.env })
      })
      return child
    } catch (error) {
      seamErrors.push(error)
      throw error
    }
  } } })
  assert.deepEqual(seamErrors, [])
  assert.equal(result.state, "acknowledged", JSON.stringify(result))
  assert.equal(contexts.size, 2, "both actual consuming contexts were examined")
  assert.deepEqual(env, original, "the caller's full profile is not rewritten")
  assert.equal(await fs.readFile(hookLog, "utf8"), "command\texplicit\ncommand\tnever\ncommand\tfalse\n")
  await assert.rejects(fs.stat(sentinel), { code: "ENOENT" })
  assert.equal(remoteJson(w.origin, paths.registry).entries[0].id, result.id)

  for (const [name, body, state] of [
    ["refusing", "exit 1", "policy_refused"],
    ["mutating", 'echo "# changed" >> "$0"\nexit 0', "policy_unknown"],
  ]) {
    const b = w.clone(name)
    await writeHook(b, body)
    const before = git(w.origin, ["rev-parse", "main"])
    const held = await publish(b, { env: { ...b.env, ...restrictiveProfile }, review: { ...AGENT, protected_result: hex(16) } })
    assert.equal(held.state, state, JSON.stringify(held))
    assert.equal(held.ack, undefined)
    assert.equal(git(w.origin, ["rev-parse", "main"]), before)
  }
})

test("non_git_unsynchronized_busy_and_failed_git_calls_hold", async () => {
  const w = await world()
  const a = w.clone("a")
  const basis = await basisFor(a)
  const plain = await mkTempRoot("triage-plain-")
  assert.equal((await publish({ ...a, deskRoot: plain }, { expectedBasis: basis })).state, "not_git")
  const nested = path.join(a.deskRoot, "notes")
  await fs.mkdir(nested)
  assert.equal((await publish({ ...a, deskRoot: nested }, { expectedBasis: basis })).state, "not_git", "a folder inside the desk is not the desk")
  assert.equal((await publish(a, { git: { spawn: () => { throw new Error("no git") } } })).state, "not_git")
  assert.equal((await publish(a, { git: { spawn: (command, args, options) => spawn(`${command}-definitely-missing`, args, options) } })).state, "not_git")

  git(a.deskRoot, ["branch", "--unset-upstream"])
  assert.equal((await publish(a)).state, "unsynchronized")
  git(a.deskRoot, ["branch", "--set-upstream-to=origin/main"])
  await fs.writeFile(path.join(a.deskRoot, ".git", "MERGE_HEAD"), `${git(a.deskRoot, ["rev-parse", "HEAD"])}\n`)
  assert.equal((await publish(a)).state, "unsynchronized", "a merge in progress")
  await fs.unlink(path.join(a.deskRoot, ".git", "MERGE_HEAD"))

  const lock = await acquireSyncLock({ root: a.deskRoot, env: a.env })
  try {
    assert.deepEqual(await publish(a), { state: "busy", resources: [] }, "a held lock is transient: no alarm")
  } finally {
    lock.release()
  }
  await fs.rename(w.origin, `${w.origin}.away`)
  assert.equal((await publish(a)).state, "unsynchronized", "no fetch")
  await fs.rename(`${w.origin}.away`, w.origin)

  const fails = async (match, state, replacement) => assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) }, git: { spawn: failing(match, replacement) } })).state, state, String(match))
  await fails((args) => args[0] === "rev-parse" && args[1] === "refs/remotes/origin/main", "unsynchronized")
  await fails((args) => args[0] === "status" && args.includes("--"), "unsynchronized")
  await fails((args) => args[0] === "worktree" && args[1] === "add", "write_failed")
  await fails((args) => args[0] === "add", "write_failed")
  await fails((args) => args[0] === "diff" && args[1] === "--cached", "policy_refused")
  await fails((args) => args[0] === "config" && args[1] === "--get-all", "policy_unknown")
  await fails((args) => args[0] === "rev-parse" && args[1] === "--git-path", "policy_unknown")
  await fails((args) => args[0] === "diff-tree", "policy_unknown")
  await fails((args) => args[0] === "status" && args.includes("--ignored") && !args.includes("--"), "policy_unknown")
  await fails((args) => args[0] === "push", "unacknowledged")
  const hung = (command, args, options) => (args[2] === "push" ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], options) : spawn(command, args, options))
  assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) }, git: { spawn: hung, timeoutMs: 4000 } })).state, "unacknowledged", "a push with an unknown outcome is not retried as if refused")
  // A clean worktree whose removal fails is retained and blocks the next call until it can be removed.
  const retained = await publish(a, { review: { ...AGENT, protected_result: hex(16) }, git: { spawn: failing((args) => args[0] === "worktree" && args[1] === "remove") } })
  assert.equal(retained.state, "acknowledged")
  assert.equal(retained.resources.find((r) => r.kind === "worktree").disposition, "retained")
  // While its removal keeps failing, every call is busy with the stable alarm code a loop raises.
  const stuck = await publish(a, { review: { ...HUMAN, protected_result: hex(16) }, git: { spawn: failing((args) => args[0] === "worktree" && args[1] === "remove") } })
  assert.equal(stuck.state, "busy")
  assert.equal(stuck.alarm, RESOURCE_ALARM)
  assert.equal(stuck.resources[0].disposition, "retained")
  const next = await publish(a, { review: { ...HUMAN, protected_result: hex(16) } })
  assert.equal(next.state, "acknowledged")
  assert.equal(next.resources[0].disposition, "removed", "recovered first")
})

// Git's own view of the desk's worktrees: every path `git worktree list` names, and every `desk-triage/*` branch.
function worktreesAndTriageBranches(root) {
  const worktrees = git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).map((line) => realpathSync(line.slice("worktree ".length)))
  const branches = git(root, ["branch", "--list", "--format=%(refname:short)", "desk-triage/*"]).split("\n").filter(Boolean)
  return { worktrees, branches }
}

test("triage removes its own worktree and branch after its commit reaches main", async () => {
  const w = await world()
  const a = w.clone("a")
  // Another session's worktree and a desk-triage branch no record of this writer owns: never touched.
  const foreignTree = path.join(w.base, "someone-elses-worktree")
  git(a.deskRoot, ["worktree", "add", "-q", "-b", "feature/other", foreignTree, "HEAD"])
  const foreignBranch = `desk-triage/${"e".repeat(32)}`
  git(a.deskRoot, ["branch", foreignBranch, "HEAD"])

  const result = await publish(a)

  assert.equal(result.state, "acknowledged", JSON.stringify(result))
  assert.equal(result.ack.commit, git(w.origin, ["rev-parse", "main"]), "the commit reached main")
  const own = result.resources.find((r) => r.kind === "worktree")
  assert.equal(own.disposition, "removed")
  const { worktrees, branches } = worktreesAndTriageBranches(a.deskRoot)
  assert.deepEqual(worktrees, [realpathSync(a.deskRoot), realpathSync(foreignTree)], "only the checkout and the other session's worktree are left")
  assert.deepEqual(branches, [foreignBranch], "only the branch this writer does not own is left")
  assert.equal(git(foreignTree, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature/other")
  assert.deepEqual(await fs.readdir(path.dirname(path.dirname(own.path))), [], "no folder or record of its own is left")
})

// A `git worktree add` cut off mid-checkout (its process killed with the session, say, so Git's own clean-up never runs) leaves a
// worktree locked "initializing", part of a checkout, and its branch: one was found at 1.2 GB. Git drops that lock before any hook
// runs, so the half-made worktree holds only part of a checkout of a commit Git already has. This writer removes it and its branch,
// instead of keeping it and blocking every later call.
test("triage removes its own half-made worktree and branch when creating the worktree is cut off", async () => {
  const w = await world()
  const a = w.clone("a")
  // The real `git worktree add`, left the way a cut-off one leaves it: locked "initializing", nothing checked out, a failed exit.
  const script = "const r = require('child_process').spawnSync(process.argv[1], process.argv.slice(2), { stdio: 'ignore' }); process.exit(r.status === 0 ? 137 : 1)"
  const cutOff = (command, args, options) => (args[2] === "worktree" && args[3] === "add"
    ? spawn(process.execPath, ["-e", script, command, ...args.slice(0, 2), "worktree", "add", "--no-checkout", "--lock", "--reason", "initializing", ...args.slice(4)], options)
    : spawn(command, args, options))

  const cut = await publish(a, { git: { spawn: cutOff } })

  assert.equal(cut.state, "write_failed", JSON.stringify(cut))
  assert.equal(cut.resources.find((r) => r.kind === "worktree").disposition, "removed", JSON.stringify(cut.resources))
  assert.deepEqual(worktreesAndTriageBranches(a.deskRoot), { worktrees: [realpathSync(a.deskRoot)], branches: [] })
  const next = await publish(a)
  assert.equal(next.state, "acknowledged", "the next call is not blocked by a leftover")
})

// A writer that dies during `git worktree add` leaves that Git process running in its own process group, still checking out. The
// next writer must not remove the worktree under it: it keeps the worktree while the recorded process is alive, or when no process
// was recorded, and removes it once that process has ended.
test("triage keeps an interrupted worktree while the git process creating it still runs", { skip: !posix }, async (t) => {
  const w = await world()
  const a = w.clone("a")
  const first = await publish(a)
  assert.equal(first.state, "acknowledged")
  const ops = path.dirname(path.dirname(first.resources.find((r) => r.kind === "worktree").path))
  // Leaves a worktree exactly as an interrupted add does, with the operation record a dead writer left.
  const interrupted = async (extra) => {
    const token = hex(16)
    const record = { schema: "desk.factory.triage-operation/1", token, path: path.join(ops, token, "wt"), ref: `desk-triage/${token}`, owner: 1, files: [paths.registry, paths.annotation], disposition: "active", ...extra }
    git(a.deskRoot, ["worktree", "add", "-q", "--no-checkout", "--lock", "--reason", "initializing", "-b", record.ref, record.path, "HEAD"])
    await fs.writeFile(path.join(ops, `${token}.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 })
    return record
  }
  const checkout = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { detached: true, stdio: "ignore" })
  t.after(() => { try { process.kill(-checkout.pid, "SIGKILL") } catch {} })
  const running = await interrupted({ addPid: checkout.pid })

  const blocked = await publish(a, { review: { ...AGENT, protected_result: hex(16) } })
  assert.equal(blocked.state, "busy", JSON.stringify(blocked))
  assert.equal(blocked.alarm, RESOURCE_ALARM)
  assert.equal(blocked.resources[0].disposition, "retained")
  assert.ok(worktreesAndTriageBranches(a.deskRoot).branches.includes(running.ref), "kept while its git process runs")

  const ended = new Promise((resolve) => checkout.on("exit", resolve))
  process.kill(-checkout.pid, "SIGKILL")
  await ended
  const next = await publish(a, { review: { ...AGENT, protected_result: hex(16) } })
  assert.equal(next.state, "acknowledged", JSON.stringify(next))
  assert.equal(next.resources[0].disposition, "removed", "removed once that process ended")
  assert.deepEqual(worktreesAndTriageBranches(a.deskRoot), { worktrees: [realpathSync(a.deskRoot)], branches: [] })

  // No recorded process: Desk cannot tell, so it keeps the worktree and reports it.
  const unknown = await interrupted({})
  const unsure = await publish(a, { review: { ...HUMAN, protected_result: hex(16) } })
  assert.equal(unsure.state, "busy")
  assert.equal(unsure.resources[0].disposition, "retained")
  assert.ok(worktreesAndTriageBranches(a.deskRoot).branches.includes(unknown.ref))
})

// A worktree locked for any other reason, or one a hook wrote into, is still kept: only an unfinished `worktree add` is removed.
test("triage keeps its own worktree when it is locked for another reason", async () => {
  const w = await world()
  const a = w.clone("a")
  const script = "const r = require('child_process').spawnSync(process.argv[1], process.argv.slice(2), { stdio: 'ignore' }); process.exit(r.status === 0 ? 1 : 2)"
  const lockedByHand = (command, args, options) => (args[2] === "worktree" && args[3] === "add"
    ? spawn(process.execPath, ["-e", script, command, ...args.slice(0, 2), "worktree", "add", "--no-checkout", "--lock", "--reason", "kept by the operator", ...args.slice(4)], options)
    : spawn(command, args, options))

  const kept = await publish(a, { git: { spawn: lockedByHand } })

  assert.equal(kept.state, "write_failed")
  assert.equal(kept.resources.find((r) => r.kind === "worktree").disposition, "retained")
  assert.equal(worktreesAndTriageBranches(a.deskRoot).worktrees.length, 2)
})

test("foreign_or_vanished_operation_records", async () => {
  const w = await world()
  const a = w.clone("a")
  const crashed = await publish(a, { git: { onStep: (name) => { if (name === "pushed") throw new Error("killed") } } })
  const record = crashed.resources.find((r) => r.kind === "worktree")
  // The worktree vanished (someone removed the folder): the record and branch are still cleaned up.
  git(a.deskRoot, ["worktree", "remove", "--force", record.path])
  const after = await publish(a)
  assert.equal(after.state, "adopted")
  assert.equal(git(a.deskRoot, ["branch", "--list", "desk-triage/*"]), "", "the owned branch is gone")
  // A record this writer does not own is never touched and blocks new resources.
  const ops = path.dirname(path.dirname(record.path))
  await fs.writeFile(path.join(ops, `${"f".repeat(32)}.json`), `${JSON.stringify({ schema: "something-else" })}\n`)
  await fs.writeFile(path.join(ops, "README"), "not a record\n")
  const blocked = await publish(a)
  assert.equal(blocked.state, "busy")
  assert.equal(blocked.alarm, RESOURCE_ALARM)
  assert.equal(blocked.resources[0].ref, null)
  await fs.writeFile(path.join(ops, `${"f".repeat(32)}.json`), "{not json")
  assert.equal((await publish(a)).state, "busy")
})

test("windows_platform_paths_use_tree_kill_and_acl_protection", async (t) => {
  const w = await world()
  const a = w.clone("a")
  const systemRoot = path.join(w.base, "fake-system-root")
  await fs.mkdir(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"), { recursive: true })
  await fs.writeFile(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "stand-in; the runner is injected")
  const protectedPaths = []
  const aclRunner = async ({ payload }) => {
    const request = JSON.parse(payload)
    protectedPaths.push(...request.paths.map((entry) => entry.path))
    return {
      code: 0, stderr: "",
      stdout: JSON.stringify({ status: "ok", results: request.paths.map((entry) => ({ ...entry, owner_sid: "S-1-5-21-1-2-3-1001", owner_reassigned: false, protected: true, rule_count: 1 })) }),
    }
  }
  const env = { ...a.env, SystemRoot: systemRoot }
  let spawnGit = spawn
  if (posix && Object.hasOwn(env, "GIT_CONFIG_COUNT")) {
    // Simulated Windows lookup resolves .exe to the real Git; its children retain the host's native PATH.
    const realGit = realpathSync(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim())
    const bin = path.join(w.base, "windows-git")
    await fs.mkdir(bin)
    await fs.symlink(realGit, path.join(bin, "git.exe"))
    const hostPath = env.PATH
    env.PATH = bin
    spawnGit = (command, args, options) => spawn(command, args, {
      ...options, env: { ...options.env, PATH: hostPath },
    })
  }
  const file = await writeProtectedTriageFile(env, ["basis", "x.json"], "{}\n", { platform: "win32", runner: aclRunner })
  assert.ok(protectedPaths.includes(file))
  const result = await publish({ ...a, env }, { git: { platform: "win32", aclRunner, spawn: spawnGit } })
  assert.equal(result.state, "acknowledged", JSON.stringify(result))
  // On Windows a timed-out call is ended with its process tree (taskkill /T); here the stand-in push ends by itself, so the call
  // settles either way and is never taken for a refused push.
  let delayedPolicyProbe = false
  let pushCalls = 0
  const steps = []
  let reachedPush
  const pushStarted = new Promise(resolve => { reachedPush = resolve })
  // Node's Windows RNG needs the real OS root; only the injected fault helpers use it.
  const spawnFaultNode = (args, options) => spawnGit(process.execPath, args, {
    ...options, env: posix ? options.env : { ...options.env, SystemRoot: process.env.SystemRoot },
  })
  const slowPush = (command, args, options) => {
    if (!delayedPolicyProbe && args[2] === "config" && args[3] === "--get-all") {
      delayedPolicyProbe = true
      return spawnFaultNode(["-e", `
        const { spawn } = require("node:child_process");
        setTimeout(() => {
          const child = spawn(${JSON.stringify(command)}, ${JSON.stringify(args)}, {
            stdio: "inherit", windowsHide: true, env: { ...process.env, SystemRoot: ${JSON.stringify(systemRoot)} },
          });
          child.on("error", error => { console.error(error); process.exitCode = 1; });
          child.on("exit", code => { process.exitCode = code ?? 1; });
        }, 1100);
      `], options)
    }
    if (args[2] === "push") {
      pushCalls++
      const child = spawnFaultNode(["-e", "setTimeout(() => {}, 1500)"], options)
      reachedPush(child)
      return child
    }
    return spawnGit(command, args, options)
  }
  t.mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const pending = publish({ ...a, env }, {
      review: { ...AGENT, protected_result: hex(16) },
      git: { platform: "win32", aclRunner, spawn: slowPush, timeoutMs: 1000, onStep: name => steps.push(name) },
    })
    const observed = await Promise.race([pushStarted, pending])
    assert.ok(Number.isInteger(observed.pid), JSON.stringify({ state: observed.state }))
    let settled = false
    pending.then(() => { settled = true })
    t.mock.timers.tick(999)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, "the push has not reached its unchanged one-second deadline")
    t.mock.timers.tick(1)
    const timed = await pending
    assert.equal(timed.state, "unacknowledged", JSON.stringify(timed))
    assert.equal(delayedPolicyProbe, true)
    assert.equal(pushCalls, 1, "an unknown push outcome must not be retried")
    assert.equal(steps.includes("pushed"), false, "the unchanged timeout must fire before a successful push response")
  } finally {
    t.mock.timers.reset()
  }
  assert.ok(protectedPaths.some((p) => p.endsWith(".json") && p.includes(`${path.sep}basis${path.sep}`)))
})

test("authority_is_proved_at_the_git_boundary", async () => {
  const w = await world()
  const a = w.clone("a")
  const before = await basisFor(a)
  assert.ok(before.authority.codes.includes("existing_scope"))
  const result = { ...fixture.private_candidate.result, route: "agent_ready", authority: { code: "existing_scope", ruling_ids: ["AGENTS.md"] }, decision: null, gate_reason: null, recommendation: null, safe_continuation: null }
  const toSafe = (basis) => toSafeTriageReview({ result, basis, authorizedEvidence: [], protectedToken: hex(16), briefKeys: [KEY, fixture.related_key] })
  const agentReady = toSafe(before)
  assert.equal(agentReady.state, "safe")

  // The ruling is revoked with the card bytes unchanged: the agent-ready review is refused on the fresh basis, and nothing is pushed.
  await remoteChange(w, "revoke", (root) => fs.unlink(path.join(root, "AGENTS.md")))
  git(a.deskRoot, ["pull", "-q"])
  const head = git(w.origin, ["rev-parse", "main"])
  const after = await basisFor(a)
  assert.equal(after.canonical_revision, before.canonical_revision, "same card bytes")
  assert.deepEqual(after.authority.codes, ["investigation_only", "human_gate"])
  assert.deepEqual(toSafe(after), { state: "refused", review: null, errors: [{ code: "authority_unproved", path: "" }] })
  assert.equal((await publish(a, { review: agentReady.review, expectedBasis: after })).state, "policy_refused")
  assert.equal((await publish(a, { review: agentReady.review, expectedBasis: before })).state, "stale_basis", "the basis read before the revocation no longer holds")
  assert.equal(git(w.origin, ["rev-parse", "main"]), head, "nothing was pushed")
  assert.equal(remoteJson(w.origin, paths.registry), null)

  // A basis that claims more authority than its rulings give is refused, whoever built it.
  const forged = [
    { ...after, authority: { ...after.authority, codes: ["existing_scope", ...after.authority.codes] } },
    { ...before, authority: { ...before.authority, codes: ["approved_plan", ...before.authority.codes] } },
    { ...before, authority: { ...before.authority, codes: ["approved_plan", ...before.authority.codes], plan_ids: ["plans/unread.md"] } },
    { ...before, authority: { ...before.authority, codes: ["ship_it"] } },
    { ...before, authority: null },
    { ...before, authority: { codes: before.authority.codes } },
    { ...before, evidence: [{ id: "evidence:0", pointer: "issue:x#1", revision: 0 }] },
    { ...before, evidence: null },
  ]
  // Without a live resolver only self-describing evidence resolves, so the issue-backed basis does not hold.
  assert.equal((await publishOwnedTriage({ env: a.env, deskRoot: a.deskRoot, personPrefix: "", key: KEY, store: STORE, expectedBasis: after, review: { ...HUMAN, protected_result: hex(16) }, operation: "review", now: T0 })).state, "stale_basis")
  for (const expectedBasis of forged) assert.equal((await publish(a, { review: agentReady.review, expectedBasis })).state, "policy_refused", JSON.stringify(expectedBasis.authority))
  // A human gate stays possible without a ruling.
  assert.equal((await publish(a, { expectedBasis: after })).state, "acknowledged")
})

test("unresolved_authority_never_publishes_agent_ready", async () => {
  const w = await world({ agents: false })
  const a = w.clone("a")
  const basis = await basisFor(a)
  assert.equal(basis.authority.state, "unresolved")
  assert.deepEqual(basis.authority.codes, ["investigation_only", "human_gate"])
  const result = { ...fixture.private_candidate.result, route: "agent_ready", authority: { code: "existing_scope", ruling_ids: ["AGENTS.md"] }, decision: null, gate_reason: null, recommendation: null, safe_continuation: null }
  assert.equal(toSafeTriageReview({ result, basis, authorizedEvidence: [], protectedToken: hex(16), briefKeys: [KEY] }).state, "refused")
  assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) }, expectedBasis: basis })).state, "policy_refused")
  assert.equal((await publish(a, { review: { ...AGENT, authority_code: "approved_plan", protected_result: hex(16) }, expectedBasis: basis })).state, "policy_refused")
  assert.equal(remoteJson(w.origin, paths.registry), null, "nothing was pushed")
})

test("crlf_checkout_keeps_the_basis_git_would_commit", async () => {
  // Cards keep their LF bytes (the card reader reads LF cards only); every other text file, AGENTS.md included, is converted.
  const w = await world({ attributes: `${path.posix.dirname(paths.card)}/*.md -text\n` })
  const a = w.clone("a", ["-c", "core.autocrlf=true"])
  assert.match(await fs.readFile(path.join(a.deskRoot, "AGENTS.md"), "utf8"), /\r\n$/u, "the checkout converted AGENTS.md to CRLF")
  const basis = await basisFor(a)
  assert.equal(basis.rulings.find((ruling) => ruling.id === "AGENTS.md").revision, git(a.deskRoot, ["rev-parse", "HEAD:AGENTS.md"]))
  assert.equal(basis.canonical_revision, git(a.deskRoot, ["rev-parse", `HEAD:${paths.card}`]))
  const result = await publish(a, { expectedBasis: basis })
  assert.equal(result.state, "acknowledged", JSON.stringify(result))
})
