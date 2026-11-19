// Files one failure of a tool Ari's agents own as an issue on that tool's repo, where its issue drain picks it up.
// `friction_add` with `about: "system"` and `plugin: <tool>` calls this for every owned tool but Desk (Desk's own
// friction keeps its kaizen and desk-problem routes). The repos are public and the issue is a defect report with
// evidence, so the text is held to the kaizen filer's scrub (`isGeneric`): a title or body with a credential, a home
// path or an email address is `not_filed: not_generic`, with the paste-ready text to file by hand.
//
// Once only: the issue is labelled `tool-friction` and carries a fingerprint marker (a hash of the tool and the normalized title), and the repo's
// issues, open or closed, are read for it first; a match is `known` with its URL. Account: `chooseAccount`'s own pick
// (never a managed login, never one that cannot see the repo). At most `MAX_PER_DAY` issues per repo from this machine
// in 24 hours; past it the result is `held_cap`.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { createHash } from "node:crypto"

import { chooseAccount, ghRunner } from "./flush.js"
import { isGeneric, normalizeTitle } from "./kaizen-file.js"
import { readStatus, withNamedLock, writeStatus } from "./outbox.js"
import { issuesClient } from "./store-issues.js"

// Every tool owned in `ourostack`, by the name an agent knows it by, with the repo its issue drain reads.
export const OWNED_TOOLS = Object.freeze({
  m365crawl: "ourostack/m365crawl",
  shepherd: "ourostack/shepherd",
  housesitter: "ourostack/housesitter",
  hackamore: "ourostack/hackamore",
  ouroboros: "ourostack/ouroboros",
  desk: "ourostack/desk",
})
export const MAX_PER_DAY = 5
const LABEL = "tool-friction"
const MARKER_PREFIX = "<!-- desk-tool-issue: "
const MAX_TITLE = 120
const MAX_BODY = 8000
const DAY_MS = 24 * 60 * 60 * 1000

/** `isOwnedTool(name) -> boolean`: whether `name` is a tool owned in ourostack. */
export const isOwnedTool = (name) => typeof name === "string" && Object.hasOwn(OWNED_TOOLS, name)

/** `toolIssueFingerprint(tool, title) -> string`: the 32 hex the issue's marker carries. */
export const toolIssueFingerprint = (tool, title) => createHash("sha256").update(`${tool}\n${normalizeTitle(title)}`).digest("hex").slice(0, 32)

async function recentFilings(env, repo, at) {
  const filed = (await readStatus(env)).tool_issue_filed ?? {}
  const times = Array.isArray(filed[repo]) ? filed[repo].filter((time) => typeof time === "string" && at - Date.parse(time) < DAY_MS) : []
  return { filed, times }
}

/**
 * `fileToolIssue(env, { tool, title, body, runner, now }) -> { result, repo?, url?, body? }`. `result` is `filed`, `known`
 * (both with `url`), `held_cap`, or `not_filed` with `reason` (`unknown_tool`, `invalid_title`, `invalid_body`,
 * `not_generic`, `no_suitable_account`, or the issues client's code) and, once the text is valid, a paste-ready `body`.
 * Never throws for a filing failure.
 */
export async function fileToolIssue(env, { tool, title, body, runner = ghRunner({ env }), now = Date.now }) {
  if (!isOwnedTool(tool)) return { result: "not_filed", reason: "unknown_tool" }
  const repo = OWNED_TOOLS[tool]
  if (typeof title !== "string" || title.trim() === "" || /[\r\n]/u.test(title) || title.length > MAX_TITLE) return { result: "not_filed", reason: "invalid_title", repo }
  if (typeof body !== "string" || body.trim() === "" || body.length > MAX_BODY) return { result: "not_filed", reason: "invalid_body", repo }
  const fingerprint = toolIssueFingerprint(tool, title)
  const marker = `${MARKER_PREFIX}${fingerprint} -->`
  const text = `${body.trimEnd()}\n\n${marker}\n`
  const pasteReady = `${title.trim()}\n\n${text}`
  if (!isGeneric(title) || !isGeneric(body)) return { result: "not_filed", reason: "not_generic", repo, body: pasteReady }
  const chosen = await chooseAccount({ store: repo, runner, now })
  if (chosen.result !== "account_found") return { result: "not_filed", reason: "no_suitable_account", repo, body: pasteReady }
  try {
    const auth = await runner(["auth", "token", "--user", chosen.account])
    const token = auth.code === 0 ? String(auth.stdout ?? "").trim() : ""
    if (token === "") return { result: "not_filed", reason: "no_suitable_account", repo, body: pasteReady }
    return await withNamedLock(env, `tool-issue-${tool}`, async () => {
      const client = issuesClient({ runner, repo, token })
      const existing = (await client.listIssues({ label: LABEL, state: "all" })).find((issue) => !issue.pull_request && issue.body.includes(marker))
      if (existing !== undefined) return { result: "known", repo, url: existing.url }
      const at = now()
      const { filed, times } = await recentFilings(env, repo, at)
      if (times.length >= MAX_PER_DAY) return { result: "held_cap", repo, body: pasteReady }
      const { url } = await client.createIssue({ title: title.trim(), body: text, labels: ["bug", LABEL] })
      await writeStatus(env, { tool_issue_filed: { ...filed, [repo]: [...times, new Date(at).toISOString()] } })
      return { result: "filed", repo, url }
    })
  } catch (error) {
    if (typeof error.code === "string") return { result: "not_filed", reason: error.code, repo, body: pasteReady }
    throw error
  }
}
