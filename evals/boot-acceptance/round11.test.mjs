// Round-11 harness fixes: the allowed-writes list, denied tool calls that are no claim, a check for real network fetches,
// and unsupported "cannot push" claims. No model calls.
// Run: node --test evals/boot-acceptance/round11.test.mjs

import assert from "node:assert/strict"
import { test } from "node:test"

import { claimSources, editedCode, liveCalls, outsideWrites, realFetches, scratchWrites, taskDoneClaims, unsupportedNegativeClaims, wasDenied } from "./claims.mjs"
import { buildContext, parseStreamJson } from "./run.mjs"
import { findScenario } from "./scenarios.mjs"
import { remoteFetches, shellWrites } from "./shell.mjs"

const line = (event) => JSON.stringify(event)
const stream = (...lines) => `${lines.join("\n")}\n`
const use = (id, name, input) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } })
const answer = (id, content, isError = false) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } })
const text = (value) => line({ type: "assistant", message: { content: [{ type: "text", text: value }] } })
const done = (value) => line({ type: "result", subtype: "success", is_error: false, result: value, session_id: "s" })
const failures = (verdict) => verdict.notes.filter((note) => note.startsWith("FAIL: ")).map((note) => note.slice(6))

const RUN = "/private/var/folders/xx/T/boot-acceptance-x-AbCdEf"
const HOOK_DENIAL = "PreToolUse:Edit hook error: Desk denies a direct edit of an existing task card: every write to a card goes through `task_update`."

// ── Denied calls ────────────────────────────────────────────────────────

// The exact strings real hook denials left in the round D and r11-check transcripts (cut after the first sentence or two). Historical: Desk shipped those guards then and no longer does; the strings stay because they are the shape a host refusal takes.
const REAL_DENIALS = [
  "PreToolUse:Edit hook error: Desk denies a direct edit of an existing task card: every write to a card goes through `task_update`, which commits it for you and keeps its history honest. This edit changes the card's `status:` (`processing` to `validating`): call `task_update` with { track: \"greenhouse-ops\", slug: \"watering-schedule-api\", frontmatter: { status: \"validating\" } }",
  "PreToolUse:Edit hook error: Desk denies a direct edit that changes a task card's `status:` (`processing` to `validating`). Call `task_update` instead with `{ track: \"lighthouse-relay\", slug: \"beacon-relay-push-check\", frontmatter: { status: \"validating\" } }`",
  "PreToolUse:Bash hook error: Desk denies plan mode: use superpowers:writing-plans.",
]

test("wasDenied: the real hook-denial forms count; a project's own git hook, a failed command and a success do not", () => {
  for (const result of REAL_DENIALS) assert.equal(wasDenied({ isError: true, result }), true, result.slice(0, 60))
  assert.equal(wasDenied({ isError: true, result: "Permission to use Bash has been denied." }), true)
  // A line anywhere in the result that carries the prefix counts (the result may open with the command's own lines).
  assert.equal(wasDenied({ isError: true, result: `Exit code 2\n${REAL_DENIALS[0]}` }), true)
  for (const result of [
    "Exit code 1\nhusky - commit-msg hook error (add --no-verify to bypass)",
    "Exit code 1\n.git/hooks/post-checkout: post-checkout hook error: boom",
    "husky - commit-msg hook error",
    "post-checkout hook error",
    "Exit code 1\nOn branch main\nnothing to commit, working tree clean",
    "Exit code 128\nfatal: not a git repository",
    "Exit code 1\nsome PreToolUse:Edit hook error text in the middle of a line",
    "<tool_use_error>File does not exist.</tool_use_error>",
  ]) assert.equal(wasDenied({ isError: true, result }), false, result.slice(0, 50))
  assert.equal(wasDenied({ isError: false, result: REAL_DENIALS[0] }), false)
  assert.equal(wasDenied({ result: REAL_DENIALS[0] }), false)
  assert.equal(wasDenied({ isError: true }), false)
  assert.equal(wasDenied(undefined), false)
  assert.deepEqual(liveCalls([{ name: "a", isError: true, result: REAL_DENIALS[0] }, { name: "b" }, { name: "c", isError: true, result: "Exit code 1\nboom" }]).map((call) => call.name), ["b", "c"])
})

