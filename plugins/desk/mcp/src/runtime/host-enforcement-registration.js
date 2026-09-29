// Desk-only enforcement is only as good as its own registration: if
// `hooks.json` ever ships without the `host-enforcement.cjs` entry (a bad
// merge, a packaging regression), the five denied surfaces silently stop
// being denied. Spec §5: "the 'plugin hooks not wired' gap is closed instead
// by `desk_status` and the boot checks verifying that the enforcement hook is
// registered for the current host, and reporting a missing registration
// through the failure contract as a `Desk problem:` block."
//
// `fileHookRegistrationProblem` below is the single function that files
// through the real Desk-problem filer (`factory/desk-problem-file.js`, Part
// 4) -- the swappable seam a caller (or a test) can still replace via
// `hookRegistrationDeskProblem`'s own `fileProblem` parameter. With no `env`
// to resolve an account or a `gh` binary from, there is nothing to file with,
// so it reports the honest `not filed: filer_unavailable` rather than ever
// reaching for a real, unmocked `gh` process.

import { readFile as fsReadFile } from "node:fs/promises"
import * as path from "node:path"

import { fileDeskProblem } from "../factory/desk-problem-file.js"

const HOOK_ENTRY_FILENAME = "host-enforcement.cjs"

async function defaultReadFile(file) {
  return fsReadFile(file, "utf8")
}

function registeredInClaudeHooks(hooksJson) {
  const entries = hooksJson?.hooks?.PreToolUse
  if (!Array.isArray(entries)) return false
  return entries.some((entry) => Array.isArray(entry?.hooks)
    && entry.hooks.some((hook) => typeof hook?.command === "string" && hook.command.includes(HOOK_ENTRY_FILENAME)))
}

/**
 * `{ host, pluginRoot, readFile? }` -> `{ applicable, registered, reason? }`.
 * `applicable` is false for any host but `claude` today -- Codex/Copilot get
 * their own registration wiring in Part 8, and this function claims nothing
 * about a host it cannot check. For `claude`, reads the installed plugin's
 * own `hooks.json` and confirms `host-enforcement.cjs` is registered under
 * `PreToolUse`; any read or parse failure is reported the same as "not
 * registered," never thrown.
 */
export async function verifyHookRegistered({ host, pluginRoot, readFile = defaultReadFile }) {
  if (host !== "claude") return { applicable: false, registered: null }
  const file = path.join(pluginRoot, "hooks", "hooks.json")
  try {
    const hooksJson = JSON.parse(await readFile(file))
    if (registeredInClaudeHooks(hooksJson)) return { applicable: true, registered: true }
    return { applicable: true, registered: false, reason: `${HOOK_ENTRY_FILENAME} missing from hooks.json's PreToolUse array` }
  } catch (error) {
    return { applicable: true, registered: false, reason: `hooks.json unreadable (${error.code ?? error.message})` }
  }
}

/**
 * The default filing step (see header): `{ env, host, reason, runner?, now?
 * }` -> `Promise<{ file }>`. Files through the real `fileDeskProblem`, mapped
 * to the block format's three `file:` shapes (spec §1) -- `<url> (filed)`,
 * `known: <url>`, or `not filed: <reason>` (`held_cap` included). With no
 * `env`, there is no account or `gh` binary to resolve, so nothing is
 * attempted: `not filed: filer_unavailable`, exactly as before this was
 * wired to a real filer. `hookRegistrationDeskProblem` below is the only
 * caller, and its own `fileProblem` parameter is still how a test (or a
 * future caller) swaps this default for something else.
 */
export async function fileHookRegistrationProblem({ env, host, reason, runner, now } = {}) {
  if (env === undefined || env === null) return { file: "not filed: filer_unavailable" }
  const result = await fileDeskProblem(env, {
    mechanism: "host-enforcement",
    rawText: reason ?? "host-enforcement.cjs missing from hooks.json's PreToolUse array",
    fixAttempt: "not auto-repaired -- reinstall Desk to restore it.",
    host,
    runner,
    now,
  })
  if (result.result === "filed") return { file: `${result.url} (filed)` }
  if (result.result === "known") return { file: `known: ${result.url}` }
  if (result.result === "held_cap") return { file: "not filed: held_cap" }
  return { file: `not filed: ${result.reason}` }
}

/**
 * The five-field `Desk problem:` block (spec §1's "The block format"), in
 * field order. `symptom` is the short header phrase; `broke` carries the raw
 * signal, which may be longer -- boot-checks.cjs's own pipeline caps every
 * check's line at 480 characters (`oneLine`), so every field here stays
 * short and bounded rather than embedding variable-length detail such as a
 * full filesystem path.
 */
function formatDeskProblemBlock({ mechanism, symptom, broke, means, fix, file, tell }) {
  return `Desk problem: ${mechanism} — ${symptom}\n`
    + `  broke: ${broke}\n`
    + `  means: ${means}\n`
    + `  fix: ${fix}\n`
    + `  file: ${file}\n`
    + `  tell: ${tell}`
}

/**
 * `{ host, pluginRoot, readFile?, env?, fileProblem? }` -> `{ registered,
 * block }`. `registered` is `null` (nothing to report) when the host isn't
 * checked at all, `true` with a `null` block when the hook is registered,
 * and `false` with a full `Desk problem:` block when it is not -- never
 * blocking, never throwing; a caller (the boot check, `desk_status`) shows
 * the block as-is. `env` (and, for tests, `runner`/`now`) reach the default
 * filing step; with no `env` the block still renders, with
 * `file: not filed: filer_unavailable`.
 */
export async function hookRegistrationDeskProblem({
  host, pluginRoot, readFile, env, runner, now, fileProblem = fileHookRegistrationProblem,
} = {}) {
  const result = await verifyHookRegistered({ host, pluginRoot, readFile })
  if (!result.applicable) return { registered: null, block: null }
  if (result.registered) return { registered: true, block: null }
  const { file } = await fileProblem({ env, host, reason: result.reason, runner, now })
  const block = formatDeskProblemBlock({
    mechanism: "host-enforcement",
    symptom: "deny hook not registered",
    broke: result.reason,
    means: "the 5 denied surfaces aren't blocked this session.",
    fix: "not auto-repaired -- reinstall Desk to restore it.",
    file,
    tell: "Desk's enforcement hook isn't registered, so ask-user/plan-mode/Artifacts/etc. aren't denied right now. Reinstalling Desk should fix it.",
  })
  return { registered: false, block }
}
