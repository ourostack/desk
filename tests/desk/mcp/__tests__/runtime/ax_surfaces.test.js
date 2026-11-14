// Desk's agent-facing words held to Ouro AX by its surface checker: errors lead with their fix and carry a code,
// tool descriptions say when to use the tool and stay short, and nothing sends an agent to run a script.
// A finding is recorded in ax-surfaces-baseline.json, counted per check and file; a new one fails, and so does a recorded one that is fixed.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { checkSurfaces, countFindings, extractSurfaces, ratchet, surfacesText } from "../../../../../plugins/desk/mcp/src/lib/ouro-ui/registry/ouro/ax/surfaces.ts"
import { TOOL_DESCRIPTIONS } from "../../../../../plugins/desk/mcp/src/tool-names.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../../../../..")
const baselinePath = path.join(here, "ax-surfaces-baseline.json")

// Strings the extractor reads as errors that are not: they stay in the manifest as texts, which are still checked for
// scripts, but are not held to "lead with the fix". A carrier wraps a message whose call sites are checked themselves.
const NOT_ERRORS = {
  "plugins/desk/mcp/src/runtime/agency-desk-channel.js#usage-run-it-with-detect": "a command-line usage line: the exit status is its code",
  "plugins/desk/mcp/src/runtime/pending-migrations.js#migrations-js-install-bash-first": "a command-line usage line: the exit status is its code",
  "plugins/desk/mcp/src/runtime/pending-migrations.js#migrations-js-name-a-migration": "a command-line usage line: the exit status is its code",
  "plugins/desk/mcp/src/runtime/session-sync.js#session-sync-js-pass-root": "a command-line usage line: the exit status is its code",
  "plugins/desk/mcp/src/runtime/deliver.js#fix-desk-publication-json-through": "a result whose `reason` is its stable code",
  "plugins/desk/mcp/src/runtime/state-branch.js#run-it-again-head-moved": "a result whose `reason` is its stable code",
  "plugins/desk/mcp/src/runtime/deliver.js#check-the-replay-worktree-s": "an internal result the caller records as the replay_failed reason",
  "plugins/desk/mcp/src/runtime/desk-session.js#start-the-session-from-the": "its code is the exported DESK_ROOT_UNAVAILABLE constant callers compare with; renaming it would change behavior",
  "plugins/desk/mcp/src/runtime/diagnostics.js#then-call-desk-status-desk": "remediation text on a diagnostic record whose `code` names it",
  "plugins/desk/mcp/src/runtime/diagnostics.js#start-a-new-session-once": "remediation text on a diagnostic record whose `code` names it",
  "plugins/desk/mcp/src/runtime/diagnostics.js#run-desk-first-run-bootstrap": "remediation text on a diagnostic record whose `code` names it",
  "plugins/desk/mcp/src/runtime/diagnostics.js#run-now-the-active-overlay": "remediation text on a diagnostic record whose `code` names it",
  "plugins/desk/mcp/src/runtime/diagnostics.js#check-write-permissions-and-free": "remediation text on a diagnostic record whose `code` names it",
  "plugins/desk/mcp/src/runtime/diagnostics.js#refresh-or-reinstall-desk-from": "remediation text on a diagnostic record whose `code` names it",
  "plugins/desk/mcp/src/tools/task-archived-resource.js#task-update-pass-only-resource": "carrier: each call site passes its own code",
  // Tool replies that report an outcome, with their stable status beside them, not failures.
  "plugins/desk/mcp/src/tools/lesson-team.js#in-effect-merged-in-from": "a status reply, not a failure",
  "plugins/desk/mcp/src/tools/lesson-team.js#wait-for-the-pull-request": "a status reply, not a failure",
  "plugins/desk/mcp/src/tools/lesson-team.js#already-in-effect-the-default": "a status reply, not a failure",
  "plugins/desk/mcp/src/tools/lesson-team.js#fix-what-the-parentheses-name": "a status reply, not a failure",
  "plugins/desk/mcp/src/tools/move.js#track-rename": "a progress line the tool reports",
  "plugins/desk/mcp/src/tools/move.js#task-move": "a progress line the tool reports",
  "plugins/desk/mcp/src/tools/note.js#leave-it-as-it-is": "a status reply, not a failure",
  "plugins/desk/mcp/src/tools/note.js#left-for-merged-in-s": "a status reply, not a failure",
  "plugins/desk/mcp/src/tools/note.js#wait-for-the-pull-request": "a status reply, not a failure",
  "plugins/desk/mcp/src/tools/note.js#leave-a-different-note-if": "a status reply, not a failure",
  "plugins/desk/mcp/src/tools/note.js#fix-what-the-parentheses-name": "a status reply, not a failure",
  "plugins/desk/mcp/src/tools/status.js#desk-search-is-starting": "a status reply, not a failure",
  // Runtime texts that are labels, log lines or mimics of another program's message, not errors an agent reads.
  "plugins/desk/mcp/src/runtime/front-door.js#method-not-found": "the JSON-RPC protocol's own method-not-found reply",
  "plugins/desk/mcp/src/runtime/git-inspection.js#command-failed-killed-by": "mirrors the message Node gives for a killed or aborted process",
  "plugins/desk/mcp/src/runtime/git-inspection.js#command-failed-with-exit-code": "mirrors the message Node gives for a killed or aborted process",
  "plugins/desk/mcp/src/runtime/git-inspection.js#the-operation-was-aborted": "mirrors the message Node gives for a killed or aborted process",
  "plugins/desk/mcp/src/runtime/git-inspection.js#the-operation-was-aborted~2": "mirrors the message Node gives for a killed or aborted process",
  "plugins/desk/mcp/src/runtime/lfs.js#not-a-directory": "an internal label caught by its caller",
  "plugins/desk/mcp/src/runtime/newest-release.js#the-archive-is-damaged": "an internal label caught by its caller",
  "plugins/desk/mcp/src/runtime/newest-release.js#the-download-is-not-a": "an internal label caught by its caller",
  "plugins/desk/mcp/src/runtime/newest-release.js#the-release-download-is-too": "an internal label caught by its caller",
  "plugins/desk/mcp/src/runtime/newest-release.js#the-release-is-larger-than": "an internal label caught by its caller",
  "plugins/desk/mcp/src/runtime/session-retention.js#session-retention": "carrier of an argument error whose texts are checked themselves",
  "plugins/desk/mcp/src/runtime/session-retention.js#session-retention-failed": "a stack trace written to the log",
  "plugins/desk/mcp/src/runtime/sync-worker.js#desk-mcp-sync-status-desk": "a log line",
  "plugins/desk/mcp/src/runtime/sync-worker.js#desk-sync-worker-refused-the": "a log line",
  "plugins/desk/mcp/src/runtime/unsaved-work.js#invalid-index-entry": "an internal label caught by its caller",
  "plugins/desk/mcp/src/runtime/unsaved-work.js#invalid-index-path": "an internal label caught by its caller",
  "plugins/desk/mcp/src/runtime/unsaved-work.js#invalid-index-stat": "an internal label caught by its caller",
  "plugins/desk/mcp/src/runtime/unsaved-work.js#invalid-worktree-head": "an internal label caught by its caller",
  "plugins/desk/mcp/src/runtime/unsaved-work.js#staged-comparison-unavailable": "an internal label caught by its caller",
  "plugins/desk/mcp/src/runtime/unsaved-work.js#untracked-inventory-unavailable": "an internal label caught by its caller",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#ambiguous-delivery-push-endpoints": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#delivery-endpoint-missing-or-changed": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#delivery-is-not-on-recorded": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#delivery-query-endpoint-changed-by": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#delivery-reference-unverified": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#exact-ownership-mismatch": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#exact-ownership-receipt-missing-or": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#git-operation-in-progress": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#index-flags-prevent-reliable-tracked": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#intentionally-retained-worktree": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#invalid-delivery-endpoint": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#live-or-unobservable-consumer": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#live-or-unobservable-writer": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#local-commits-not-preserved-at": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#local-commits-or-head-changed": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#missing-or-bare-worktree": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#ownership-changed-during-repair": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#remote-branch-exists-or-is": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#remote-ownership-unverified": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#task-ownership-changed": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#tracked-changes-or-untracked-files": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#unmerged-branch-remote-deletion-unverified": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#unsupported-or-credential-bearing-delivery": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#worktree-absence-unverified": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#worktree-identity-changed": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#worktree-identity-is-symlinked": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#worktree-ownership-unverified": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#worktree-registration-changed": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#worktree-removal-refused": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#writer-generation-unverified": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#writer-generations-missing": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#writer-liveness-unobservable": "a reason label the tidy report carries",
  "plugins/desk/mcp/src/runtime/workspace-tidy.js#writer-release-unverified": "a reason label the tidy report carries",
  // Crew's replies that report an outcome other than a failure: a plan, a success, a status, or a note.
  "plugins/desk/mcp/src/crew/workspace.js#the-team-s-tooling-repository": "status note",
  "plugins/desk/mcp/src/crew/workspace.js#the-team-s-tooling-is": "status note",
  "plugins/desk/mcp/src/crew/workspace.js#this-is-a-crew-workspace": "status",
  "plugins/desk/mcp/src/crew/workspace.js#this-repository-is-already-a": "already done",
  "plugins/desk/mcp/src/crew/workspace.js#plan-only-nothing-was-written": "plan",
  "plugins/desk/mcp/src/crew/workspace.js#plan-only-nothing-was-written~2": "plan",
  "plugins/desk/mcp/src/crew/workspace.js#plan-only-nothing-was-written~3": "plan",
  "plugins/desk/mcp/src/crew/workspace.js#started-this-clone-s-crew": "success",
  "plugins/desk/mcp/src/crew/workspace.js#started-committed-on-this-clone": "success",
  "plugins/desk/mcp/src/crew/workspace.js#started-this-repository-is-now": "success",
  "plugins/desk/mcp/src/crew/workspace.js#started-this-repository-is-now~2": "success",
  "plugins/desk/mcp/src/crew/workspace.js#is-already-on-the-roster": "already done",
  "plugins/desk/mcp/src/crew/workspace.js#joined-is-on-the-roster": "success",
  "plugins/desk/mcp/src/crew/workspace.js#crew-s-desk-adopting": "commit message",
  "plugins/desk/mcp/src/crew/workspace.js#nothing-was-written": "carrier",
  "plugins/desk/mcp/src/crew/workspace.js#nothing-was-written~2": "carrier",
  "plugins/desk/mcp/src/desk/content-home.js#nothing-was-written-or-committed": "carrier",
  "plugins/desk/mcp/src/desk/resources.js#no-resource-was-changed": "carrier",
  "plugins/desk/mcp/src/desk/steps.js#no-step-was-changed": "carrier",
  "plugins/desk/mcp/src/factory/pipeline/build.js#factory-build": "carrier",
  "plugins/desk/mcp/src/factory/pr-green.js#pr-green": "carrier of a code",
  "plugins/desk/mcp/src/factory/release-version.js#release-version": "carrier of a code",
  "plugins/desk/mcp/src/factory/store-issues.js#factory-issues": "carrier of a code",
  "plugins/desk/mcp/src/tools/desk-save.js#got-a-string-that-is": "carrier of a checked message",
  "plugins/desk/mcp/src/tools/desk-save.js#the-path-holds-a-nul": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#the-path-holds-or-a": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#the-content-is-over-1": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#it-is-outside-the-resolved": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#it-is-listed-twice": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#the-file-there-is-a": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#what-is-there-is-not": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#it-leads-through-a-symbolic": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/lesson-team.js#already-in-effect-the-default": "success reply",
  "plugins/desk/mcp/src/tools/lesson-team.js#in-effect-merged-in-from": "success reply",
  "plugins/desk/mcp/src/tools/move.js#task-move": "commit message",
  "plugins/desk/mcp/src/tools/move.js#track-rename": "commit message",
  "plugins/desk/mcp/src/tools/note.js#left-for-merged-in-s": "success reply",
  "plugins/desk/mcp/src/tools/status.js#desk-search-is-starting": "status",
  "plugins/desk/mcp/src/tools/task.js#task-update-set-in-status": "carrier of a checked message",
  "plugins/desk/mcp/src/desk/improvement-person.js#no-lookup-at-session-start": "internal sentinel, caught by its caller",
  "plugins/desk/mcp/src/desk/runtime-resolver.js#cannot-find-module-in-the": "mirrors Node's own failed require",
}

