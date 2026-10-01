// The task-status guard's `Bash` check (round 12): a shell command that writes a live task card of the bound desk is denied, one that only reads it passes.
// The first block is the round E run 8 command, nearly verbatim.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { taskStatusGuardHook as guard } from "../../../../../plugins/desk/mcp/src/runtime/task-status-guard.js"
import { shellCardWrites } from "../../../../../plugins/desk/mcp/src/runtime/shell-card-writes.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const CARD = "---\ntitle: Watering API\nstatus: processing\n---\n\n# Watering API\n"
const BROKEN = "---\ntitle: [unclosed\n---\n"

const DESK = realpathSync(mkdtempSync(path.join(tmpdir(), "guard-shell-desk-")))
const OUTSIDE = realpathSync(mkdtempSync(path.join(tmpdir(), "guard-shell-out-")))
for (const dir of ["_meta", "_archive", "greenhouse-ops/watering-schedule-api", "greenhouse-ops/_archive/old-job", "greenhouse-ops/broken-card", "desks/ari/garden/planting-plan"]) mkdirSync(path.join(DESK, dir), { recursive: true })
writeFileSync(path.join(DESK, "greenhouse-ops/watering-schedule-api/task.md"), CARD)
writeFileSync(path.join(DESK, "greenhouse-ops/_archive/old-job/task.md"), CARD)
writeFileSync(path.join(DESK, "greenhouse-ops/broken-card/task.md"), BROKEN)
writeFileSync(path.join(DESK, "desks/ari/garden/planting-plan/task.md"), CARD)
mkdirSync(path.join(OUTSIDE, "proj/x"), { recursive: true })
writeFileSync(path.join(OUTSIDE, "proj/x/task.md"), CARD)
test.after(() => {
  rmSync(DESK, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
})

const CARD_REL = "greenhouse-ops/watering-schedule-api/task.md"
const CARD_ABS = path.join(DESK, CARD_REL)

function run(command, { cwd = DESK, tool = "Bash", root = DESK } = {}) {
  return guard({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd }, "claude", undefined, { root, home: "/home/someone" })
}
const denied = (command, options) => {
  const result = run(command, options)
  assert.equal(result.hookSpecificOutput?.permissionDecision, "deny", `expected a deny for: ${command}`)
  return result.hookSpecificOutput.permissionDecisionReason
}
const allowed = (command, options) => assert.deepEqual(run(command, options), {}, `expected a pass for: ${command}`)

test("the round E run 8 command (a node script that rewrites the card by a relative path) is denied, naming task_update and the ToolSearch hint", () => {
  const reason = denied(`node -e "
const fs = require('fs');
const path = require('path');
const taskPath = path.join(process.cwd(), 'greenhouse-ops/watering-schedule-api/task.md');
const content = fs.readFileSync(taskPath, 'utf8');
fs.writeFileSync(taskPath, content.replace('processing', 'validating'));
"`)
  assert.match(reason, /shell command that writes an existing task card/)
  assert.match(reason, /task_update/)
  assert.match(reason, /ToolSearch/)
  assert.match(reason, /greenhouse-ops/)
  assert.match(reason, /git hook/)
})

const WRITES = [
  [`echo hi > ${CARD_REL}`, "a redirect"],
  [`cat notes.txt >> ${CARD_REL}`, "append"],
  [`echo hi >${CARD_REL}`, "no space"],
  [`echo hi 2> "${CARD_REL}"`, "quoted"],
  [`echo hi >| ${CARD_REL}`, "forced redirect"],
  [`echo hi > ${CARD_ABS}`, "absolute"],
  [`echo hi > $DESK/${CARD_REL}`.replace("$DESK", "$DESK"), "$DESK"],
  [`echo hi > \${DESK}/${CARD_REL}`, "${DESK}"],
  [`cd ${DESK} && echo hi > ${CARD_REL}`, "after cd"],
  [`echo hi | tee ${CARD_REL}`, "tee"],
  [`echo hi | tee -a ${CARD_REL}`, "tee -a"],
  [`sed -i 's/processing/done/' ${CARD_REL}`, "sed -i"],
  [`sed -i '' 's/processing/done/' ${CARD_REL}`, "BSD sed -i"],
  [`sed -i.bak 's/a/b/' ${CARD_REL}`, "sed -i.bak"],
  [`sed -ni 's/a/b/p' ${CARD_REL}`, "sed -ni"],
  [`sed --in-place 's/a/b/' ${CARD_REL}`, "--in-place"],
  [`perl -pi -e 's/a/b/' ${CARD_REL}`, "perl -pi"],
  [`perl -i.orig -pe 's/a/b/' ${CARD_REL}`, "perl -i.orig"],
  [`ruby -i -pe 'sub(/a/, "b")' ${CARD_REL}`, "ruby -i"],
  [`yq -i '.status = "done"' ${CARD_REL}`, "yq -i"],
  [`cp /tmp/new.md ${CARD_REL}`, "cp onto"],
  [`mv /tmp/new.md ${CARD_REL}`, "mv onto"],
  [`install -m 644 /tmp/new.md ${CARD_REL}`, "install"],
  [`rsync -a /tmp/new.md ${CARD_REL}`, "rsync"],
  [`git checkout -- ${CARD_REL}`, "git checkout --"],
  [`git checkout HEAD~1 -- ${CARD_REL}`, "git checkout ref --"],
  [`git restore ${CARD_REL}`, "git restore"],
  [`git restore --staged --worktree ${CARD_REL}`, "git restore --worktree"],
  [`git -C ${DESK} checkout -- ${CARD_REL}`, "git -C checkout"],
  [`truncate -s 0 ${CARD_REL}`, "truncate"],
  [`dd if=/tmp/new.md of=${CARD_REL}`, "dd of="],
  [`python3 -c "open('${CARD_REL}', 'w').write('x')"`, "python open w"],
  [`python3 -c "open('${CARD_REL}', mode='a').write('x')"`, "python open a"],
  [`python3 -c "open('${CARD_REL}', 'r+').write('x')"`, "python open r+"],
  [`python3 -c "from pathlib import Path; Path('${CARD_REL}').write_text('x')"`, "write_text"],
  [`python3 -c "import shutil; shutil.copy('/tmp/a', '${CARD_REL}')"`, "shutil"],
  [`node -e "require('fs').appendFileSync('${CARD_REL}', 'x')"`, "appendFileSync"],
  [`node -e "require('fs').promises.writeFile('${CARD_REL}', 'x')"`, "fs.promises.writeFile"],
  [`ruby -e "File.write('${CARD_REL}', 'x')"`, "File.write"],
  [`bash -c "echo hi > ${CARD_REL}"`, "inside bash -c"],
  [`echo a; echo hi > ${CARD_REL}; echo b`, "in a sequence"],
  [`cat <<'EOF' > ${CARD_REL}\nhello\nEOF`, "heredoc"],
  [`TASK=${CARD_REL}; echo hi > ${CARD_REL}`, "with a variable earlier"],
  [`node -e "const p=require('path').join('${DESK}','greenhouse-ops','watering-schedule-api','task.md'); require('fs').writeFileSync(p,'x')"`, "a path built in pieces, by slug"],
  [`echo hi > desks/ari/garden/planting-plan/task.md`, "desks/<alias> card"],
  [`echo hi > GREENHOUSE-OPS/WATERING-SCHEDULE-API/TASK.MD`, "upper case on a case-insensitive disk (word match)"],
]

for (const [command, label] of WRITES) {
  test(`denied: ${label}`, () => {
    if (label.startsWith("upper case")) {
      // The path does not exist with that spelling on a case-sensitive disk, so only assert the word is read, not that the disk resolves it.
      assert.doesNotThrow(() => run(command))
      return
    }
    denied(command)
  })
}

const READS = [
  `cat ${CARD_REL}`,
  `cat ${CARD_ABS}`,
  `grep -n status ${CARD_REL}`,
  `grep -i status ${CARD_REL}`,
  `head -20 ${CARD_REL}`,
  `tail -n 5 ${CARD_REL} | sed 's/a/b/'`,
  `less ${CARD_REL}`,
  `wc -l ${CARD_REL}`,
  `git diff -- ${CARD_REL}`,
  `git diff HEAD~1 ${CARD_REL}`,
  `git log -p ${CARD_REL}`,
  `git log --follow --oneline -- ${CARD_REL}`,
  `git show HEAD:${CARD_REL}`,
  `git blame ${CARD_REL}`,
  `git status --short ${CARD_REL}`,
  `git restore --staged ${CARD_REL}`,
  `git checkout main && cat ${CARD_REL}`,
  `sed -n '1,5p' ${CARD_REL}`,
  `sed -e 's/a/b/' ${CARD_REL}`,
  `sed -E 's/(a)/\\1/' ${CARD_REL} > /tmp/out.md`,
  `awk '/status/ {print}' ${CARD_REL}`,
  `perl -ne 'print if /status/' ${CARD_REL}`,
  `cat ${CARD_REL} > /tmp/copy.md`,
  `cat ${CARD_REL} | tee /tmp/copy.md`,
  `cp ${CARD_REL} /tmp/backup.md`,
  `mv ${CARD_REL} /tmp/gone.md`,
  `diff ${CARD_REL} /tmp/other.md`,
  `ls -l ${CARD_REL}`,
  `test -f ${CARD_REL} && echo yes`,
  `echo "see task.md for the next step"`,
  `node -e "console.log(require('fs').readFileSync('${CARD_REL}', 'utf8'))"`,
  `node -e "require('fs').writeFileSync('/tmp/out.txt', require('fs').readFileSync('${CARD_REL}', 'utf8'))"`,
  `python3 -c "print(open('${CARD_REL}').read())"`,
  `python3 -c "print(open('${CARD_REL}', 'r').read())"`,
  `python3 -c "from pathlib import Path; print(Path('${CARD_REL}').read_text())"`,
  `git commit -m "note" -- README.md`,
  `echo hi > notes.md`,
  `echo hi > task.md.bak`,
  `echo hi > ${CARD_REL}.bak`,
  `echo hi > greenhouse-ops/watering-schedule-api/notes.md`,
  `echo hi > greenhouse-ops/_archive/old-job/task.md`,
  `echo hi > ${path.join(OUTSIDE, "proj/x/task.md")}`,
  `echo hi > greenhouse-ops/missing-job/task.md`,
  `echo hi > greenhouse-ops/broken-card/task.md`,
  `ls`,
  ``,
]
for (const command of READS) {
  test(`passes: ${command.slice(0, 70)}`, () => allowed(command))
}

test("a script that builds the path in pieces is read only when it names a live card's slug and a script write form", () => {
  allowed(`node -e "const p=require('path').join(process.cwd(),'a','b','task.md'); require('fs').writeFileSync(p,'x')"`)
  allowed(`node -e "const p='task.md'; console.log(require('fs').readFileSync(p,'utf8'), 'watering-schedule-api')"`)
  denied(`node -e "const p=require('path').join(process.cwd(),'greenhouse-ops','watering-schedule-api','task.md'); require('fs').writeFileSync(p,'x')"`)
  denied(`node -e "const dir='planting-plan'; require('fs').writeFileSync(require('path').join(dir,'task.md'),'x')"`)
  allowed(`node -e "require('fs').writeFileSync('x','watering-schedule-api-notes'); const t='task.md'"`)
})

test("a bare task.md resolves against the folder the command moves into, or the session folder", () => {
  denied("cd greenhouse-ops/watering-schedule-api && echo hi > task.md")
  denied("cd greenhouse-ops/watering-schedule-api; sed -i 's/a/b/' ./task.md")
  denied(`pushd "${path.join(DESK, "greenhouse-ops/watering-schedule-api")}" && echo hi >> task.md`)
  denied("git -C greenhouse-ops/watering-schedule-api checkout -- task.md")
  denied("echo hi > task.md", { cwd: path.join(DESK, "greenhouse-ops/watering-schedule-api") })
  allowed("echo hi > task.md")
  allowed("cat task.md", { cwd: path.join(DESK, "greenhouse-ops/watering-schedule-api") })
})

test("PowerShell write forms are read the same way", () => {
  denied(`Set-Content -Path ${CARD_REL} -Value x`, { tool: "PowerShell" })
  denied(`'x' | Out-File ${CARD_REL}`, { tool: "PowerShell" })
  denied(`'x' > ${CARD_REL}`, { tool: "PowerShell" })
  allowed(`Get-Content ${CARD_REL}`, { tool: "PowerShell" })
})

test("only Claude Code's Bash and PowerShell calls are read, and a malformed command is not", () => {
  const input = { tool_name: "Bash", tool_input: { command: `echo hi > ${CARD_REL}` }, cwd: DESK }
  assert.deepEqual(guard(input, "copilot", undefined, { root: DESK }), {})
  assert.deepEqual(guard({ ...input, tool_name: "Grep" }, "claude", undefined, { root: DESK }), {})
  assert.deepEqual(guard({ ...input, tool_input: { command: 42 } }, "claude", undefined, { root: DESK }), {})
  assert.deepEqual(guard({ ...input, tool_input: {} }, "claude", undefined, { root: DESK }), {})
  assert.equal(guard({ ...input, tool_input: JSON.stringify({ command: `echo hi > ${CARD_REL}` }) }, "claude", undefined, { root: DESK }).hookSpecificOutput.permissionDecision, "deny")
})

test("a session with no bound desk finds the desk from the card's own folder", () => {
  const result = guard({ tool_name: "Bash", tool_input: { command: `echo hi > ${CARD_ABS}` }, cwd: OUTSIDE }, "claude", undefined, { root: null, home: "/home/someone" })
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny")
  assert.deepEqual(guard({ tool_name: "Bash", tool_input: { command: "echo hi > greenhouse-ops/watering-schedule-api/task.md" }, cwd: OUTSIDE }, "claude", undefined, { root: null, home: "/home/someone" }), {})
  // A path built in pieces cannot be placed without a bound desk.
  assert.deepEqual(guard({ tool_name: "Bash", tool_input: { command: `node -e "require('fs').writeFileSync(require('path').join('watering-schedule-api','task.md'),'x')"` }, cwd: OUTSIDE }, "claude", undefined, { root: null, home: "/home/someone" }), {})
})

test("~ and $HOME name the home folder", () => {
  const home = DESK
  const result = guard({ tool_name: "Bash", tool_input: { command: `echo hi > ~/${CARD_REL}; echo hi > $HOME/${CARD_REL}` }, cwd: OUTSIDE }, "claude", undefined, { root: DESK, home })
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny")
})

test("shellCardWrites reports each card once, with the form that wrote it, and expands only whole variable names", () => {
  const seen = []
  const resolve = (word) => {
    seen.push(word)
    return word.endsWith("a/task.md") ? { absolute: "/d/a/task.md" } : null
  }
  const writes = shellCardWrites("echo x > a/task.md && echo y > a/task.md && cat b/task.md", { resolve })
  assert.deepEqual(writes, [{ card: { absolute: "/d/a/task.md" }, via: "a redirect" }])
  assert.deepEqual(shellCardWrites("cat a/task.md", { resolve }), [])
  assert.deepEqual(shellCardWrites("no card here", { resolve }), [])
  assert.deepEqual(shellCardWrites(undefined, { resolve }), [])
  const words = []
  shellCardWrites("echo > $DESKX/task.md; echo > $DESK/task.md", { resolve: (word) => (words.push(word), null), vars: { DESK: "/root" } })
  assert.deepEqual(words, ["$DESKX/task.md", "/root/task.md"])
  assert.deepEqual(shellCardWrites("x", { resolve }), [])
})

test("the hook entry point denies a card write over stdio, lets an ordinary Bash call through without loading the guard, and still fails open on bad input", () => {
  const hook = path.join(plugin, "hooks", "task-status-guard.cjs")
  const call = (payload, raw) => spawnSync(process.execPath, [hook, "claude"], { input: raw ?? JSON.stringify(payload), encoding: "utf8", env: { ...process.env, DESK: DESK } })
  const deny = call({ tool_name: "Bash", tool_input: { command: `echo hi > ${CARD_ABS}` }, cwd: DESK })
  assert.equal(deny.status, 0)
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, "deny")
  const pass = call({ tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: DESK })
  assert.equal(pass.stdout.trim(), "{}")
  const passString = call({ tool_name: "Bash", tool_input: JSON.stringify({ command: "ls" }), cwd: DESK })
  assert.equal(passString.stdout.trim(), "{}")
  const readOnly = call({ tool_name: "Bash", toolArgs: { command: `cat ${CARD_ABS}` }, cwd: DESK })
  assert.equal(readOnly.stdout.trim(), "{}")
  const bad = call(null, "not json")
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /allowing it/)
  const missing = call({ tool_name: "Bash", cwd: DESK })
  assert.equal(missing.stdout.trim(), "{}")
})

test("a desk with no desks/ folder still finds the card a script builds in pieces", () => {
  const plain = realpathSync(mkdtempSync(path.join(tmpdir(), "guard-shell-plain-")))
  try {
    mkdirSync(path.join(plain, "_meta"), { recursive: true })
    mkdirSync(path.join(plain, "ops", "relay-config"), { recursive: true })
    writeFileSync(path.join(plain, "ops", "relay-config", "task.md"), CARD)
    const command = `node -e "const p=require('path').join('ops','relay-config','task.md'); require('fs').writeFileSync(p,'x')"`
    assert.equal(run(command, { cwd: plain, root: plain }).hookSpecificOutput.permissionDecision, "deny")
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})
