// The task-status guard (the invented-completion finding): a Claude Code
// `PreToolUse` hook on `Write`/`Edit` that denies a direct edit setting a
// task card's `status:` frontmatter line to `done`, pointing the agent at
// `task_update` instead -- the tool that now enforces `assertDoneEvidence`
// (see tools/task.js and task_update.test.js's own "Evidence gate on
// `done`" section). This file tests the pure decision
// (`taskStatusGuardHook` and its two helpers) directly, plus one real
// stdin/stdout pass through the `.cjs` entry point mirroring
// host_enforcement_claude.test.js's own `runHookOverStdio` pattern, to
// prove the wrapper's wiring and its fail-open behavior on a broken call.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  isTaskCardPath,
  statusChange,
  statusOf,
  taskStatusGuardHook,
} from "../../../../../plugins/desk/mcp/src/runtime/task-status-guard.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "task-status-guard.cjs")

function writeInput({ toolName, toolInput }) {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "fixture-session" }
}

function assertDenied(result) {
  assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse")
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny")
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /task_update/)
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /evidence/)
}

function assertAllowed(result) {
  assert.deepEqual(result, {})
}

test("isTaskCardPath matches only a file_path whose final segment is exactly task.md", () => {
  assert.equal(isTaskCardPath("task.md"), true)
  assert.equal(isTaskCardPath("/repo/track/my-task/task.md"), true)
  assert.equal(isTaskCardPath("track\\my-task\\task.md"), true, "backslash-separated (Windows-shaped) paths still match")
  assert.equal(isTaskCardPath("/repo/track/my-task/nottask.md"), false)
  assert.equal(isTaskCardPath("/repo/track/my-task/task.md.bak"), false)
  assert.equal(isTaskCardPath("/repo/track.md/other.md"), false)
  assert.equal(isTaskCardPath(""), false)
  assert.equal(isTaskCardPath(undefined), false)
  assert.equal(isTaskCardPath(42), false)
})

