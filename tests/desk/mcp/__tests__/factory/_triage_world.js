// A synthetic owned desk for the triage step: a temporary bare remote, one clone with real cards, rulings and Git, an isolated
// factory state folder with consent, and a fake owned-catalog runner. The fake runner stands in for the runner's custody only: it reads
// the real prepared input through the catalog's own reader and writes a candidate file the way materialization does. Everything after it
// (validation, the live basis recheck, the protected result, the safe transform and the Git writer) is the real code.

import { spawnSync } from "node:child_process"
import { promises as fs, constants as fsConstants } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { openImprovement } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { setConsent, updateStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { readTriagePreparedFile } from "../../../../../plugins/desk/mcp/src/factory/triage-catalog.js"
import { publishOwnedTriage } from "../../../../../plugins/desk/mcp/src/factory/triage-write.js"

export const STORE = "example-org/example-store"
// The runner's prepared input lives in a folder checked by POSIX owner and mode, so no triage run can be prepared on Windows (where the
// step stops at `unsupported_host` before preparing anything). Tests that need a run are skipped there with this reason; the step's own
// Windows behavior is tested by the unsupported-host tests, which run everywhere.
export const NEEDS_PREPARED_RUN = process.platform === "win32" ? "a triage run's prepared input needs POSIX owner-only modes, which NTFS does not keep; off macOS the step stops at unsupported_host, which is tested on every platform" : false
export const KEYS = ["andon:example-org/example-repo#101", "andon:example-org/example-repo#102", "andon:example-org/example-repo#103"]
export const SENTINELS = ["PRIVATE-PROBLEM-SENTINEL", "PRIVATE-IMPACT-SENTINEL", "PRIVATE-NEXT-SENTINEL", "PRIVATE-DECISION-SENTINEL", "PRIVATE-RECOMMENDATION-SENTINEL", "PRIVATE-CONTINUATION-SENTINEL", "PRIVATE-QUOTE-SENTINEL"]
export const resolveIssue = async (pointer) => ({ revision: 3, public: { kind: "issue", ref: `https://github.com/example-org/example-repo/issues/${pointer.split("#")[1]}`, revision: 3 } })

export function git(cwd, args, { allowFail = false } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

function configure(root) {
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
}

export function commitAll(root, message) {
  configure(root)
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", message])
}

/** Commits and pushes every change in the clone, on top of what the triage writer pushed, as a person editing the desk would. */
export function pushDesk(desk, message = "desk change") {
  commitAll(desk.deskRoot, message)
  git(desk.deskRoot, ["pull", "-q", "--rebase", "origin", "main"])
  git(desk.deskRoot, ["push", "-q", "origin", "HEAD:main"])
}

/** The environment without the provider switches and credentials that would make a run bill per token (`billingVariableBlocks`), whatever the machine running the tests has set. */
export const subscriptionEnv = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !/^(?:ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|AWS_BEARER_TOKEN_BEDROCK$)/u.test(name)))

/**
 * `triageWorld({ keys, now }) -> { base, origin, deskRoot, env, keys }`: a seeded remote and a clone, an AGENTS.md ruling, one andon
 * card per key with an issue pointer, consent for the store and a valid legacy evaluator day, so the shared ledger migrates.
 */