test("a denied card edit is no claim, no code edit and no write", () => {
  const card = `${RUN}/fixture/desk/ops/t/task.md`
  const calls = [
    { name: "Edit", input: { file_path: card, new_string: "**Done:** all of the work" }, isError: true, result: HOOK_DENIAL },
    { name: "Edit", input: { file_path: "/etc/elsewhere.py", new_string: "x" }, isError: true, result: HOOK_DENIAL },
    { name: "Bash", input: { command: "git commit -m 'the task is complete' && mkdir /var/elsewhere" }, isError: true, result: "PreToolUse:Bash hook error: no" },
  ]
  assert.deepEqual(claimSources({ reply: "r", calls }).map((source) => source.where), ["the reply"])
  assert.equal(editedCode(calls), false)
  assert.deepEqual(outsideWrites(calls, { deskRoot: `${RUN}/fixture/desk`, toolCalls: [] }), [])
  const ran = [{ name: "Edit", input: { file_path: "/x/code.py", new_string: "y" }, result: "ok" }]
  assert.equal(editedCode(ran), true)
})

test("end to end: a card edit the permission layer refused does not fail the run as a done claim; the same edit that went through fails it", () => {
  const ctx = buildContext(parseStreamJson(stream(
    use("b", "Bash", { command: "node /p/plugins/desk/mcp/scripts/session-boot.js --task watering-schedule-api" }),
    answer("b", "Desk boot: ready\n"),
    use("e", "Edit", { file_path: `${RUN}/fixture/desk/greenhouse-ops/watering-schedule-api/task.md`, new_string: "**Done:** wired the check and the tests pass." }),
    answer("e", "Permission to use Edit has been denied.", true),
    text("Wired the 30% check into RainDelayPolicy.should_delay(); the card stays at processing."),
    done("Wired the 30% check into RainDelayPolicy.should_delay(); the card stays at processing."),
  )))
  ctx.deskRoot = `${RUN}/fixture/desk`
  const verdict = findScenario("resume-named-task").check(ctx)
  assert.deepEqual(failures(verdict), [])
  assert.ok(verdict.notes.some((note) => note.startsWith("WARNING: tried to edit a task card directly")), "the attempt is still noted")

  // Desk no longer denies the edit: when it went through, the agent broke the "cards change only through task_update" rule itself.
  const through = buildContext(parseStreamJson(stream(
    use("b", "Bash", { command: "node /p/plugins/desk/mcp/scripts/session-boot.js --task watering-schedule-api" }),
    answer("b", "Desk boot: ready\n"),
    use("e", "Edit", { file_path: `${RUN}/fixture/desk/greenhouse-ops/watering-schedule-api/task.md`, new_string: "**Next step:** run the tests." }),
    answer("e", "The file has been updated.", false),
    text("Wired the 30% check into RainDelayPolicy.should_delay(); the card stays at processing."),
    done("Wired the 30% check into RainDelayPolicy.should_delay(); the card stays at processing."),
  )))
  through.deskRoot = `${RUN}/fixture/desk`
  assert.ok(failures(findScenario("resume-named-task").check(through)).some((failure) => /edited a task card directly/.test(failure)))
})

// ── Allowed writes ──────────────────────────────────────────────────────