function withCard(text, run) {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-card-"))
  try {
    const file = path.join(dir, "greenhouse", "watering-api", "task.md")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
    return run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CARD = "---\ntitle: Watering API\nstatus: processing\nowner: ari\n---\n\n# Watering API\n\nNext: write the test.\nstatus: quoted in the body\n"

test("statusOf reads the frontmatter status only for a whole card, any quoting, and the whole text for a fragment", () => {
  assert.equal(statusOf(CARD), "processing")
  assert.equal(statusOf("---\nstatus: \"validating\"\n---\n"), "validating")
  assert.equal(statusOf("---\nstatus: 'done'  \n---\n"), "done")
  assert.equal(statusOf("---\ntitle: x\n---\nstatus: done\n"), null, "a body line is not the card's status")
  assert.equal(statusOf("status:drafting"), "drafting", "a fragment is searched whole")
  assert.equal(statusOf("nothing here"), null)
})

test("statusChange on Write: compares the card on disk with the new content, and treats a missing file as a new card", () => {
  withCard(CARD, (file) => {
    assert.deepEqual(statusChange("Write", { file_path: file, content: CARD.replace("processing", "validating") }), { from: "processing", to: "validating" })
    assert.equal(statusChange("Write", { file_path: file, content: CARD.replace("Next: write", "Next: rewrite") }), null, "a body edit keeps the status")
    assert.deepEqual(statusChange("Write", { file_path: file, content: "---\ntitle: x\n---\n" }), { from: "processing", to: null }, "dropping the status line is a change")
    assert.deepEqual(statusChange("Write", { file_path: file }), { from: "processing", to: null }, "missing content reads as empty")
  })
  const missing = path.join(tmpdir(), "no-such-dir-guard", "track", "slug", "task.md")
  assert.equal(statusChange("Write", { file_path: missing, content: "---\nstatus: drafting\n---\n" }), null, "a new card may start in any non-done status")
  assert.deepEqual(statusChange("Write", { file_path: missing, content: "---\nstatus: done\n---\n" }), { from: null, to: "done" }, "but not born done")
})

test("statusChange on Edit and MultiEdit applies the edits to the card on disk, in order, and compares the result", () => {
  withCard(CARD, (file) => {
    assert.deepEqual(statusChange("Edit", { file_path: file, old_string: "status: processing", new_string: "status: validating" }), { from: "processing", to: "validating" })
    assert.equal(statusChange("Edit", { file_path: file, old_string: "Next: write the test.", new_string: "Next: ship.\n\n## Completed work\n- did it" }), null, "body edits are fine")
    assert.equal(statusChange("Edit", { file_path: file, old_string: "status: quoted in the body", new_string: "status: validating" }), null, "a body line is not the card's status")
    assert.equal(statusChange("Edit", { file_path: file, old_string: "owner: ari", new_string: "owner: sam" }), null)
    assert.deepEqual(statusChange("Edit", { file_path: file, old_string: "processing", new_string: "done", replace_all: true }), { from: "processing", to: "done" })
    assert.deepEqual(
      statusChange("MultiEdit", { file_path: file, edits: [{ old_string: "processing", new_string: "drafting" }, { old_string: "drafting", new_string: "validating" }] }),
      { from: "processing", to: "validating" },
      "a later edit sees the earlier one",
    )
    assert.equal(
      statusChange("MultiEdit", { file_path: file, edits: [{ old_string: "status: processing", new_string: "status: drafting" }, { old_string: "status: drafting", new_string: "status: processing" }] }),
      null,
      "a round trip inside one call leaves the status as it was",
    )
    assert.equal(statusChange("MultiEdit", { file_path: file, edits: [{ old_string: "Next: write the test." }, {}] }), null, "an edit with no strings is skipped, not applied")
    assert.equal(statusChange("MultiEdit", { file_path: file, edits: [{ old_string: "Next: write the test.", new_string: "Next: " }] }), null, "an edit with no new_string deletes the text")
    assert.equal(statusChange("MultiEdit", { file_path: file, edits: [] }), null)
    assert.equal(statusChange("MultiEdit", { file_path: file }), null, "no edits at all")
  })
})

test("a nested status: under repos is not the card's status, in either direction", () => {
  const nested = "---\ntitle: x\nstatus: processing\nrepos:\n  - name: a/b\n    status: stale\n---\n"
  assert.equal(statusOf(nested), "processing")
  assert.equal(statusOf("---\ntitle: x\nrepos:\n  - name: a/b\n    status: stale\n---\n"), null, "only a nested status means no card status")
  assert.equal(statusOf("  status: indented fragment"), null)
  withCard(nested, (file) => {
    assert.equal(statusChange("Edit", { file_path: file, old_string: "    status: stale", new_string: "    status: fresh" }), null, "editing a nested status is not a status change")
    assert.deepEqual(statusChange("Edit", { file_path: file, old_string: "status: processing", new_string: "status: done" }), { from: "processing", to: "done" })
  })
  withCard("---\ntitle: x\nrepos:\n  - name: a/b\n    status: stale\n---\n", (file) => {
    assert.deepEqual(statusChange("Edit", { file_path: file, old_string: "title: x", new_string: "title: x\nstatus: done" }), { from: null, to: "done" }, "adding a top-level status beside a nested one is still a change")
  })
})

test("statusChange falls back to the status lines inside the edit strings when the card cannot be read or an edit does not apply", () => {
  const missing = path.join(tmpdir(), "no-such-dir-guard", "track", "slug", "task.md")
  assert.deepEqual(statusChange("Edit", { file_path: missing, old_string: "status: drafting", new_string: "status: processing" }), { from: "drafting", to: "processing" })
  assert.deepEqual(statusChange("Edit", { file_path: missing, old_string: "x", new_string: "status: done" }), { from: null, to: "done" })
  assert.equal(statusChange("Edit", { file_path: missing, old_string: "old next step", new_string: "new next step" }), null)
  assert.equal(statusChange("Edit", { file_path: missing }), null, "missing strings read as empty")
  assert.deepEqual(
    statusChange("MultiEdit", { file_path: missing, edits: [{ old_string: "old next step", new_string: "new" }, { old_string: "status: processing", new_string: "status: done" }] }),
    { from: "processing", to: "done" },
    "the status-changing edit is not the first",
  )
  assert.equal(statusChange("MultiEdit", { file_path: missing, edits: [{ old_string: "a", new_string: "b" }, {}] }), null)
  withCard(CARD, (file) => {
    assert.deepEqual(statusChange("Edit", { file_path: file, old_string: "status: waiting", new_string: "status: validating" }), { from: "waiting", to: "validating" }, "an old_string that is not in the card still gets judged")
    assert.equal(statusChange("Edit", { file_path: file, old_string: "", new_string: "x" }), null, "an empty old_string does not apply and changes no status line")
  })
})

test("denies a Claude Code Write that would create a task card with status: done", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Write", toolInput: { file_path: "/repo/track/my-task/task.md", content: "---\nstatus: done\n---\n" } }),
    "claude",
  )
  assertDenied(result)
})

