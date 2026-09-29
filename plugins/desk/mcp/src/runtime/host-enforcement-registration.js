// Desk-only enforcement is only as good as its own registration: if
// `hooks.json` ever ships without the `host-enforcement.cjs` entry (a bad
// merge, a packaging regression), the five denied surfaces silently stop
// being denied. Spec §5: "the 'plugin hooks not wired' gap is closed instead
// by `desk_status` and the boot checks verifying that the enforcement hook is
// registered for the current host, and reporting a missing registration
// through the failure contract as a `Desk problem:` block."
//
// This module only verifies registration and formats the block; it never
// files by itself. Filing a real `Desk problem:` (through
// `factory/desk-problem-file.js`, Part 4) means an account lookup and `gh`
// calls that can run for tens of seconds on a slow network, and neither of
// this module's two callers may pay that cost inline: `desk_status` must
// answer with no network call at all (a fix round after this Part first
// shipped found the SessionStart hook losing its whole output past a 10 s
// timeout, and `desk_status` hanging on every call, because the real filer
// was reached straight from both). So `hookRegistrationDeskProblem`'s
// `fileProblem` has no filing default: given none, the block renders
// honestly with `file: not filed: filer_unavailable`, and each real caller
// supplies its own deliberate, differently-shaped step --
// boot-checks.cjs's `hostEnforcementCheck` queues a detached, unref'd run of
// `mcp/scripts/file-desk-problem.js` (the same repair-launch pattern it
// already uses) and reports `file: filing in background`; `status.js`'s
// `hostEnforcementStatus` reports `file: filed at session start` with no
// filing step of its own, since the boot check already covers it once per
// session.

import { readFile as fsReadFile } from "node:fs/promises"
import * as path from "node:path"

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

/** The honest, no-op filing step: never called with `env` missing, since neither real caller needs it to resolve anything -- see the header. */
async function noFiler() {
  return { file: "not filed: filer_unavailable" }
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
 * the block as-is. `fileProblem` has no filing default (see the header):
 * without one, the block still renders, with `file: not filed:
 * filer_unavailable`; each real caller supplies its own.
 */
export async function hookRegistrationDeskProblem({
  host, pluginRoot, readFile, env, fileProblem = noFiler,
} = {}) {
  const result = await verifyHookRegistered({ host, pluginRoot, readFile })
  if (!result.applicable) return { registered: null, block: null }
  if (result.registered) return { registered: true, block: null }
  const { file } = await fileProblem({ env, host, reason: result.reason })
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