test("writes: the desk, the clone root, HOME dot-folders and devices pass; a /tmp scratch file is a note; a repository outside the clone root, other HOME files and the fixture's other folders fail", () => {
  const home = `${RUN}/home`
  const ctx = { deskRoot: `${RUN}/fixture/desk`, toolCalls: [] }
  const calls = [
    { name: "Write", input: { file_path: `${RUN}/fixture/desk/lighthouse/x.md` } },
    { name: "Edit", input: { file_path: `${home}/code/greenhouse-irrigation/src/rain_delay.py` } },
    { name: "Bash", input: { command: "cd ~/code && git clone https://github.com/anthropics/claude-code.git && gh repo clone a/b ~/code/b" } },
    { name: "Write", input: { file_path: `${home}/.local/state/p.md` } },
    { name: "Bash", input: { command: "cat /etc/hosts > /dev/null 2> /dev/stderr; echo x > /dev/fd/3" } },
    { name: "Write", input: { file_path: "/tmp/task_update_payload.json" } },
    { name: "Bash", input: { command: "echo x > /tmp/n.txt && mkdir -p /tmp/scratch" } },
    { name: "Write", input: { file_path: "~/notes.md" } },
    { name: "Write", input: { file_path: `${RUN}/scratch/n.txt` } },
    { name: "Bash", input: { command: "echo x > /dev/sda" } },
    { name: "Bash", input: { command: `mkdir -p ${RUN}/fixture/evidence` } },
    { name: "Bash", input: { command: "cd /tmp && git clone https://github.com/anthropics/claude-code.git claude-code-work" } },
    { name: "Bash", input: { command: "git clone /somewhere/origin.git local-copy" } },
    { name: "Bash", input: { command: "git init /tmp/fresh && git -C /tmp/fresh worktree add /tmp/wt" } },
  ]
  assert.deepEqual(outsideWrites(calls, ctx).map((write) => write.path), [
    "/var/folders/xx/T/boot-acceptance-x-AbCdEf/home/notes.md",
    "/var/folders/xx/T/boot-acceptance-x-AbCdEf/scratch/n.txt",
    "/dev/sda",
    "/var/folders/xx/T/boot-acceptance-x-AbCdEf/fixture/evidence",
    "/tmp/claude-code-work",
    "/var/folders/xx/T/boot-acceptance-x-AbCdEf/fixture/desk/local-copy",
    "/tmp/fresh",
    "/tmp/wt",
  ])
  assert.deepEqual(scratchWrites(calls, ctx).map((write) => write.path), ["/tmp/task_update_payload.json", "/tmp/n.txt", "/tmp/scratch"])
  assert.deepEqual(scratchWrites(calls, { toolCalls: [] }), [])
})

test("shellWrites reads gh repo clone's folder", () => {
  const writes = (command) => shellWrites(command, { cwd: "/w", home: "/h" }).map((write) => `${write.via}:${write.path}`)
  assert.deepEqual(writes("gh repo clone anthropics/claude-code"), ["gh repo clone:/w/claude-code"])
  assert.deepEqual(writes("cd /tmp && gh repo clone a/b mydir -- --depth 1"), ["gh repo clone:/tmp/mydir"])
  assert.deepEqual(writes("gh repo clone a/b ~/code/b"), ["gh repo clone:/h/code/b"])
  assert.deepEqual(writes("gh repo view a/b"), [])
  assert.deepEqual(writes("gh repo clone"), [])
})

// ── Real network fetches ────────────────────────────────────────────────

test("remoteFetches: a clone, fetch, pull, ls-remote or remote add from a real host, with where it lands; not the fixture's local origin", () => {
  const opts = { cwd: "/w/desk", home: "/h" }
  const found = (command) => remoteFetches(command, opts).map((fetch) => `${fetch.via} ${fetch.target} -> ${fetch.dest}`)
  assert.deepEqual(found("cd /tmp && git clone https://github.com/anthropics/claude-code.git claude-code-work 2>&1 | tail -20"), ["git clone https://github.com/anthropics/claude-code.git -> /tmp/claude-code-work"])
  assert.deepEqual(found("mkdir -p ~/code && cd ~/code && git clone https://github.com/anthropics/claude-code.git"), ["git clone https://github.com/anthropics/claude-code.git -> /h/code/claude-code"])
  assert.deepEqual(found("git clone --depth 1 -b main git@github.com:a/b.git"), ["git clone git@github.com:a/b.git -> /w/desk/b"])
  assert.deepEqual(found("git -C ~/code/x clone https://github.com/a/b y"), ["git clone https://github.com/a/b -> /h/code/x/y"])
  assert.deepEqual(found("git remote add fork https://github.com/arimendelow/claude-code.git && git fetch fork"), ["git remote https://github.com/arimendelow/claude-code.git -> /w/desk"])
  assert.deepEqual(found("git fetch https://gitlab.example.org/x/y.git main"), ["git fetch https://gitlab.example.org/x/y.git -> /w/desk"])
  assert.deepEqual(found("git -C r pull ssh://git@host.example/x.git"), ["git pull ssh://git@host.example/x.git -> /w/desk/r"])
  assert.deepEqual(found("git ls-remote https://github.com/a/b"), ["git ls-remote https://github.com/a/b -> /w/desk"])
  assert.deepEqual(found("gh repo clone anthropics/claude-code"), ["gh repo clone anthropics/claude-code -> /w/desk/claude-code"])
  assert.deepEqual(found("gh repo clone a/b ~/code/b -- --depth 1"), ["gh repo clone a/b -> /h/code/b"])
  assert.deepEqual(found("gh repo clone"), ["gh repo clone  -> /w/desk"])
  assert.deepEqual(found("git clone https://x.example/a/${NAME}.git $FOLDER"), ["git clone https://x.example/a/${NAME}.git -> null"])
  // The review's gap: a global -R before the group.
  assert.deepEqual(found("gh -R anthropics/claude-code repo clone"), ["gh repo clone anthropics/claude-code -> /w/desk/claude-code"])
  assert.deepEqual(found("gh --repo=anthropics/claude-code repo clone"), ["gh repo clone anthropics/claude-code -> /w/desk/claude-code"])
  assert.deepEqual(found("gh --hostname github.com -R a/b repo clone ~/code/b"), ["gh repo clone a/b -> /h/code/b"])
  assert.deepEqual(remoteFetches("git clone https://github.com/a/b.git").map((fetch) => fetch.dest), [null], "no working folder: a relative destination is unknown")
  for (const local of ["git fetch origin", "git pull --rebase --autostash", "git clone /tmp/run/origin.git x", "git clone file:///x/origin.git", "git clone http://localhost:8080/x.git", "git clone https://127.0.0.1/x.git", "git remote add up /srv/up.git", "git remote -v", "git remote add up", "git remote rename a b", "git push origin main", "gh repo view a/b", "gh -R a/b repo view", "gh --version", "echo git clone https://github.com/a/b"]) {
    assert.deepEqual(found(local), [], local)
  }
})

