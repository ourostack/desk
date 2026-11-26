// The keeper: a check that runs outside every agent session (launchd, Task Scheduler, cron: whatever the host has) and spends no model turn.
// It answers from outcomes, never from whether a session looks busy: a wait whose expiry passed, a wait renewed again and again, an
// ending the gate could not verify, a claim that lapsed or lost its owner, and a peer keeper that went quiet. Two hosts run it and each
// reads the other's heartbeat, so one host's keeper dying is itself a finding. See docs/keep-the-work-moving.md.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"

const PEER_QUIET_MS = 30 * 60_000
const RENEWED_WAITS = 3

/** The last ending of each card, plus how many waits on the same thing it chained in a row. Order comes from the ledger's own times. */
function lastPerCard(endings) {
  const cards = new Map()
  for (const e of [...endings].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    if (typeof e.card !== "string" || !e.ending) continue
    const before = cards.get(e.card)
    const chained = e.ending.kind === "waiting" && before?.ending.kind === "waiting" && before.ending.on === e.ending.on ? before.chained + 1 : e.ending.kind === "waiting" ? 1 : 0
    cards.set(e.card, { ...e, chained })
  }
  return cards
}

/** What needs a job, from the ledger and the leases alone. A session's "busy" flag is not an input, so it can't hide anything. */
export function findings({ endings = [], leases = [], now }) {
  const out = []
  for (const [card, e] of lastPerCard(endings)) {
    const { kind, on, blocks, expires } = e.ending
    if (kind === "waiting" && Date.parse(expires) <= now) out.push({ kind: "wait_expired", card, on, blocks, why: `its wait on ${on} expired ${expires}` })
    else if (kind === "waiting" && e.chained >= RENEWED_WAITS) out.push({ kind: "wait_renewed", card, on, blocks, why: `it has waited on ${on} ${e.chained} times in a row; a wait that keeps moving is not a wait` })
    else if (kind === "unverified") out.push({ kind: "unverified_end", card, why: e.ending.why ?? "its last ending could not be verified" })
  }
  for (const l of leases) if (l.state !== "held") out.push({ kind: l.state === "ownerless" ? "no_owner" : "lease_lapsed", card: l.card, why: `${l.state}: ${l.why}` })
  return out
}

/** Writes this host's heartbeat where the peer reads it. */
export function beat({ dir, host, now }) {
  const file = path.join(dir, `${host}.json`)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ host, at: new Date(now).toISOString() })}\n`)
  renameSync(tmp, file)
  return file
}

const git = (repo, args, input) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", input, timeout: 30_000, windowsHide: true })

/** Publishes the heartbeat as a blob on `refs/heartbeats/<host>` of a shared remote, so a peer reads it with no inbound ssh. Returns whether it landed. */
export function publish({ repo, host, now }) {
  if (!repo || !/^[\w.-]+$/u.test(host)) return false
  const made = git(repo, ["hash-object", "-w", "--stdin"], `${JSON.stringify({ host, at: new Date(now).toISOString() })}\n`)
  if (made.status !== 0) return false
  return git(repo, ["push", "-q", "origin", `+${made.stdout.trim()}:refs/heartbeats/${host}`]).status === 0
}

/** Reads a peer's published heartbeat; null when it cannot be fetched. */
export function gitRead(repo, name) {
  if (!repo || !/^[\w.-]+$/u.test(name)) return null
  const ref = `refs/heartbeats/${name}`
  if (git(repo, ["fetch", "-q", "origin", `+${ref}:${ref}`]).status !== 0) return null
  const out = git(repo, ["cat-file", "-p", ref])
  return out.status === 0 ? out.stdout : null
}

/** Reads a peer's heartbeat over ssh with no prompt; null when it cannot be read. */
function sshRead(peer, name) {
  if (!/^[\w.@-]+$/u.test(peer.ssh ?? "") || !/^[\w.-]+$/u.test(name)) return null
  const run = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", peer.ssh, `cat "\${XDG_STATE_HOME:-$HOME/.local/state}/ouroboros-skills/desk/heartbeats/${name}.json"`], { encoding: "utf8", timeout: 20_000, windowsHide: true })
  return run.status === 0 ? run.stdout : null
}

/** A peer is silent when its heartbeat is missing, unreadable, older than half an hour or from the future. */
export function peerFindings({ peers = [], now, read = (peer, name) => (peer.ssh ? sshRead(peer, name) : null) }) {
  const out = []
  for (const peer of peers) {
    let at = NaN
    try { at = Date.parse(JSON.parse(read(peer, peer.host) ?? "null")?.at) } catch { /* silent */ }
    if (!Number.isFinite(at) || at > now || now - at >= PEER_QUIET_MS) out.push({ kind: "peer_silent", card: null, why: `the keeper on ${peer.host} has not shown a heartbeat in ${Math.round(PEER_QUIET_MS / 60_000)} minutes` })
  }
  return out
}

/** `keepers.json`: `{ "host": "<this host's name>", "repo": "<clone whose origin both hosts push to>", "peers": [{ "host": "<name>" }] }`; a peer with an `ssh` alias is read over ssh instead. */
export function readKeeperConfig(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    const peers = Array.isArray(raw.peers) ? raw.peers.filter((p) => typeof p?.host === "string") : []
    return { host: typeof raw.host === "string" && /^[\w.-]+$/u.test(raw.host) ? raw.host : null, repo: typeof raw.repo === "string" ? raw.repo : null, peers }
  } catch (error) {
    if (error?.code === "ENOENT") return { host: null, repo: null, peers: [] }
    throw { keepersConfigInvalid: error.message } // an unreadable config must not read as "no peers", which would switch off the peer check
  }
}

/** One keeper run: show this host's heartbeat, then list what needs a job. Idempotent, so a rerun reports the same findings until someone acts. */
export async function keepersCheck({ config, heartbeatDir, endings, leases, now, read: readSsh }) {
  const host = config.host
  if (host !== null) beat({ dir: heartbeatDir, host, now })
  const shared = host !== null && config.repo ? publish({ repo: config.repo, host, now }) : null
  const read = readSsh ?? ((peer, name) => (peer.ssh ? sshRead(peer, name) : gitRead(config.repo, name)))
  const all = [...findings({ endings, leases, now }), ...peerFindings({ peers: config.peers, now, read })]
  return { host, findings: all, status: [host === null ? "this host has no name in keepers.json, so its heartbeat is not shown and its peer cannot check it" : `${host}: heartbeat shown${shared === false ? " locally only; publishing to the shared repo failed" : ""}`, `${all.length} finding${all.length === 1 ? "" : "s"}`, ...all.map((f) => `${f.kind}${f.card ? ` ${f.card}` : ""}: ${f.why}`)] }
}
