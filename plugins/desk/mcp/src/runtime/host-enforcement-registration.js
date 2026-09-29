// Desk-only enforcement is only as good as its own registration: if
// `hooks.json` ever ships without the `host-enforcement.cjs` entry (a bad
// merge, a packaging regression), the five denied surfaces silently stop
// being denied. Spec §5: "the 'plugin hooks not wired' gap is closed instead
// by `desk_status` and the boot checks verifying that the enforcement hook is
// registered for the current host, and reporting a missing registration
// through the failure contract as a `Desk problem:` block."
//
// The failure contract's real filer (Part 4 of this task's plan) has not
// merged yet -- this PR ships ahead of it, independently, per spec §8.7's own
// "independent of Parts 1-6" sequencing note. `fileHookRegistrationProblem`
// below is the single function Part 4's PR swaps for a call into the real
// filer; until then it returns the honest `not filed: filer_unavailable`
// rather than pretending to file anything.

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

/**
 * The swappable filing step (see header): Part 4's real Desk-problem filer
 * is not merged yet, so this stub always reports the honest
 * `not filed: filer_unavailable` rather than filing anything. Callers pass a
 * different `fileProblem` (matching this same `() -> Promise<{ file }>`
 * shape) once a real filer exists; `hookRegistrationDeskProblem` below is the
 * only caller, so swapping this one function is enough.
 */
export async function fileHookRegistrationProblem() {
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
 * `{ host, pluginRoot, readFile?, fileProblem? }` -> `{ registered, block }`.
 * `registered` is `null` (nothing to report) when the host isn't checked at
 * all, `true` with a `null` block when the hook is registered, and `false`
 * with a full `Desk problem:` block when it is not -- never blocking,
 * never throwing; a caller (the boot check, `desk_status`) shows the block
 * as-is.
 */
export async function hookRegistrationDeskProblem({ host, pluginRoot, readFile, fileProblem = fileHookRegistrationProblem } = {}) {
  const result = await verifyHookRegistered({ host, pluginRoot, readFile })
  if (!result.applicable) return { registered: null, block: null }
  if (result.registered) return { registered: true, block: null }
  const { file } = await fileProblem()
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
