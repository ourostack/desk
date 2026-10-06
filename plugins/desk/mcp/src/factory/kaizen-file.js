// Filing a kaizen card: turns one piece of system friction, after the
// curator's signoff, into an open issue labeled `kaizen` in the desk's
// factory store, so the store's build checks it once a countermeasure ships
// (`pipeline/kaizen.js`).
//
// Route. The card goes to the store the desk's facts go to, resolved the
// same way (`derive-run.js`): the desk's own `_meta/factory.json` decides
// when it exists; otherwise the routing the session hooks recorded for this
// desk (which read the overlays' store declarations) decides. With neither,
// the route is unknown and nothing is filed: a work desk must never reach a
// public store because its overlay's declaration could not be read here.
//
// Public text. Free text never goes to a public store. The store's
// visibility is read from GitHub; unless GitHub says it is private, the
// card carries only structured fields: the plugin (a publicly distributed
// one, `PUBLIC_PLUGINS`), the friction class (`FRICTION_CLASSES`), the
// measure and the evidence jobs, in generated text. The caller's title and
// body stay on the desk, or go to a private store, where they are still
// checked for credential shapes, home and drive paths and email addresses,
// as defence in depth. Evidence jobs must have the job-ID shape,
// and for a public store must not be this machine's plain local job IDs
// (`jobs-index.json`), which public desks never publish.
//
// Once only. Each card carries a fingerprint, the first 32 hex of
// HMAC-SHA256(machine secret, plugin, class and normalized title), in an
// HTML comment. Before filing, the filer's open `kaizen` issues are read:
// a card with the same fingerprint is returned as `duplicate` with its URL,
// so a retry never files again. At most `MAX_CARDS_PER_DAY` cards go to one
// store in any 24 hours from this machine; the rest are `held_cap`. The
// card is filed with that store's recorded consent, as its recorded
// account, through `gh` with the token passed as `GH_TOKEN`
// (`store-issues.js`).
//
// The card block is generated here, never taken from the caller: `signal`
// and `hypothesis` are filled when the signal is known (the hypothesis moves
// the signal down, or up for `flow_efficiency`), `job_class` is `any`,
// `plugin` is the caller's, and `version` stays `null` until the
// countermeasure ships. Without a signal the card is a draft; the kaizen
// check lists the missing fields until the kaizen worker completes it.
//
// `fileKaizenCard` resolves `{ result: "filed" | "duplicate", store, url,
// visibility }`, or `{ result: <code> }` with a stable code and, once the
// store is known, `store`: `invalid_title`, `invalid_body`,
// `invalid_plugin`, `invalid_friction_class`, `invalid_signal`,
// `invalid_evidence_jobs`, `not_generic`, `route_unknown`, `store_invalid`,
// `not_opted_in`, `no_account`, `auth_failed`, `plugin_not_public`,
// `evidence_jobs_local`, `held_cap`, or the issues client's `gh_missing`,
// `timeout`, `http_<status>`, `unexpected_answer`, `too_many_issues`,
// `gh_failed`.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { createHmac } from "node:crypto"
import * as path from "node:path"

import { isCredentialLike } from "./credential.js"
import { ghRunner } from "./flush.js"
import { listMarkers, readConsent, readJobsIndex, readMachineSecret, readStatus, writeStatus } from "./outbox.js"
import { KAIZEN_LABEL } from "./pipeline/kaizen.js"
import { MEASURE_IDS } from "./pipeline/rollups.js"
import { PATTERNS } from "./schema.js"
import { markerRoute } from "./session-route.js"
import { issuesClient } from "./store-issues.js"
import { resolveStore } from "./store-route.js"

