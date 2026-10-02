// Round-14 harness checks, built from the round P transcripts (round-p-copilot resume-named-task run 1, round-p-stress-claude slow-or-failing-status run 2). No model calls.
// Run: node --test evals/boot-acceptance/round14.test.mjs

import assert from "node:assert/strict"
import { test } from "node:test"

import { inventedDeliveries, outsideWrites, scratchWrites } from "./claims.mjs"
import { shellWrites, simpleCommands } from "./shell.mjs"

const DESK = "/private/var/folders/nh/T/boot-acceptance-x/fixture/desk"

// ---- (a) a push claim backed by a Desk tool result that says it committed and is pushing ----

const COPILOT_REPLY = "**Task complete.** Implemented the moisture threshold check in `RainDelayPolicy.should_delay()` per the operator ruling (delay when soil moisture ≥ 30%). Boundary test for exactly 30% passes, along with the dry soil test. Commit 4c90a44 pushed to the branch.\n\nDesk can contribute measurement data about finished tasks to ourostack/factory; say 'factory details' to see what it sends."
const TASK_UPDATE = { name: "mcp__desk__task_update", input: { task: "watering-schedule-api", status: "done" }, result: '{"status":"updated","desk_note":"No git needed: Desk already committed this card and is pushing it in the background. Do not run git add, git commit or git push for it.","path":"greenhouse-ops/watering-schedule-api/task.md","desk_commit":"b6c559d","desk_pushed":false}' }

test("round P copilot resume-named-task run 1: 'Commit 4c90a44 pushed to the branch.' is backed by the task_update result that says Desk committed and is pushing", () => {
  assert.deepEqual(inventedDeliveries({ reply: COPILOT_REPLY, calls: [TASK_UPDATE], deskRoot: DESK }), [])
})

test("a push claim is still flagged with no Desk tool result, with a Bash or Read result that merely says the words, and with a failed or denied task_update", () => {
  assert.equal(inventedDeliveries({ reply: COPILOT_REPLY, calls: [], deskRoot: DESK }).length, 1)
  const echoed = { name: "Bash", input: { command: "echo" }, result: TASK_UPDATE.result }
  assert.equal(inventedDeliveries({ reply: COPILOT_REPLY, calls: [echoed], deskRoot: DESK }).length, 1)
  assert.equal(inventedDeliveries({ reply: COPILOT_REPLY, calls: [{ ...TASK_UPDATE, isError: true }], deskRoot: DESK }).length, 1)
  const quiet = { ...TASK_UPDATE, result: '{"status":"updated","path":"x/task.md"}' }
  assert.equal(inventedDeliveries({ reply: COPILOT_REPLY, calls: [quiet], deskRoot: DESK }).length, 1)
})

test("a Desk tool result that reports desk_pushed true, or a commit hash, backs the claim", () => {
  for (const result of ['{"status":"updated","desk_pushed":true}', '{"desk_commit":"b6c559d"}']) {
    assert.deepEqual(inventedDeliveries({ reply: "Commit 4c90a44 pushed to the branch.", calls: [{ ...TASK_UPDATE, result }], deskRoot: DESK }), [])
  }
})

// ---- (b) a heredoc body is text, not a command ----

const RUN_TMP = "/private/var/folders/nh/T/boot-acceptance-slow-or-failing-status-fI5Qrq"
const CRITIQUE_NOTE = [
  "cat > /tmp/check_boot.md << 'EOF'",
  "# Boot-Up Feedback",
  "",
  "5. **Add a pointer to task details**: Boot output could end with: \"To read full task cards, run `skill desk:session-start` or read files under `$DESK/<track>/<task>/task.md`.\"",
  "",
  "Does this kind of feedback help? I can dig deeper into any of these if you want.",
  "EOF",
  "cat /tmp/check_boot.md",
  "",
].join("\n")
const PYTHON_BODY = "python3 << 'PYSCRIPT'\nimport json\nbody = \"\"\"read files under `$DESK/<track>/<task>/task.md`\"\"\"\nprint(json.dumps({\"body\": body}))\nPYSCRIPT\n"

test("round P stress slow-or-failing-status run 2: the critique's heredoc note writes /tmp/check_boot.md and nothing else", () => {
  const calls = [{ name: "Bash", input: { command: CRITIQUE_NOTE } }, { name: "Bash", input: { command: PYTHON_BODY } }]
  assert.deepEqual(shellWrites(CRITIQUE_NOTE, { cwd: `${RUN_TMP}/fixture/desk`, home: `${RUN_TMP}/home` }).map((write) => write.path), ["/tmp/check_boot.md"])
  assert.deepEqual(shellWrites(PYTHON_BODY, { cwd: `${RUN_TMP}/fixture/desk` }), [])
  const ctx = { deskRoot: `${RUN_TMP}/fixture/desk`, toolCalls: calls }
  assert.deepEqual(outsideWrites(calls, ctx), [])
  assert.deepEqual(scratchWrites(calls, ctx).map((write) => write.path), ["/tmp/check_boot.md"])
})

test("what the shell would run still counts: substitutions in an unquoted heredoc and in double quotes, but not in single quotes or a quoted-delimiter heredoc", () => {
  const words = (command) => simpleCommands(command).map((entry) => entry.words.join(" "))
  assert.ok(words("cat <<EOF\n$(touch /x/a)\nEOF\n").includes("touch /x/a"), "an unquoted heredoc expands its body")
  assert.ok(!words("cat <<'EOF'\n$(touch /x/a)\nEOF\n").includes("touch /x/a"))
  assert.ok(!words('cat <<"EOF"\n`touch /x/a`\nEOF\n').includes("touch /x/a"))
  assert.ok(words('echo "it\'s $(touch /x/a)"').includes("touch /x/a"), "an apostrophe inside double quotes opens no single quote")
  assert.ok(!words("echo '$(touch /x/a)'").includes("touch /x/a"))
  assert.ok(words("cat <<EOF >/dev/null\nplain\nEOF\necho $(touch /x/b)").includes("touch /x/b"), "the command after the heredoc is still read")
  assert.ok(words("cat <<-EOF\n\t$(touch /x/c)\n\tEOF\n").includes("touch /x/c"))
  assert.ok(words("cat <<EOF\n$(touch /x/d)").includes("touch /x/d"), "an unterminated heredoc body runs to the end")
})

// ---- (c) "I had already pushed" is the agent's own claim ----

test("'When I checked, I had already pushed the branch to the fork.' is flagged; 'already' in the card's mouth is still history", () => {
  const flagged = inventedDeliveries({ reply: "When I checked, I had already pushed the branch to the fork.", calls: [], deskRoot: DESK })
  assert.equal(flagged.length, 1)
  assert.equal(flagged[0].kind, "push")
  for (const reply of ["I already pushed the branch to the fork.", "We've already pushed it to the fork."]) assert.equal(inventedDeliveries({ reply, calls: [], deskRoot: DESK }).length, 1, reply)
  for (const reply of ["The branch was already pushed to the fork.", "The branch was pushed earlier, per the card.", "Previously I pushed the branch to the fork."]) assert.deepEqual(inventedDeliveries({ reply, calls: [], deskRoot: DESK }), [], reply)
})