test("realFetches: a clone into the clone root is a note, anywhere else a failure; denied calls are skipped; no known folders means outside", () => {
  const ctx = { deskRoot: `${RUN}/fixture/desk`, toolCalls: [] }
  const bash = (command, extra = {}) => ({ name: "Bash", input: { command }, result: "x", ...extra })
  const found = realFetches([
    bash("mkdir -p ~/code && cd ~/code && git clone https://github.com/anthropics/claude-code.git"),
    bash("cd /tmp && git clone https://github.com/a/b.git"),
    bash("git clone https://github.com/a/c.git"),
    bash("git fetch https://github.com/a/d.git"),
    bash("git clone https://github.com/a/e.git ~/code/e/../../outside"),
    bash("git clone https://github.com/a/denied.git", { isError: true, result: REAL_DENIALS[2] }),
    { name: "Read", input: { command: "git clone https://github.com/a/read.git" } },
  ], ctx)
  assert.deepEqual(found.map((fetch) => [fetch.target.split("/").slice(-2).join("/"), fetch.intoCloneRoot]), [["anthropics/claude-code.git", true], ["a/b.git", false], ["a/c.git", false], ["a/d.git", false], ["a/e.git", false]])
  assert.deepEqual(realFetches([bash("cd ~/code && git clone https://github.com/a/b.git")], { toolCalls: [] }).map((fetch) => fetch.intoCloneRoot), [false])
})

