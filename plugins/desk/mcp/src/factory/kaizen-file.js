// Filing a kaizen card: turns one piece of system friction into an open
// issue labeled `kaizen` in the desk's factory store, so the store's build
// checks it once a countermeasure ships (`pipeline/kaizen.js`).
//
// The store is the one the desk's facts go to (`resolveStore`), and the card
// is filed only with that store's recorded consent, as its recorded account,
// through `gh` with the token passed as `GH_TOKEN` (`store-issues.js`). A
// card is public, so its title and text must be generic: anything
// credential-shaped, a home or drive path, or an email address is refused
// before any network call, and the caller keeps the friction locally.
//
// The card block is generated here, never taken from the caller: `signal`
// and `hypothesis` are filled when the signal is known (the hypothesis moves
// the signal down, or up for `flow_efficiency`), `job_class` is `any`,
// `plugin` is `desk` and `version` stays `null` until the countermeasure
// ships. Without a signal the card is a draft; the kaizen check lists the
// missing fields until the kaizen worker completes it.
//
// `fileKaizenCard` resolves `{ result: "filed", store, url }`, or `{ result:
// <code> }` with a stable code and, once the store is known, `store`:
// `invalid_title`, `invalid_body`, `invalid_signal`, `invalid_evidence_jobs`,
// `not_generic`, `store_invalid`, `not_opted_in`, `no_account`,
// `auth_failed`, or the issues client's `gh_missing`, `timeout`,
// `http_<status>`, `unexpected_answer`, `gh_failed`.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import * as path from "node:path"

import { isCredentialLike } from "./credential.js"
import { ghRunner } from "./flush.js"
import { readConsent } from "./outbox.js"
import { KAIZEN_LABEL } from "./pipeline/kaizen.js"
import { MEASURE_IDS } from "./pipeline/rollups.js"
import { PATTERNS } from "./schema.js"
import { issuesClient } from "./store-issues.js"
import { resolveStore } from "./store-route.js"

const MAX_TITLE = 120
const MAX_BODY = 8000
const MAX_EVIDENCE_JOBS = 100
const HIGHER_IS_BETTER = new Set(["flow_efficiency"])
const PRIVATE_TEXT = [
  /(^|[\s("'`])~[\\/]/u,
  /\/(Users|home)\//u,
  /[A-Za-z]:\\/u,
  /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/u,
]

const isGeneric = (text) => !isCredentialLike(text) && !text.split(/\s+/u).some(isCredentialLike) && !PRIVATE_TEXT.some((pattern) => pattern.test(text))

/** `cardBody({ body, signal, evidenceJobs }) -> string`: the issue body, the caller's text followed by the generated card block. */
export function cardBody({ body, signal, evidenceJobs }) {
  const lines = [
    "kaizen: 1",
    `signal: ${signal ?? "null"}`,
    "job_class: any",
    `evidence_jobs: [${evidenceJobs.join(", ")}]`,
    "countermeasure: null",
    "plugin: desk",
    "version: null",
    `hypothesis: ${signal === null ? "null" : `{ measure: ${signal}, direction: ${HIGHER_IS_BETTER.has(signal) ? "up" : "down"} }`}`,
  ]
  return `${body}\n\n\`\`\`yaml\n${lines.join("\n")}\n\`\`\`\n`
}

function invalidInput({ title, body, signal, evidenceJobs }) {
  if (typeof title !== "string" || title.trim() === "" || /[\r\n]/u.test(title) || title.length > MAX_TITLE) return "invalid_title"
  if (typeof body !== "string" || body.length > MAX_BODY || body.includes("```")) return "invalid_body"
  if (signal !== null && !MEASURE_IDS.includes(signal)) return "invalid_signal"
  if (!Array.isArray(evidenceJobs) || evidenceJobs.length > MAX_EVIDENCE_JOBS || !evidenceJobs.every((job) => typeof job === "string" && PATTERNS.jobId.test(job))) return "invalid_evidence_jobs"
  if (!isGeneric(title) || !isGeneric(body)) return "not_generic"
  return null
}

/**
 * `fileKaizenCard(env, { deskRoot, title, body, signal, evidenceJobs,
 * runner, pluginDirs }) -> { result, store?, url? }`: files the card in the
 * desk's store; see the header for the result codes.
 */
export async function fileKaizenCard(env, { deskRoot, title, body, signal = null, evidenceJobs = [], runner = ghRunner({ env }), pluginDirs = [] }) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("fileKaizenCard: deskRoot must be an absolute path")
  const invalid = invalidInput({ title, body, signal, evidenceJobs })
  if (invalid !== null) return { result: invalid }
  const { store } = resolveStore({ deskRoot, pluginDirs })
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
    const { url } = await client.createIssue({ title: title.trim(), body: cardBody({ body, signal, evidenceJobs }), labels: [KAIZEN_LABEL] })
    return { result: "filed", store, url }
  } catch (error) {
    if (typeof error.code === "string") return { result: error.code, store }
    throw error
  }
}
