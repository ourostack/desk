// Ownership with expiring leases. A claim holds a card only while its owner keeps pushing: two hours with nothing pushed lapses it,
// and a claim whose owning session has ended has no owner. Only a push GitHub recorded renews a lease. Messages, reruns, a repeated
// claim and any time the claim file itself states are not inputs. See docs/keep-the-work-moving.md.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { drainsHome } from "./drains.js"
import { lastActivity, sessionStateDir } from "./session-activity.js"

export const LEASE_MS = 2 * 60 * 60 * 1000

export function leasePaths(options) {
  return { claims: path.join(drainsHome(options), "claims.json") }
}

/** One claim's state: `ownerless` (its session ended), `lapsed` (nothing pushed for two hours since it began) or `held`. */
export function assessLease({ claim, now, lastPushMs = null, ownerEnded = false }) {
  if (ownerEnded) return { state: "ownerless", why: "the session that owns it has ended" }
  // A time in the future (a clock or a hand edit) counts for nothing, so it can never stretch a lease.
  const past = (t) => (Number.isFinite(t) && t <= now ? t : -Infinity)
  const since = Math.max(past(Date.parse(claim.claimedAt)), past(lastPushMs))
  if (!Number.isFinite(since)) return { state: "lapsed", why: "it has no start time and no push" }
  const idle = now - since
  return idle >= LEASE_MS
    ? { state: "lapsed", why: `nothing pushed for ${Math.floor(idle / 60_000)} minutes` }
    : { state: "held", why: `${Math.floor((LEASE_MS - idle) / 60_000)} minutes left unless something is pushed` }
}

/** Takes a card. A held card stays with its owner, and claiming it again, even by the owner, does not restart its lease. */
export function takeClaim({ claims, card, owner, now, assess }) {
  const existing = claims.find((c) => c.card === card)
  if (existing && assess(existing).state === "held") return { claims, taken: false, owner: existing.owner }
  const rest = claims.filter((c) => c.card !== card)
  return { claims: [...rest, { card, owner, claimedAt: new Date(now).toISOString(), repo: existing?.repo, branch: existing?.branch }], taken: true, owner }
}

/** The server's time of the last push to a branch, from GitHub's events: an agent cannot backdate it as it can a commit's date. */
function ghLastPush(repo, branch) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo ?? "") || typeof branch !== "string" || branch === "") return null
  const run = spawnSync("gh", ["api", `repos/${repo}/events?per_page=100`, "-q", `[.[]|select(.type=="PushEvent" and .payload.ref=="refs/heads/${branch.replaceAll('"', "")}")][0].created_at // empty`], { encoding: "utf8", timeout: 20_000 })
  const at = Date.parse(run.stdout?.trim() ?? "")
  return run.status === 0 && Number.isFinite(at) ? at : null
}

function readClaims(paths) {
  try {
    const claims = JSON.parse(readFileSync(paths.claims, "utf8")).claims
    return Array.isArray(claims) ? claims : []
  } catch {
    return [] // no claims file means no claims
  }
}

/** Takes a card for a session and records it. The branch and repository are what GitHub's pushes are read from. */
export async function claimCard({ paths, card, owner, repo, branch, now, env, push = ghLastPush }) {
  const claims = readClaims(paths)
  const ended = async (c) => {
    try { return (await lastActivity(path.join(sessionStateDir(env), c.owner, "events.jsonl"))).closed === true } catch { return true }
  }
  const existing = claims.find((c) => c.card === card)
  const ownerEnded = existing ? await ended(existing) : false
  const assess = (c) => assessLease({ claim: c, now, lastPushMs: push(c.repo, c.branch), ownerEnded })
  const result = takeClaim({ claims, card, owner, now, assess })
  if (result.taken) {
    const claim = result.claims.find((c) => c.card === card)
    claim.repo = repo ?? claim.repo
    claim.branch = branch ?? claim.branch
    mkdirSync(path.dirname(paths.claims), { recursive: true })
    const tmp = `${paths.claims}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ claims: result.claims }, null, 1)}\n`)
    renameSync(tmp, paths.claims)
  }
  return { card, taken: result.taken, owner: result.owner, status: [result.taken ? `${card}: claimed by ${owner}, lapses after two hours with nothing pushed` : `${card}: held by ${result.owner}; it can be taken when it lapses or its session ends`] }
}

/** Reads claims.json and judges every claim against GitHub's last push and its owner's own history. */
export async function leaseStatus({ paths, now, env, push = ghLastPush }) {
  const claims = readClaims(paths)
  const dir = sessionStateDir(env)
  const leases = []
  for (const claim of claims) {
    let ownerEnded = true
    try {
      ownerEnded = (await lastActivity(path.join(dir, claim.owner, "events.jsonl"))).closed === true
    } catch { /* a history that is gone belongs to an ended session */ }
    leases.push({ card: claim.card, owner: claim.owner, ...assessLease({ claim, now, lastPushMs: push(claim.repo, claim.branch), ownerEnded }) })
  }
  return { leases, status: leases.map((l) => `${l.card}: ${l.state} (${l.why})`) }
}