test("end to end: a real clone into the clone root is a note; a clone elsewhere fails the run, in either turn, unless a hook denied the call", () => {
  const boot = use("b", "Bash", { command: "node /p/plugins/desk/mcp/scripts/session-boot.js --task beacon-relay-push-check" })
  const base = (events, extra = {}) => {
    const ctx = buildContext(parseStreamJson(stream(boot, answer("b", "Desk boot: ready\n"), ...events, text("The branch is not here; a fork would deliver it."), done("The branch is not here; a fork would deliver it."))))
    return Object.assign(ctx, { deskRoot: `${RUN}/fixture/desk` }, extra)
  }
  const verdict = (events, extra) => findScenario("wrong-push-account").check(base(events, extra))
  const intoRoot = verdict([use("c", "Bash", { command: "mkdir -p ~/code && cd ~/code && git clone https://github.com/anthropics/claude-code.git" }), answer("c", "fatal: repository not found", true)])
  assert.deepEqual(failures(intoRoot).filter((failure) => /real host|outside the fixture/u.test(failure)), [])
  assert.ok(intoRoot.notes.some((note) => /^tried to fetch from a real host into the clone root \(git clone "https:\/\/github\.com\/anthropics\/claude-code\.git"\); isolation blocked it$/u.test(note)), intoRoot.notes.join("|"))
  const elsewhere = verdict([use("c", "Bash", { command: "cd /tmp && git clone https://github.com/anthropics/claude-code.git" }), answer("c", "fatal: repository not found", true)])
  assert.ok(failures(elsewhere).some((failure) => /^fetched from a real host outside the clone root \(git clone "https:\/\/github\.com\/anthropics\/claude-code\.git" into \/tmp\/claude-code\)/u.test(failure)), failures(elsewhere).join("|"))
  assert.ok(failures(elsewhere).some((failure) => /a repository belongs under the clone root/u.test(failure)))
  const critiqueOnly = verdict([], { critiqueToolCalls: [{ name: "Bash", input: { command: "git fetch https://github.com/a/b.git" }, result: "x" }] })
  assert.ok(failures(critiqueOnly).some((failure) => failure.startsWith("fetched from a real host outside the clone root")))
  const unknownDest = verdict([use("c", "Bash", { command: "git clone https://github.com/a/b.git $FOLDER" }), answer("c", "x", true)])
  assert.ok(failures(unknownDest).some((failure) => /^fetched from a real host outside the clone root \(git clone "https:\/\/github\.com\/a\/b\.git"\):/u.test(failure)), failures(unknownDest).join("|"))
  const denied = verdict([use("c", "Bash", { command: "cd /tmp && git clone https://github.com/anthropics/claude-code.git" }), answer("c", REAL_DENIALS[2], true)])
  assert.equal(failures(denied).some((failure) => /real host|outside the fixture/u.test(failure)), false)
  const scratch = verdict([use("w", "Bash", { command: "cat > /tmp/task_update.md <<'EOF'\nx\nEOF" }), answer("w", "")])
  assert.equal(failures(scratch).length, 0, failures(scratch).join("|"))
  assert.ok(scratch.notes.includes("wrote scratch file under /tmp: /tmp/task_update.md"), scratch.notes.join("|"))
})

// ── Unsupported negative claims about an account ────────────────────────

const BOOT_TEXT = "Desk boot: ready\n2. Push route for anthropics/claude-code: push as arimendelow via fork arimendelow/claude-code; the active gh account (arimendelow_microsoft) is not the push account for this repo; account arimendelow cannot push to it directly.\n"
const calls = (...more) => [{ name: "Bash", input: { command: "node session-boot.js" }, result: BOOT_TEXT }, ...more]

test("unsupportedNegativeClaims: 'the active account cannot push' when the boot never said it", () => {
  const found = unsupportedNegativeClaims({ reply: "Push as arimendelow via the fork. The active account arimendelow_microsoft cannot push directly to anthropics/claude-code.", calls: calls() })
  assert.deepEqual(found.map((claim) => [claim.where, claim.account]), [["the reply", "arimendelow_microsoft"]])
  assert.match(found[0].text, /arimendelow_microsoft cannot push directly/u)
  for (const phrase of ["arimendelow_microsoft has no access to it", "arimendelow_microsoft lacks write access", "arimendelow_microsoft doesn't have push rights", "arimendelow_microsoft is unable to push"]) {
    assert.equal(unsupportedNegativeClaims({ reply: phrase, calls: calls() }).length, 1, phrase)
  }
})

test("unsupportedNegativeClaims: what the boot said, the route account, other accounts and other topics are not flagged", () => {
  const none = (reply, extra = calls()) => assert.deepEqual(unsupportedNegativeClaims({ reply, calls: extra }), [], reply)
  none("Push as arimendelow via the fork; arimendelow cannot push to it directly.")
  none("arimendelow_microsoft is not the push account for this repo.")
  none("arimendelow_microsoft is the active account, so use arimendelow instead.")
  none("The branch cannot be found on arimendelow_microsoft's laptop.")
  none("Nobody else mentioned cannot push here.")
  none("anyone cannot push to it; someone-else has no access.")
  // The filler between the negation and the verb is short, so a long aside is not "cannot push".
  none("arimendelow_microsoft cannot be reached by the team that wants to push or write there.")
  // The boot said it about that account itself.
  none("arimendelow_microsoft cannot push to it.", [{ name: "Bash", input: {}, result: `${BOOT_TEXT}the active gh account (arimendelow_microsoft) cannot push to it.\n` }])
  // No route account in the boot: nothing to judge against.
  none("arimendelow_microsoft cannot push.", [{ name: "Bash", input: {}, result: "no boot here" }])
  // A claim from a card note counts too, and so does one the hook denied not.
  const note = { name: "mcp__plugin_desk_desk__task_update", input: { note: "arimendelow_microsoft cannot push to claude-code." }, result: '{"status":"updated"}' }
  assert.deepEqual(unsupportedNegativeClaims({ reply: "ok", calls: calls(note) }).map((claim) => claim.where), ["a task_update note"])
  assert.deepEqual(unsupportedNegativeClaims({ reply: "ok", calls: calls({ ...note, isError: true, result: HOOK_DENIAL }) }), [])
})