function deskSurfaces() {
  const extracted = extractSurfaces({
    root: repoRoot,
    paths: ["plugins/desk/mcp/src", "plugins/desk/mcp/web.cjs", "plugins/desk/mcp/web-auth.cjs", "plugins/desk/hooks"],
    tool: "desk",
  })
  const browser = JSON.parse(readFileSync(path.join(repoRoot, "plugins/desk/mcp/web-catalog.json"), "utf8")).tools
  const found = extracted.errors.filter((error) => !error.id.includes("/lib/ouro-ui/"))
  return {
    ...extracted,
    errors: found.filter((error) => !(error.id in NOT_ERRORS)),
    texts: found.filter((error) => error.id in NOT_ERRORS).map(({ id, text, where }) => ({ id, text, where })),
    tools: [
      ...Object.entries(TOOL_DESCRIPTIONS).map(([name, description]) => ({ name, description, where: "plugins/desk/mcp/src/tool-names.js" })),
      ...browser.map((tool) => ({ name: tool.name, description: tool.description, where: "plugins/desk/mcp/web-catalog.json" })),
    ],
  }
}

test("every error and tool description in Desk is within Ouro AX, or recorded in the baseline that only shrinks", (t) => {
  const surfaces = deskSurfaces()
  assert.deepEqual(Object.keys(NOT_ERRORS).filter((id) => !surfaces.texts.some((text) => text.id === id)), [], "NOT_ERRORS names a text that is gone: remove it")
  const report = checkSurfaces(surfaces)
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
  assert.equal(baseline.ax, "surfaces-baseline/2")
  const result = ratchet(report, baseline.findings)
  if (process.env.UPDATE_AX_SURFACES_BASELINE === "1" && result.added.length === 0) {
    writeFileSync(baselinePath, `${JSON.stringify({ ax: baseline.ax, findings: Object.fromEntries(Object.entries(countFindings(report)).sort(([a], [b]) => (a < b ? -1 : 1))) }, null, 2)}\n`)
    return
  }
  assert.ok(
    result.ok,
    `${surfacesText(report, result, { baselinePath: "tests/desk/mcp/__tests__/runtime/ax-surfaces-baseline.json" })}\nA new finding is fixed in the code. A fixed one leaves the baseline: run this test with UPDATE_AX_SURFACES_BASELINE=1.`,
  )
  t.diagnostic(`${Object.values(baseline.findings).reduce((a, b) => a + b, 0)} findings recorded in ${report.surfaces} surfaces`)
})