export const FRICTION_CLASSES = Object.freeze(["guard", "hook", "mcp_tool", "skill", "factory", "release", "ci", "docs", "other"])
// The plugins the public `ourostack` marketplace distributes; any other plugin's name stays off public stores.
export const PUBLIC_PLUGINS = Object.freeze(["crew", "desk", "plain-language", "superpowers"])
export const MAX_CARDS_PER_DAY = 5
export const FINGERPRINT_PREFIX = "<!-- desk-kaizen-fingerprint: "

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_TITLE = 120
const MAX_BODY = 8000
const MAX_EVIDENCE_JOBS = 100
const HIGHER_IS_BETTER = new Set(["flow_efficiency"])
// Exported so the Desk-problem filer (factory/desk-problem-template.js) can
// reuse this exact scrub instead of duplicating it -- the one deliberate
// departure spec.md's fingerprint design calls out is the fingerprint
// itself (no machine secret), not this credential/path/email defense.
export const PRIVATE_TEXT = [
  /(^|[\s("'`])~[\\/]/u,
  /\/(Users|home)\//u,
  /[A-Za-z]:\\/u,
  /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/u,
]

export const isGeneric = (text) => !isCredentialLike(text) && !text.split(/\s+/u).some(isCredentialLike) && !PRIVATE_TEXT.some((pattern) => pattern.test(text))

/** `normalizeTitle(title) -> string`: lower case, with runs of anything but letters and digits as one space; the fingerprint's form of a title. */
export function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

/** `cardBlock({ plugin, signal, evidenceJobs }) -> string`: the generated fenced card block the kaizen check parses. */
export function cardBlock({ plugin, signal, evidenceJobs }) {
  const lines = [
    "kaizen: 1",
    `signal: ${signal ?? "null"}`,
    "job_class: any",
    `evidence_jobs: [${evidenceJobs.join(", ")}]`,
    "countermeasure: null",
    `plugin: ${plugin}`,
    "version: null",
    `hypothesis: ${signal === null ? "null" : `{ measure: ${signal}, direction: ${HIGHER_IS_BETTER.has(signal) ? "up" : "down"} }`}`,
  ]
  return `\`\`\`yaml\n${lines.join("\n")}\n\`\`\`\n`
}

/**
 * `publicCard({ plugin, frictionClass, signal, evidenceJobs, fingerprint })
 * -> { title, body }`: the card a public store gets, made only of
 * structured fields.
 */
export function publicCard({ plugin, frictionClass, signal, evidenceJobs, fingerprint }) {
  return {
    title: `Kaizen: ${plugin} ${frictionClass} friction${signal === null ? "" : `, ${signal}`}`,
    body: [
      "System friction a Desk kaizen worker filed from a desk. A public card carries structured fields only; the description stays on the desk.",
      "",
      `- Plugin: \`${plugin}\``,
      `- Friction class: \`${frictionClass}\``,
      `- Measure: ${signal === null ? "not chosen yet" : `\`${signal}\``}`,
      "",
      `${FINGERPRINT_PREFIX}${fingerprint} -->`,
      "",
      cardBlock({ plugin, signal, evidenceJobs }),
    ].join("\n"),
  }
}

/** `privateCard({ title, body, plugin, signal, evidenceJobs, fingerprint }) -> { title, body }`: the card a private store gets, the caller's text followed by the fingerprint and the block. */
export function privateCard({ title, body, plugin, signal, evidenceJobs, fingerprint }) {
  return { title: title.trim(), body: `${body.trimEnd()}\n\n${FINGERPRINT_PREFIX}${fingerprint} -->\n\n${cardBlock({ plugin, signal, evidenceJobs })}` }
}

function invalidInput({ title, body, plugin, frictionClass, signal, evidenceJobs }) {
  if (typeof title !== "string" || title.trim() === "" || /[\r\n]/u.test(title) || title.length > MAX_TITLE) return "invalid_title"
  if (typeof body !== "string" || body.length > MAX_BODY || body.includes("```")) return "invalid_body"
  if (typeof plugin !== "string" || !PATTERNS.pluginName.test(plugin)) return "invalid_plugin"
  if (!FRICTION_CLASSES.includes(frictionClass)) return "invalid_friction_class"
  if (signal !== null && !MEASURE_IDS.includes(signal)) return "invalid_signal"
  if (!Array.isArray(evidenceJobs) || evidenceJobs.length > MAX_EVIDENCE_JOBS || !evidenceJobs.every((job) => typeof job === "string" && PATTERNS.jobId.test(job))) return "invalid_evidence_jobs"
  return null
}

// The facts route for this desk: its own declaration, else the newest
// routing a session hook recorded for it, else nothing.
async function route(env, deskRoot) {
  const current = resolveStore({ deskRoot })
  if (current.source !== "default") return current.store
  const recorded = (await listMarkers(env))
    .filter((marker) => marker.host !== "codex-cli" && marker.desk_root !== null && path.resolve(marker.desk_root) === path.resolve(deskRoot) && marker.routing !== undefined)
    .sort((left, right) => (left.updated_at < right.updated_at ? 1 : left.updated_at > right.updated_at ? -1 : 0))
  // Read as every marker reader reads it (`markerRoute`): a route recorded while a plugin manifest was unreadable is held.
  return recorded.length === 0 ? undefined : markerRoute(recorded[0]).store
}

/**
 * `fingerprintOf(env, { plugin, frictionClass, title }) -> Promise<string>`: the 32 hex the filer embeds in a card's
 * marker (an HMAC under this machine's secret of the plugin, the class and the normalized title). Rejects when the
 * factory state cannot give the secret.
 */
export async function fingerprintOf(env, { plugin, frictionClass, title }) {
  const secret = await readMachineSecret(env)
  return createHmac("sha256", secret).update(`${plugin}\n${frictionClass}\n${normalizeTitle(title)}`).digest("hex").slice(0, 32)
}

async function recentFilings(env, store, now) {
  const filed = (await readStatus(env)).kaizen_filed ?? {}
  const times = Array.isArray(filed[store]) ? filed[store].filter((at) => typeof at === "string" && now - Date.parse(at) < DAY_MS) : []
  return { filed, times }
}

/**
 * `fileKaizenCard(env, { deskRoot, title, body, plugin, frictionClass,
 * signal, evidenceJobs, runner, now }) -> { result, store?, url?,
 * visibility? }`: files the card in the desk's store; see the header for the
 * result codes.
 */
export async function fileKaizenCard(env, { deskRoot, title, body, plugin = "desk", frictionClass = "other", signal = null, evidenceJobs = [], runner = ghRunner({ env }), now = Date.now }) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("fileKaizenCard: deskRoot must be an absolute path")
  const invalid = invalidInput({ title, body, plugin, frictionClass, signal, evidenceJobs })
  if (invalid !== null) return { result: invalid }
  const store = await route(env, deskRoot)
  if (store === undefined) return { result: "route_unknown" }
  if (store === null) return { result: "store_invalid" }
  const consent = (await readConsent(env)).stores[store]
  if (consent?.contribute !== true) return { result: "not_opted_in", store }
  if (typeof consent.account !== "string") return { result: "no_account", store }
  const auth = await runner(["auth", "token", "--user", consent.account])
  if (auth.spawnError === "ENOENT") return { result: "gh_missing", store }
  const token = auth.code === 0 ? String(auth.stdout ?? "").trim() : ""
  if (token === "") return { result: "auth_failed", store }
  try {
    const client = issuesClient({ runner, repo: store, token })
    const visibility = await client.visibility()
    const open = visibility !== "private"
    if (open && !PUBLIC_PLUGINS.includes(plugin)) return { result: "plugin_not_public", store }
    if (open) {
      const local = await readJobsIndex(env)
      if (evidenceJobs.some((job) => Object.hasOwn(local, job))) return { result: "evidence_jobs_local", store }
    }
    const fingerprint = await fingerprintOf(env, { plugin, frictionClass, title })
    const card = open ? publicCard({ plugin, frictionClass, signal, evidenceJobs, fingerprint }) : privateCard({ title, body, plugin, signal, evidenceJobs, fingerprint })
    if (!isGeneric(card.title) || (!open && !isGeneric(body))) return { result: "not_generic", store }
    const marker = `${FINGERPRINT_PREFIX}${fingerprint} -->`
    const existing = (await client.listIssues({ label: KAIZEN_LABEL, state: "open" })).find((issue) => !issue.pull_request && issue.author === consent.account && issue.body.includes(marker))
    if (existing !== undefined) return { result: "duplicate", store, url: existing.url, visibility }
    const at = now()
    const { filed, times } = await recentFilings(env, store, at)
    if (times.length >= MAX_CARDS_PER_DAY) return { result: "held_cap", store }
    const { url } = await client.createIssue({ title: card.title, body: card.body, labels: [KAIZEN_LABEL] })
    await writeStatus(env, { kaizen_filed: { ...filed, [store]: [...times, new Date(at).toISOString()] } })
    return { result: "filed", store, url, visibility }
  } catch (error) {
    if (typeof error.code === "string") return { result: error.code, store }
    throw error
  }
}
export { route as storeFor }