test("denies a direct Edit of a real task card from processing to validating, and names the exact task_update call", () => {
  withCard(CARD, (file) => {
    const result = taskStatusGuardHook(
      writeInput({ toolName: "Edit", toolInput: { file_path: file, old_string: "status: processing", new_string: "status: validating" } }),
      "claude",
    )
    const reason = result.hookSpecificOutput.permissionDecisionReason
    assert.equal(result.hookSpecificOutput.permissionDecision, "deny")
    assert.match(reason, /`processing` to `validating`/u)
    assert.match(reason, /task_update/u)
    assert.match(reason, /track: "greenhouse", slug: "watering-api", frontmatter: \{ status: "validating" \}/u)
    assert.doesNotMatch(reason, /evidence/u, "evidence is only asked for on a move to done")
    assert.match(reason, /note: "<one line of what actually happened>"/u)
  })
})

test("denies a Write that rewrites a real card with a new status and a Completed work section (the round 5 bypass)", () => {
  withCard(CARD, (file) => {
    const result = taskStatusGuardHook(
      writeInput({ toolName: "Write", toolInput: { file_path: file, content: `${CARD.replace("processing", "validating")}\n## Completed work\n- all done\n` } }),
      "claude",
    )
    assert.equal(result.hookSpecificOutput.permissionDecision, "deny")
  })
})

test("a removed status line is denied with a placeholder for the new status", () => {
  withCard(CARD, (file) => {
    const result = taskStatusGuardHook(
      writeInput({ toolName: "Write", toolInput: { file_path: file, content: "---\ntitle: x\n---\n" } }),
      "claude",
    )
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /`processing` to no status/u)
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /status: "<new status>"/u)
  })
})

test("the deny reason falls back to placeholders for a path without track and slug segments", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Write", toolInput: { file_path: "task.md", content: "---\nstatus: done\n---\n" } }),
    "claude",
  )
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /track: "<track>", slug: "<slug>"/u)
})

test("denies a Claude Code Edit whose new_string sets status: done", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Edit", toolInput: { file_path: "/repo/track/my-task/task.md", old_string: "status: processing", new_string: "status: done" } }),
    "claude",
  )
  assertDenied(result)
})

test("denies a Claude Code MultiEdit whose edits array includes a status change, even when it is not the first edit", () => {
  const result = taskStatusGuardHook(
    writeInput({
      toolName: "MultiEdit",
      toolInput: {
        file_path: "/repo/track/my-task/task.md",
        edits: [
          { old_string: "old next step", new_string: "new next step" },
          { old_string: "status: processing", new_string: "status: done" },
        ],
      },
    }),
    "claude",
  )
  assertDenied(result)
})

test("denies every direct edit of a real task card, body edits included, and names the task_update call for each need", () => {
  withCard(CARD, (file) => {
    const claim = "Push routing confirmed; scenario is handled."
    const calls = [
      { toolName: "Edit", toolInput: { file_path: file, old_string: "Next: write the test.", new_string: claim } },
      { toolName: "MultiEdit", toolInput: { file_path: file, edits: [{ old_string: "Next: write the test.", new_string: claim }] } },
      { toolName: "Write", toolInput: { file_path: file, content: `${CARD}\n${claim}\n` } },
      { toolName: "Edit", toolInput: { file_path: file, old_string: "not in the card", new_string: claim } },
    ]
    for (const call of calls) {
      const reason = taskStatusGuardHook(writeInput(call), "claude").hookSpecificOutput.permissionDecisionReason
      assert.match(reason, /Desk denies a direct edit of an existing task card/u)
      assert.match(reason, /track: "greenhouse", slug: "watering-api", note: "/u)
      assert.match(reason, /next_step: "/u)
      assert.match(reason, /frontmatter: \{ \.\.\. \}/u)
      assert.match(reason, /body_append: "/u)
      assert.doesNotMatch(reason, /changes the card's `status:`/u)
    }
  })
})

test("a status change on a real card adds the status call to the same message", () => {
  withCard(CARD, (file) => {
    const reason = taskStatusGuardHook(
      writeInput({ toolName: "Edit", toolInput: { file_path: file, old_string: "status: processing", new_string: "status: done" } }),
      "claude",
    ).hookSpecificOutput.permissionDecisionReason
    assert.match(reason, /changes the card's `status:`/u)
    assert.match(reason, /evidence: \{ kind, ref \}/u)
  })
})

test("a path with no card yet is task_create's: a Write or an Edit there that leaves status alone passes", () => {
  assertAllowed(taskStatusGuardHook(writeInput({ toolName: "Write", toolInput: { file_path: "/nowhere/track/new-task/task.md", content: "---\nstatus: drafting\n---\n" } }), "claude"))
  assertAllowed(taskStatusGuardHook(writeInput({ toolName: "Edit", toolInput: { file_path: "/nowhere/track/new-task/task.md", old_string: "a", new_string: "b" } }), "claude"))
})

test("allows a Claude Code MultiEdit to a task card whose edits never touch the status line, when the card does not exist yet", () => {
  const result = taskStatusGuardHook(
    writeInput({
      toolName: "MultiEdit",
      toolInput: {
        file_path: "/repo/track/my-task/task.md",
        edits: [
          { old_string: "owner: a", new_string: "owner: b" },
          { old_string: "old next step", new_string: "new next step" },
        ],
      },
    }),
    "claude",
  )
  assertAllowed(result)
})

test("allows a Write/Edit to a path with no card that touches a different field, leaving status alone", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Edit", toolInput: { file_path: "/repo/track/my-task/task.md", old_string: "old next step", new_string: "new next step" } }),
    "claude",
  )
  assertAllowed(result)
})

test("allows a status: done write to a file that is not a task card", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Write", toolInput: { file_path: "/repo/track/my-task/notes.md", content: "status: done" } }),
    "claude",
  )
  assertAllowed(result)
})

test("allows a status: done write for a tool this guard does not cover", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Bash", toolInput: { command: "echo 'status: done' >> task.md" } }),
    "claude",
  )
  assertAllowed(result)
})