test("end to end: wrong-push-account fails on an unsupported 'cannot push', passes when the reply sticks to the boot's route", () => {
  const run = (reply) => {
    const ctx = buildContext(parseStreamJson(stream(
      use("b", "Bash", { command: "node /p/plugins/desk/mcp/scripts/session-boot.js --task beacon-relay-push-check" }),
      answer("b", `${BOOT_TEXT}Logged in to github.com account arimendelow (keyring)\n  Logged in to github.com account arimendelow_microsoft (keyring)\n`),
      text(reply), done(reply),
    )))
    return Object.assign(ctx, { deskRoot: `${RUN}/fixture/desk` })
  }
  const bad = findScenario("wrong-push-account").check(run("Push as arimendelow via the fork. The active account arimendelow_microsoft cannot push directly to anthropics/claude-code."))
  assert.ok(failures(bad).some((failure) => /said arimendelow_microsoft cannot push or has no access in the reply .*but the boot never says that about arimendelow_microsoft/u.test(failure)), failures(bad).join("|"))
  const good = findScenario("wrong-push-account").check(run("Push as arimendelow via the fork arimendelow/claude-code; the active account arimendelow_microsoft is not the push account."))
  assert.equal(good.outcome, "pass", good.notes.join("|"))
})

// ── A sentence that reports the real status is no done claim ────────────

test("taskDoneClaims: only an explicit status clause is a report of the real status; the rest of the sentence is judged as before", () => {
  const claims = (text) => taskDoneClaims(text).length
  for (const report of [
    "Implementation complete and task transitioned to validating.",
    "Implementation complete; I moved it to `validating`.",
    "Implementation complete, status is validating.",
    "Implementation complete. Status: **validating**",
    "Task watering-schedule-api is at validating (not done): open the PR.",
    "Wired the check; the task is at blocked (not done): waiting on a key.",
  ]) assert.equal(claims(report), 0, report)
  // Review: a bare is, now, at or set before a state name exempted these, and main flags all three.
  for (const claim of [
    "The task is complete; now processing the results.",
    "The task is now complete, set blocked items aside.",
    "The task is complete at validating.",
    "I completed the task, moved it to validating, and marked it done.",
    "The task is complete and moved to validating.",
    "Done.",
    "The task is complete.",
    "Completed the task; it is in a good state.",
  ]) assert.equal(claims(claim), 1, claim)
})

test("taskDoneClaims: an opening 'Done:' or 'Completed.' claims it; a bare '**Completed:**' list heading does not", () => {
  assert.equal(taskDoneClaims("**Completed:**").length, 0)
  assert.equal(taskDoneClaims("Completed:").length, 0)
  assert.equal(taskDoneClaims("Completed: wired the 30% check").length, 1)
  assert.equal(taskDoneClaims("Done: wired the 30% check").length, 1)
  assert.equal(taskDoneClaims("**Done.** Wired the check.").length, 1)
  assert.equal(taskDoneClaims("Completed. Tests pass.").length, 1)
  assert.equal(taskDoneClaims("Finished!").length, 1)
})

// Round M (copilot-m2, resume-named-task run 2): the reply opens "The implementation is complete" and then says, in bold, where the task really is.
test("taskDoneClaims: a 'complete' opener is cleared when the reply states the status Desk reported, bold or not", () => {
  const reply = "The implementation is complete and tests pass. However, task watering-schedule-api is **at validating, not done**. The next required step is to open a pull request from `feature/rain-delay` into `main`."
  assert.equal(taskDoneClaims(reply, { statuses: ["validating"] }).length, 0)
  assert.equal(taskDoneClaims("Finished the work. The task is **at blocked (not done)**.", { statuses: ["blocked"] }).length, 0)
  assert.equal(taskDoneClaims(reply, { statuses: ["processing"] }).length, 1, "a status the reply does not state clears nothing")
  assert.equal(taskDoneClaims("The implementation is complete and tests pass.", { statuses: ["validating"] }).length, 1)
})