export async function triageWorld({ keys = KEYS, now, agents = "Agents may fix factory defects in existing scope.\n" } = {}) {
  const base = await mkTempRoot("triage-step-")
  const origin = path.join(base, "origin.git")
  git(base, ["init", "-q", "--bare", origin])
  const seed = path.join(base, "seed")
  await fs.mkdir(seed)
  git(seed, ["init", "-q", "-b", "main"])
  if (agents !== null) await fs.writeFile(path.join(seed, "AGENTS.md"), agents)
  await fs.writeFile(path.join(seed, "README.md"), "desk\n")
  for (const key of keys) {
    const opened = await openImprovement({ deskRoot: seed, personPrefix: "", key, source: key.slice(0, key.indexOf(":")), evidence: [`issue:${key.slice(key.indexOf(":") + 1)}`], plugin: "desk", signal: null, now })
    if (opened.result !== "opened") throw new Error(`seed card: ${opened.result}`)
  }
  commitAll(seed, "seed")
  git(seed, ["remote", "add", "origin", origin])
  git(seed, ["push", "-q", "-u", "origin", "main"])
  const deskRoot = path.join(base, "desk")
  git(base, ["clone", "-q", origin, deskRoot])
  configure(deskRoot)
  const env = { ...subscriptionEnv(process.env), HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  await setConsent(env, { store: STORE, contribute: true, account: "someone" })
  await updateStatus(env, (status) => ({ ...status, evaluator: { headless: { day: new Date(now).toISOString().slice(0, 10), jobs: 0 } } }))
  return { base, origin, deskRoot, env, keys }
}

/** A valid candidate row for one brief card on `route`, with private prose that must never reach Git. */
export function row(card, route = "investigate", extra = {}) {
  const human = route === "human_decision"
  return {
    key: card.key, basis: card.basis, route,
    problem: "PRIVATE-PROBLEM-SENTINEL the signing step drops builds",
    observed_impact: "PRIVATE-IMPACT-SENTINEL \"PRIVATE-QUOTE-SENTINEL we lost the Friday release\"",
    unknowns: [], next_step: "PRIVATE-NEXT-SENTINEL inspect the build log for the failing step",
    authority: route === "agent_ready" ? { code: "existing_scope", ruling_ids: card.ruling_ids.slice(0, 1) } : { code: human ? "human_gate" : "investigation_only", ruling_ids: [] },
    evidence: card.evidence_ids, related: [], duplicates: [],
    decision: human ? "PRIVATE-DECISION-SENTINEL delete the old signing key" : null,
    gate_reason: human ? "irreversible" : null,
    recommendation: human ? "PRIVATE-RECOMMENDATION-SENTINEL rotate first" : null,
    safe_continuation: human ? "PRIVATE-CONTINUATION-SENTINEL keep collecting logs" : null,
    ...extra,
  }
}

/**
 * `fakeRunner(produce) -> runTriageChild`: reads the prepared input with the catalog's reader, calls `produce({ brief, records, recordRefs,
 * inputDir })` for the candidate's result rows (or a `{ state }` to return instead), and writes the canonical candidate as an owner-only
 * file beside the input, as materialization does. `calls` records each call's options.
 */
export function fakeRunner(produce = ({ brief }) => brief.cards.map((card) => row(card))) {
  const calls = []
  const run = async (options) => {
    calls.push(options)
    const prepared = await readTriagePreparedFile({ inputDir: options.inputDir })
    const produced = await produce({ ...prepared, inputDir: options.inputDir })
    if (!Array.isArray(produced)) return produced
    const candidate = { schema: "desk.factory.triage-result/1", batch: prepared.brief.batch, rubric_version: prepared.brief.rubric_version, producer_version: prepared.brief.producer_version, results: produced }
    const handle = await fs.open(options.resultFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    try {
      await handle.writeFile(JSON.stringify(candidate))
    } finally {
      await handle.close()
    }
    return { state: "ran", resultFile: options.resultFile, cost_usd: 0 }
  }
  run.calls = calls
  return run
}

/** A loaded runner runtime that holds nothing: the seams that use it are replaced. */
export const FAKE_RUNTIME = Object.freeze({ state: "loaded", runner: {}, custody: {}, qualify: {} })

/** The seams of a qualified, signed-in Darwin host with the fake runner, a test clock and the issue resolver. */
export function qualifiedSeams({ runner = fakeRunner(), clock, ...extra } = {}) {
  return {
    loadRunner: async () => FAKE_RUNTIME,
    hostSupport: async () => ({ provenance: true }),
    restoreQualification: async () => ({ state: "qualified", qualification: { state: "qualified" } }),
    locateEngine: async () => "/opt/engine/claude",
    // The real writer, with room for a slow machine: a test run under load must not turn a slow push into a refused review.
    publishOwnedTriage: (options) => publishOwnedTriage({ ...options, git: { ...options.git, timeoutMs: 60_000 } }),
    probeSignIn: async () => ({ state: "subscription" }),
    runTriageChild: runner,
    evidence: { resolve: resolveIssue },
    ...(clock === undefined ? {} : { clock }),
    ...extra,
  }
}

/** Every blob the remote's history holds, as text, for privacy scans. */
export function remoteBlobs(origin) {
  const out = []
  for (const commit of git(origin, ["rev-list", "--all"]).split("\n").filter(Boolean)) {
    for (const line of git(origin, ["ls-tree", "-r", commit]).split("\n").filter(Boolean)) {
      const sha = line.split(/\s+/u)[2]
      out.push(git(origin, ["cat-file", "-p", sha]))
    }
  }
  return out
}

export const remoteJson = (origin, file) => {
  const shown = spawnSync("git", ["-C", origin, "show", `main:${file}`], { encoding: "utf8" })
  return shown.status === 0 ? JSON.parse(shown.stdout) : null
}