test("tolerates a JSON-string-encoded tool_input the same way, and allows through malformed JSON rather than throwing", () => {
  const encoded = writeInput({ toolName: "Write", toolInput: JSON.stringify({ file_path: "/repo/track/my-task/task.md", content: "status: done" }) })
  assertDenied(taskStatusGuardHook(encoded, "claude"))

  const broken = writeInput({ toolName: "Write", toolInput: "not json" })
  assertAllowed(taskStatusGuardHook(broken, "claude"))
})

test("allows through a call whose tool_input is missing, null, or not an object at all", () => {
  assertAllowed(taskStatusGuardHook(writeInput({ toolName: "Write", toolInput: undefined }), "claude"))
  assertAllowed(taskStatusGuardHook(writeInput({ toolName: "Write", toolInput: null }), "claude"))
  assertAllowed(taskStatusGuardHook(writeInput({ toolName: "Write", toolInput: 42 }), "claude"))
})

test("allows through a call with neither tool_name nor toolName at all", () => {
  const result = taskStatusGuardHook({ hook_event_name: "PreToolUse", session_id: "fixture-session" }, "claude")
  assertAllowed(result)
})

test("allows through a call missing file_path entirely", () => {
  const result = taskStatusGuardHook(writeInput({ toolName: "Write", toolInput: { content: "status: done" } }), "claude")
  assertAllowed(result)
})

test("recognizes toolName/toolArgs as well as tool_name/tool_input, the same alias pair ask-gate.js reads", () => {
  const result = taskStatusGuardHook(
    { hook_event_name: "PreToolUse", toolName: "Write", toolArgs: { file_path: "/repo/track/my-task/task.md", content: "status: done" } },
    "claude",
  )
  assertDenied(result)
})

test("allows every call for any host but claude, even one that would otherwise be denied", () => {
  for (const host of [undefined, "copilot", "codex", "some-future-host"]) {
    const result = taskStatusGuardHook(
      writeInput({ toolName: "Write", toolInput: { file_path: "/repo/track/my-task/task.md", content: "status: done" } }),
      host,
    )
    assertAllowed(result)
  }
})

function runHookOverStdio(input, env = process.env) {
  const result = spawnSync(process.execPath, [hook, "claude"], { input: JSON.stringify(input), env, encoding: "utf8" })
  return { result, output: result.stdout.trim() === "" ? {} : JSON.parse(result.stdout) }
}

test("the .cjs entry point wraps the deny decision in Claude's hookSpecificOutput shape over real stdin/stdout, and fails open on malformed input", () => {
  const { result, output } = runHookOverStdio(
    writeInput({ toolName: "Write", toolInput: { file_path: "/repo/track/my-task/task.md", content: "status: done" } }),
  )
  assert.equal(result.status, 0)
  assertDenied(output)

  const allowed = runHookOverStdio(writeInput({ toolName: "Read", toolInput: {} }))
  assert.equal(allowed.result.status, 0)
  assert.deepEqual(allowed.output, {})

  // Malformed stdin must not exit 2 (the only PreToolUse code that blocks): it must fail open.
  const broken = spawnSync(process.execPath, [hook, "claude"], { input: "not json", env: process.env, encoding: "utf8" })
  assert.notEqual(broken.status, 2)
})
