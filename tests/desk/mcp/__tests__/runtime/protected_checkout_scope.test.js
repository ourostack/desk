// A3b: the protected-checkout guard keeps HEAD on the state branch and keeps other sessions'
// work, but never blocks the desk's own write protocol (add, commit, pull, push on main), and
// fails closed on an unresolvable command only when that command could reach Git.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { guardShellCommand, pathForms, protectCheckout, protectedCheckoutHook } from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout.js"
import { classifyGit, MESSAGES } from "../../../../../plugins/desk/mcp/src/runtime/git-guard-policy.js"
import { hasOption, parseGitOptions, SPECS } from "../../../../../plugins/desk/mcp/src/runtime/git-guard-options.js"
import { mayInvokeGit, UNKNOWN, protectedDenial } from "../../../../../plugins/desk/mcp/src/runtime/guard-unknowns.js"
import { existingDirectory, lexicalDirectory, mktempPath, gitDirectoryFor, physicalDirectory, processDirectory, processDirectoryFor } from "../../../../../plugins/desk/mcp/src/runtime/shell-paths.js"
import { removeFixtureAfter } from "../_process_hygiene.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "protected-checkout.cjs")
const q = (text) => `'${text.replaceAll("'", "'\\''")}'`
const psq = (text) => `'${text.replaceAll("'", "''")}'`
const pwsh = !spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).error

// A bare origin, a protected desk clone on main whose state branch is recorded, and an ordinary clone.
function desk(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "desk-guard-scope-")))
  removeFixtureAfter(t, root)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG_(?:COUNT|KEY_|VALUE_))/u.test(key)) delete env[key]
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  const origin = path.join(root, "origin.git"), shared = path.join(root, "desk"), own = path.join(root, "own")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env })
  execFileSync("git", ["init", "-q", "-b", "main", shared], { env })
  writeFileSync(path.join(shared, "file.txt"), "base\n")
  git(shared, "add", "file.txt")
  git(shared, "commit", "-qm", "first")
  git(shared, "branch", "topic")
  writeFileSync(path.join(shared, "file.txt"), "second\n")
  git(shared, "commit", "-qam", "second")
  git(shared, "tag", "v1")
  git(shared, "remote", "add", "origin", origin)
  git(shared, "push", "-q", "-u", "origin", "main")
  execFileSync("git", ["clone", "-q", origin, own], { env })
  return {
    root, origin, shared, own, env, git,
    guard: (command, extra = {}) => guardShellCommand({ command, cwd: own, env, ...extra }),
  }
}

// Each Git argument list is checked in three spellings that target the protected checkout.
function forms(f, args) {
  return [
    [`cd ${q(f.shared)} && git ${args}`, {}],
    [`git -C ${q(f.shared)} ${args}`, {}],
    // A bare @ is a PowerShell parse error, so the PowerShell spelling quotes it.
    [`Set-Location ${psq(f.shared)}; git ${args.replace(/(?<=^| )@(?= |$)/u, "'@'")}`, { powershell: true }],
  ]
}

async function expectTable(f, rows) {
  for (const [args, expected] of rows) {
    for (const [command, extra] of forms(f, args)) {
      const result = await f.guard(command, extra)
      const message = `${extra.powershell ? "PowerShell" : "Bash"}: ${command} -> ${result.reason ?? "allowed"}`
      if (expected === false) assert.equal(result.deny, false, message)
      else assert.equal(result.reason, protectedDenial(f.shared, expected), message)
    }
    // Unprotected checkouts are never affected.
    assert.equal((await f.guard(`git ${args}`)).deny, false, `unprotected: ${args}`)
  }
}

test("A3b: the desk write protocol and read-only Git pass in a protected checkout on its state branch", async (t) => {
  const f = desk(t)
  await protectCheckout({ root: f.shared, stateBranch: "main" })
  assert.equal(f.git(f.shared, "config", "--includes", "--get", "desk.stateBranch"), "main")
  await expectTable(f, [
    "status", "status --short", "log -1", "diff", "diff --cached", "show HEAD", "fetch", "fetch origin", "rev-parse HEAD",
    "ls-files", "branch", "branch -a", "branch --list", "branch -vv", "remote -v", "config --get user.name", "tag v2",
    "add file.txt", "add -A", "rm --cached file.txt", "mv file.txt moved.txt", "commit -m note", "commit -am note",
    "commit --allow-empty -m 'checkpoint'", "cherry-pick topic", "revert --no-edit HEAD",
    "push", "push origin", "push origin main", "push -u origin main", "push origin HEAD", "push origin @", "push origin HEAD:main",
    "push origin main:refs/heads/main", "push origin v1", "push origin refs/tags/v1", "push origin tag v1", "push --tags",
    "push --follow-tags origin main", "push --no-force origin main",
    "pull", "pull --rebase", "pull --ff-only", "pull -r", "pull --no-rebase", "pull origin", "pull origin main",
    "pull --rebase origin main", "pull origin refs/heads/main", "pull origin +main",
    "merge --ff-only origin/main", "merge --ff-only topic", "merge --no-ff --ff-only topic", "merge --abort", "merge --continue", "merge --quit",
    "rebase", "rebase origin/main", "rebase '@{u}'", "rebase --keep-base origin/main", "rebase -i origin/main", "rebase origin/main main",
    "rebase --continue", "rebase --abort", "rebase --skip",
    "worktree add --detach ../wt HEAD", "worktree add -b feature ../wt2", "worktree add -B feature ../wt3", "worktree list",
    "worktree lock ../wt", "worktree prune --dry-run", "stash list", "stash show",
    "checkout", "switch", "checkout main", "switch main", "checkout -- file.txt", "checkout missing-path", "checkout HEAD -- file.txt", "checkout topic file.txt", "restore file.txt",
    "restore --worktree file.txt", "restore --source=HEAD --no-source file.txt", "restore --source HEAD file.txt", "restore -s HEAD~1 file.txt", "restore -SW file.txt", "restore --source=HEAD~1 file.txt",
    "reset --soft HEAD", "reset --soft", "fetch origin main", "fetch origin main:refs/remotes/origin/main", "config user.name Fixture",
    "config --get remote.origin.url", "config get remote.origin.url", "config --list", "config remote.origin.url",
    "branch newbranch", "branch -d topic", "branch -D topic", "branch -f topic HEAD", "branch -m topic renamed", "branch -m",
    "branch -c copy", "branch -C topic copy", "branch -u origin/main", "branch -r -d origin/main",
    // Narrowed 2026-09-27: path-limited unstaging, merges, merge-mode pulls and non-force pushes of any name move no HEAD and rewrite nothing pushed.
    "reset -- file.txt", "reset HEAD file.txt", "reset HEAD~1 file.txt", "reset missing-path", "reset --pathspec-from-file=list",
    "restore --staged file.txt", "restore -S file.txt", "restore --sta file.txt",
    "merge topic", "merge origin/main", "merge --no-ff origin/main", "merge --ff-only --no-ff topic",
    // Ruled 2026-09-27: --autostash re-applies within the same command, pruning worktree records discards no work, and deleting a branch other than the state branch on the remote rewrites nothing the checkout tracks.
    "rebase --autostash", "pull --autostash", "pull --rebase --autost", "merge --ff-only --autostash topic", "merge --autostash topic",
    "worktree prune", "push --delete origin topic", "push -d origin topic", "push origin :topic", "push origin :",
    "pull --no-rebase origin topic", "pull --no-rebase upstream main", "pull --rebase=false origin topic",
    "push --all", "push --branches", "push origin topic", "push origin HEAD:topic", "push origin main:topic", "push origin 'refs/heads/*:refs/heads/*'",
    "bisect log", "merge -h", "clean -h", "stash --help", "--version", "help",
  ].map((args) => [args, false]))
})

test("A3b: every operation that moves HEAD, rewinds the branch or discards others' work is denied with its reason", async (t) => {
  const f = desk(t)
  await protectCheckout({ root: f.shared, stateBranch: "main" })
  await expectTable(f, [
    ["checkout topic", MESSAGES.leave], ["checkout v1", MESSAGES.leave], ["checkout HEAD~1", MESSAGES.leave],
    ["checkout --detach", MESSAGES.leave], ["checkout -b new", MESSAGES.leave], ["checkout -B main", MESSAGES.leave],
    ["checkout --orphan new", MESSAGES.leave], ["checkout -", MESSAGES.leave], ["checkout origin/main", MESSAGES.leave],
    ["checkout .", MESSAGES.restore], ["checkout HEAD -- .", MESSAGES.restore], ["checkout topic :/", MESSAGES.restore], ["checkout -- ..", MESSAGES.restore],
    ["checkout --pathspec-from-file=list HEAD", MESSAGES.restore], ["checkout -f", MESSAGES.discard], ["checkout -f main", MESSAGES.discard],
    ["switch topic", MESSAGES.leave], ["switch -c new", MESSAGES.leave], ["switch -C main", MESSAGES.leave], ["switch --detach HEAD", MESSAGES.leave],
    ["switch -", MESSAGES.leave], ["switch --orphan new", MESSAGES.leave], ["switch -f main", MESSAGES.discard],
    ["switch --discard-changes main", MESSAGES.discard],
    ["reset --hard", MESSAGES.discard], ["reset --hard HEAD", MESSAGES.discard], ["reset --merge", MESSAGES.discard],
    ["reset --keep HEAD", MESSAGES.discard], ["reset --soft --hard", MESSAGES.discard], ["reset --har", MESSAGES.discard],
    ["reset", MESSAGES.unstage], ["reset HEAD", MESSAGES.unstage], ["reset --hard --mixed", MESSAGES.unstage], ["reset -p", MESSAGES.unstage],
    ["reset HEAD~1", MESSAGES.rewind], ["reset --soft HEAD~1", MESSAGES.rewind], ["reset topic", MESSAGES.rewind], ["reset HEAD~1 --", MESSAGES.rewind],
    ["restore --source HEAD .", MESSAGES.restore], ["restore -s HEAD~1 :/", MESSAGES.restore],
    ["restore --staged --worktree .", MESSAGES.restore], ["restore -SW :/", MESSAGES.restore], ["restore --source=HEAD~1 -- .", MESSAGES.restore],
    ["clean -n", MESSAGES.clean], ["clean -fd", MESSAGES.clean], ["clean -fdx", MESSAGES.clean],
    ["stash", MESSAGES.stash], ["stash push", MESSAGES.stash], ["stash -u", MESSAGES.stash], ["stash pop", MESSAGES.stash],
    ["stash apply", MESSAGES.stash], ["stash drop", MESSAGES.stash], ["stash clear", MESSAGES.stash], ["stash save note", MESSAGES.stash],
    ["branch -f main HEAD~1", MESSAGES.branch], ["branch --force refs/heads/main", MESSAGES.branch], ["branch -D main", MESSAGES.branch],
    ["branch -d main", MESSAGES.branch], ["branch --delete main", MESSAGES.branch], ["branch -m renamed", MESSAGES.branch],
    ["branch -M main other", MESSAGES.branch], ["branch -M topic main", MESSAGES.branch], ["branch -C topic main", MESSAGES.branch],
    ["branch -c main", MESSAGES.branch],
    ["rebase topic", MESSAGES.rebase], ["rebase -", MESSAGES.rebase], ["rebase HEAD~1", MESSAGES.rebase], ["rebase --onto topic main", MESSAGES.rebase],
    ["rebase --root", MESSAGES.rebase], ["rebase -x true", MESSAGES.rebase], ["rebase --exec=true", MESSAGES.rebase],
    ["rebase --quit", MESSAGES.rebase], ["rebase origin/main topic", MESSAGES.leave],
    ["pull --rebase origin topic", MESSAGES.pull], ["pull -r upstream main", MESSAGES.pull], ["pull --rebase origin main:main", MESSAGES.pull],
    ["push --force", MESSAGES.pushForce], ["push -f", MESSAGES.pushForce], ["push --force-w", MESSAGES.pushForce],
    ["push --force-with-lease", MESSAGES.pushForce], ["push --force-with-lease=main", MESSAGES.pushForce],
    ["push --force-if-includes", MESSAGES.pushForce], ["push --mirror", MESSAGES.pushForce], ["push --delete origin main", MESSAGES.pushForce],
    ["push -d origin main", MESSAGES.pushForce], ["push --prune origin", MESSAGES.pushForce], ["push origin +main", MESSAGES.pushForce],
    ["push origin :main", MESSAGES.pushForce], ["push origin :refs/heads/main", MESSAGES.pushForce], ["push -uf origin main", MESSAGES.pushForce],
    ["push --all --force", MESSAGES.pushForce],
    ["commit --amend -m note", MESSAGES.amend], ["commit --amend --no-edit", MESSAGES.amend],
    ["worktree add -B main ../wt3", MESSAGES.branch],
    ["bisect start", MESSAGES.leave], ["bisect reset", MESSAGES.leave],
  ])
})

test("A3b: pull, rebase and amend depend on the state branch and on what is already pushed", async (t) => {
  const f = desk(t)
  await protectCheckout({ root: f.shared, stateBranch: "main" })
  const at = (args) => f.guard(`git -C ${q(f.shared)} ${args}`)
  // An unpushed commit may be amended; a pushed one may not.
  f.git(f.shared, "commit", "-q", "--allow-empty", "-m", "local")
  assert.equal((await at("commit --amend -m local")).deny, false)
  f.git(f.shared, "reset", "-q", "--hard", "origin/main")
  assert.equal((await at("commit --amend -m pushed")).reason, protectedDenial(f.shared, MESSAGES.amend))
  // Off the state branch, a merge-mode pull passes, a rebase with no upstream of its own is denied, and returning to the state branch passes.
  f.git(f.shared, "switch", "-q", "topic")
  for (const [args, reason] of [["pull", null], ["pull --no-rebase origin main", null], ["pull --rebase", MESSAGES.noUpstream], ["rebase", MESSAGES.noUpstream], ["checkout topic", null], ["switch main", null], ["checkout main", null], ["push origin topic", null], ["branch -f topic HEAD", MESSAGES.branch]]) {
    const result = await at(args)
    assert.equal(result.reason, reason === null ? undefined : protectedDenial(f.shared, reason), args)
  }
  // An operator-set marker without a recorded state branch treats the current branch as the state branch.
  await protectCheckout({ root: f.shared })
  assert.equal(spawnSync("git", ["-C", f.shared, "config", "--includes", "--get", "desk.stateBranch"], { env: f.env }).status, 1)
  // topic has no upstream, so there is nothing of its own to pull or rebase onto.
  assert.equal((await at("pull")).deny, false, "a merge-mode pull moves no HEAD")
  assert.equal((await at("pull --rebase")).reason, protectedDenial(f.shared, MESSAGES.noUpstream))
  assert.equal((await at("rebase")).reason, protectedDenial(f.shared, MESSAGES.noUpstream))
  assert.equal((await at("rebase origin/main")).reason, protectedDenial(f.shared, MESSAGES.noUpstream), "topic has no upstream")
  assert.equal((await at("pull --rebase origin topic")).reason, protectedDenial(f.shared, MESSAGES.noUpstream), "topic has no upstream")
  assert.equal((await at("pull origin topic")).deny, false, "a merge-mode pull of any branch moves no HEAD")
  // A detached protected checkout pulls, rebases and pushes nothing by name.
  f.git(f.shared, "switch", "-q", "--detach", "HEAD")
  for (const [args, reason] of [["pull --rebase", MESSAGES.noUpstream], ["rebase", MESSAGES.noUpstream], ["push origin HEAD:main", null], ["push origin HEAD", null], ["push --force origin HEAD:main", MESSAGES.pushForce], ["checkout HEAD", MESSAGES.leave]]) {
    const result = await at(args)
    assert.equal(result.reason, reason === null ? undefined : protectedDenial(f.shared, reason), args)
  }
})

test("A3b: the reported desk commands pass the registered hooks and then run for real on main", async (t) => {
  const f = desk(t)
  await protectCheckout({ root: f.shared, stateBranch: "main" })
  // Another session pushes first, so pull --rebase has work to do.
  writeFileSync(path.join(f.own, "other.txt"), "other session\n")
  f.git(f.own, "add", "other.txt")
  f.git(f.own, "commit", "-qm", "other session")
  f.git(f.own, "push", "-q", "origin", "main")
  const bash = [
    `git add file.txt && git commit -qm 'desk state' && git pull -q --rebase && git push -q`,
    `git add -A; git commit -qm "stamp $(date +%s)"; git pull -q --rebase origin main; git push -q origin main`,
  ]
  const powershell = [`git add file.txt; git commit -qm 'desk state (pwsh)'; git pull -q --rebase; git push -q`]
  const run = (command, shell) => {
    for (const host of ["claude", "copilot"]) {
      for (const child of [false, true]) {
        const tool = shell === "pwsh" ? (host === "claude" ? "PowerShell" : "powershell") : (host === "claude" ? "Bash" : "bash")
        const input = host === "claude" ? { tool_name: tool, tool_input: { command }, cwd: f.shared, agent_id: child ? "child" : undefined }
          : { toolName: tool, toolArgs: { command }, cwd: f.shared, agentId: child ? "child" : undefined }
        const result = spawnSync(process.execPath, [hook, host], { cwd: f.shared, env: f.env, input: JSON.stringify(input), encoding: "utf8" })
        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(JSON.parse(result.stdout), {}, `${host}: ${command}`)
      }
    }
    const args = shell === "pwsh" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] : ["--noprofile", "--norc", "-c", command]
    const actual = spawnSync(shell, args, { cwd: f.shared, env: f.env, encoding: "utf8" })
    assert.equal(actual.status, 0, actual.stderr)
    assert.equal(f.git(f.shared, "symbolic-ref", "--short", "HEAD"), "main")
    assert.equal(f.git(f.shared, "rev-parse", "HEAD"), f.git(f.origin, "rev-parse", "main"))
  }
  for (const [index, command] of bash.entries()) {
    writeFileSync(path.join(f.shared, "file.txt"), `bash ${index}\n`)
    run(command, "bash")
  }
  if (pwsh) {
    writeFileSync(path.join(f.shared, "file.txt"), "pwsh\n")
    run(powershell[0], "pwsh")
  } else t.diagnostic("native PowerShell unavailable; the PowerShell hook payloads were still inspected below")
  for (const command of powershell) assert.deepEqual(await protectedCheckoutHook({ tool_name: "PowerShell", tool_input: { command }, cwd: f.shared }, "claude"), {})
  assert.match(readFileSync(path.join(f.shared, "other.txt"), "utf8"), /other session/u)
})

test("A3b: commands with no path to Git pass even when a value is unknown", async (t) => {
  const f = desk(t)
  await protectCheckout({ root: f.shared, stateBranch: "main" })
  const env = { ...f.env, TMPDIR: f.root }
  // A repository alias is expanded; an alias named after a Git command never is.
  f.git(f.shared, "config", "alias.co", "checkout")
  f.git(f.shared, "config", "alias.stage", "stash")
  assert.equal((await f.guard("git stash", { cwd: path.join(f.root, "absent") })).deny, false, "a missing directory runs no Git")
  const allow = [
    'echo "$(date)"', "echo `date`", 'echo "$(printf x)"', 'cd "$(date; hostname)" && git status', 'x=$(date); echo "$x"', 'wt=$(mktemp -d); cd "$wt" && node x.js', 'cd "$wt" && node x.js',
    "jq . a.json | grep x", '"$(npm bin)/tsc" --build', 'cd "$(pick)" && git commit -m x', 'cd "$(pick)" && git status',
    'git log --since="$(date)"', 'git commit -m "$(cat msg)"', 'D=$(date +%F); git commit -m "$D"',
    'wt=$(mktemp -d) && git worktree add --detach "$wt" HEAD && cd "$wt" && git switch -c fix && git reset --hard',
    'wt="$(mktemp -d -t desk)/"; cd "$wt"; git checkout -b x', 'pushd "$(pick)" && npm test && popd', "popd; git status",
    "pushd; ls", "! grep -q x file.txt && echo absent", "git frobnicate", "git -c alias.stage=stash stage", "echo 'unterminated", "(echo", "case x in x) echo;",
    'source ~/.nvm/nvm.sh && nvm use 22', '. venv/bin/activate', 'bash -c "echo ok"', "eval 'echo ok'",
    "for f in a b c d e f g h i j k l m n o; do [ -x $f ] && $f --version; git status | grep x; done",
    // Safe in any checkout, so an unknown target does not matter (2026-09-27).
    'cd "$(pick)"; git push origin HEAD', 'cd "$(pick)" && git add -A && git commit -qm x && git pull --rebase && git push',
    'cd "$(pick)" && git pull --ff-only', 'cd "$(pick)" && git merge --ff-only origin/main', 'cd "$(pick)" && git rebase',
    // Unreadable or computed code is allowed; only text Desk can read is inspected (ruling, 2026-09-27).
    "g=$(which git); $g status", '"$(pick)" git status', 'eval "$(cat script)"', 'bash -c "$(cat script)"', 'source "$(pick)"', '. "$(pick)"',
    "$(cd x; command -v git) status", "git status 'unterminated",
  ]
  for (const command of allow) {
    const result = await f.guard(command, { cwd: f.shared, env })
    assert.equal(result.deny, false, `${command} -> ${result.reason}`)
  }
  const unresolved = /^Desk could not resolve .+; write it literally or set it in a separate command first\. It could run Git in a protected checkout; plain read-only Git \(status, log, diff, fetch into remote-tracking refs\) is not blocked\.$/u
  const deny = [
    ['cd "$(pick)" && git checkout main', /which checkout/u], ['cd "$(pick)"; git stash', /which checkout/u],
    ['git -C "$(pick)" reset --hard', /which checkout/u], ['GIT_DIR="$(pick)" git reset --hard', /could not inspect a Git command.*unresolved Git location/u],
    ['git --git-dir="$(pick)" reset --hard', /which checkout/u], ['popd; git checkout main', /which checkout/u], ["pushd +1 && git stash", /which checkout/u],
    ['cd "$(pick)" && git frobnicate', /which checkout/u],
    ["$(command -v git) checkout topic", /move HEAD off/u], ["`which git` stash", /git stash takes other sessions/u], ['command "$(which git)" stash', /git stash takes other sessions/u],
    ['git "$(pick)" main', /which Git command/u], ['git checkout "$(cat branch)"', /a Git revision/u], ['git branch -D "$(cat b)"', /a branch name/u],
    ['git push origin "$(cat r)"', /a push refspec/u], ['git rebase "$(cat base)"', /a Git revision/u], ['git reset "$(cat base)"', /a Git revision/u],
    ['git worktree remove --force "$(pick)"', /would delete a protected checkout/u],
    [`wt=$(mktemp -d -p ${q(f.shared)}); cd "$wt"; git checkout topic`, / Desk protects this checkout: /u],
    [`TMPDIR=${q(f.shared)}; wt=$(mktemp -d); cd "$wt" && git stash`, / Desk protects this checkout: /u],
    [`wt=$(mktemp -d ${q(f.shared)}/x.XXXX); cd "$wt" && git stash`, / Desk protects this checkout: /u],
    ["git stash 'unterminated", /could not inspect this shell command \(unterminated shell quote\), and its git stash could change a protected checkout/u],
    ['cd "$(date; hostname)" && git stash', /which checkout/u], ['cd "$(mktemp -d -p /definitely-missing)" && git stash', /which checkout/u],
    ["git co topic", /This would move HEAD off.* Desk protects this checkout: /u],
  ]
  for (const [command, reason] of deny) {
    const result = await f.guard(command, { cwd: f.shared, env })
    assert.equal(result.deny, true, command)
    assert.match(result.reason, reason, command)
    if (result.reason.startsWith("Desk could not resolve")) assert.match(result.reason, unresolved, command)
  }
})

test("A3b: PowerShell unknown values follow the same rule", async (t) => {
  const f = desk(t)
  await protectCheckout({ root: f.shared, stateBranch: "main" })
  const allow = [
    '$d = Get-Date; Write-Output "$d"', 'Write-Output "$(Get-Date)"', "$wt = New-Item -ItemType Directory x; Set-Location $wt; node x.js",
    "$wt = New-Item -ItemType Directory x; Set-Location $wt; git commit -m x", "Pop-Location; git status", "popd; Write-Output ok",
    "Invoke-Expression 'Write-Output ok'", `pushd ${psq(f.own)}; git checkout topic`, "(opaque)",
    "$x = 1 + 2; & $x", "& $(Get-Date)",
  ]
  for (const command of allow) {
    const result = await f.guard(command, { cwd: f.shared, powershell: true })
    assert.equal(result.deny, false, `${command} -> ${result.reason}`)
  }
  for (const [command, reason] of [
    ["$wt = New-Item -ItemType Directory x; Set-Location $wt; git checkout main", /which checkout/u],
    ["Pop-Location; git stash", /which checkout/u], [`pushd ${psq(f.shared)}; git stash`, / Desk protects this checkout: /u],
    // Round 4 ruling: Git named as an argument outside a plain form is denied.
    ["$g = (Get-Command git).Source; & $g checkout main", /^Run each git command as its own plain statement/u], ["& $(Get-Command git) status", /^Run each git command as its own plain statement/u],
    ["& (Get-Command git) checkout main", /^Run each git command as its own plain statement/u],
    // Replay ruling, 2026-09-27: a script Desk can read is inspected; one it cannot read is allowed.
    [`iex "git -C ${psq(f.shared)} checkout topic"`, /This would move HEAD off.* Desk protects this checkout: /u], ["iex 'git status'", /^allowed$/u],
    ["$script = Get-Content x; iex $script", /^allowed$/u], ["Invoke-Expression $(Get-Content x)", /^allowed$/u], [". $(Get-Item x)", /^allowed$/u],
    ["$script = Get-Content x; pwsh -Command $script", /^allowed$/u], ["$script = Get-Content x; bash -c $script", /^allowed$/u],
    ["$g = -join ('g', 'i', 't'); & $g checkout topic", / Desk protects this checkout: /u],
  ]) {
    const result = await f.guard(command, { cwd: f.shared, powershell: true })
    assert.match(result.reason ?? "allowed", reason, command)
  }
})

test("A3b: the Git-reach rule, option parser and mktemp model", (t) => {
  for (const text of ["git status", "/usr/bin/git log", "g''it checkout", "g\\it", "Git.exe status", "git-lfs pull", "eval x", "source x", "x; . y", "iex $x", "Invoke-Expression $x"]) {
    assert.equal(mayInvokeGit(text), true, text)
  }
  for (const text of ["echo $(date)", "cat .git/config", "digit", "mygit", "--source", "find . -name x", "ls ./x", "GIT_DIR=x node y"]) {
    assert.equal(mayInvokeGit(text), false, text)
  }
  const parse = (operation, args) => parseGitOptions(SPECS[operation], args)
  assert.deepEqual(parse("push", ["--end-of-options", "--force"]).operands, ["--force"])
  assert.equal(hasOption(parse("push", ["--force=yes"]), "force"), false, "a flag given a value is rejected by Git")
  assert.equal(hasOption(parse("push", ["--no-force=x"]), "force"), false)
  assert.equal(hasOption(parse("push", ["--f"]), "force"), false, "ambiguous prefix")
  assert.equal(hasOption(parse("push", ["--repo"]), "repo"), false, "missing value")
  assert.equal(hasOption(parse("push", ["-o"]), "push-option"), false, "missing short value")
  assert.equal(parse("push", ["-ofoo", "-f"]).set.get("push-option").value, "foo")
  assert.equal(hasOption(parse("push", ["-Zf"]), "force"), true, "unknown short letters are skipped")
  assert.equal(parse("commit", ["-S", "-m", "x"]).set.get("gpg-sign").value, true)
  assert.equal(parse("commit", ["--gpg-sign=key"]).set.get("gpg-sign").value, "key")
  assert.equal(parse("branch", ["--contains", "-f"]).set.get("contains").value, true)
  assert.equal(classifyGit("status", []), null)
  assert.equal(classifyGit("merge", ["-h"]), null)
  assert.equal(classifyGit("merge", ["--", "-h"]), null, "a merge moves no HEAD off its branch")
  assert.equal(classifyGit("merge", ["--autostash", "topic"]), null, "--autostash re-applies within the same command")
  assert.equal(classifyGit("worktree", ["remove", "--force"]), null, "no worktree named")
  assert.equal(classifyGit("worktree", ["repair"]), null)
  const cwd = realpathSync.native(tmpdir())
  assert.equal(mktempPath([], cwd, {}, 1), path.join(realpathSync("/tmp"), ".desk-guard-mktemp-1"))
  assert.equal(mktempPath(["-d", "-t", "x"], cwd, { TMPDIR: cwd }, 2), path.join(cwd, ".desk-guard-mktemp-2"))
  assert.equal(mktempPath(["-d", "x.XXXX"], cwd, { TMPDIR: "/tmp" }, 3), path.join(cwd, ".desk-guard-mktemp-3"), "a bare template is created in the current directory")
  assert.equal(mktempPath(["-p"], cwd, { TMPDIR: cwd }, 4), path.join(cwd, ".desk-guard-mktemp-4"))
  assert.equal(mktempPath(["--tmpdir=/definitely-missing"], cwd, {}, 5), null)
  assert.ok(mktempPath(["-p", "rel"], "\0", {}, 6).includes("\0"))
  const pending = mktempPath([], cwd, { TMPDIR: cwd }, 7)
  assert.equal(physicalDirectory(pending, "."), pending)
  assert.equal(physicalDirectory(pending, "sub"), null)
  assert.equal(physicalDirectory(path.join(cwd, "definitely-missing"), ".desk-guard-mktemp-1"), null)
  // Windows resolves a relative location against the path it was given, not the directory a link points to.
  const linkRoot = mkdtempSync(path.join(cwd, "desk-lexical-"))
  t.after(() => rmSync(linkRoot, { recursive: true, force: true }))
  mkdirSync(path.join(linkRoot, "issuer")); mkdirSync(path.join(linkRoot, "target", "child"), { recursive: true })
  const link = path.join(linkRoot, "issuer", "link")
  symlinkSync(path.join(linkRoot, "target", "child"), link, process.platform === "win32" ? "junction" : "dir")
  assert.equal(lexicalDirectory(link, ".."), path.join(linkRoot, "issuer"))
  // One operand's own ".." is normalized by Windows before the link is followed, so there it is lexical too.
  assert.equal(physicalDirectory(link, ".."), process.platform === "win32" ? path.join(linkRoot, "issuer") : realpathSync.native(path.join(linkRoot, "target")))
  assert.equal(lexicalDirectory(cwd, link), link, "an absolute operand keeps its own path")
  assert.equal(lexicalDirectory(cwd, "definitely-missing"), null)
  assert.equal(lexicalDirectory(cwd, ".desk-guard-mktemp-8"), path.join(cwd, ".desk-guard-mktemp-8"))
  assert.equal(lexicalDirectory(path.join(cwd, "definitely-missing"), ".desk-guard-mktemp-9"), null)
  assert.equal(lexicalDirectory(UNKNOWN, "rel"), UNKNOWN, "a relative operand from an unknown directory")
  assert.equal(lexicalDirectory(cwd, UNKNOWN), UNKNOWN, "an unknown operand")
  assert.equal(processDirectory, process.platform === "win32" ? lexicalDirectory : physicalDirectory)
  assert.equal(processDirectoryFor("win32"), lexicalDirectory)
  assert.equal(processDirectoryFor("darwin"), physicalDirectory)
  assert.equal(processDirectoryFor("linux"), physicalDirectory)
  for (const platform of ["darwin", "linux"]) assert.equal(gitDirectoryFor(platform)(link), link, `${platform} dirs are already physical`)
  assert.equal(gitDirectoryFor("win32")(link), physicalDirectory(link, "."), "Git works from the junction target")
  assert.equal(gitDirectoryFor("win32")(path.join(cwd, "definitely-missing")), path.join(cwd, "definitely-missing"))
  assert.equal(gitDirectoryFor("win32")(UNKNOWN), UNKNOWN)
  assert.equal(existingDirectory(pending), cwd)
  assert.equal(existingDirectory(cwd), cwd)
})

test("A3b: Desk admission records the host's state branch beside the protection marker", async (t) => {
  const { createDeskSession } = await import("../../../../../plugins/desk/mcp/src/runtime/desk-session.js")
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "desk-guard-admission-")))
  removeFixtureAfter(t, root)
  for (const child of ["_meta", "_archive"]) mkdirSync(path.join(root, child))
  const calls = []
  for (const activation of [{ stateBranch: "main" }, undefined]) {
    const session = createDeskSession({
      args: {}, deskStateDir: path.join(root, "state"), stderr: { write() {} },
      protect: async (request) => { calls.push(request); return { protected: true } },
      resolveInputs: async () => ({ root: { root }, activation, activationError: { message: "fixture activation fails" } }),
    })
    try { await session.admission.refresh({ force: true }) } finally { await session.dispose() }
  }
  assert.deepEqual(calls, [{ root, stateBranch: "main" }, { root, stateBranch: null }])
})

test("A3b: a command aimed at an unprotected worktree from a protected cwd is judged by that worktree", async (t) => {
  const f = desk(t)
  await protectCheckout({ root: f.shared, stateBranch: "main" })
  const worktree = path.join(f.root, "worktree")
  f.git(f.shared, "worktree", "add", "-q", "--detach", worktree, "HEAD")
  const out = path.join(f.root, "out.txt")
  for (const [command, extra] of [
    [`cd ${q(worktree)} && { git log --oneline -3; git diff --stat HEAD~1; } > ${q(out)}`, {}],
    [`cd ${q(worktree)} && git switch -c fix && git reset --hard HEAD~1 && git frobnicate`, {}],
    [`git -C ${q(worktree)} stash && git -C ${q(worktree)} checkout topic`, {}],
    [`Set-Location ${psq(worktree)}; git stash; git checkout topic`, { powershell: true }],
  ]) {
    const result = await f.guard(command, { cwd: f.shared, ...extra })
    assert.equal(result.deny, false, `${command} -> ${result.reason}`)
  }
  // The same commands aimed at the protected cwd itself are still judged by it.
  assert.equal((await f.guard("git stash", { cwd: f.shared })).reason, protectedDenial(f.shared, MESSAGES.stash))
  assert.equal((await f.guard(`cd ${q(worktree)}; cd ${q(f.shared)} && git stash`, { cwd: f.shared })).deny, true)
  // A missing alias in the target is "no alias": `git log` and an unknown command both pass.
  assert.equal((await f.guard("{ git log -1; git frobnicate; } > /dev/null", { cwd: f.shared })).deny, false)
})

test("A3b: worktree paths compare by folder on Windows and exactly elsewhere", () => {
  // Paths that exist nowhere keep their own spelling, so these cases run on every platform.
  const windows = pathForms("win32")
  assert.equal(windows.sameFolder("C:/Users/name/desk-wt", "C:\\USERS\\Name\\desk-wt"), true, "separators and case")
  assert.equal(windows.sameFolder("C:/Users/name/desk-wt", "C:\\Users\\name\\desk-wt\\sub\\.."), true, "normalized")
  assert.equal(windows.sameFolder("C:/Users/name/desk-wt", "C:\\Users\\name\\desk-wt-2"), false)
  for (const platform of ["darwin", "linux"]) {
    const posix = pathForms(platform)
    assert.equal(posix.sameFolder("/Users/name/desk-wt", "/Users/name/desk-wt"), true)
    assert.equal(posix.sameFolder("/Users/name/desk-wt", "/Users/Name/desk-wt"), false, `${platform} keeps case`)
    assert.equal(posix.realPath, realpathSync)
  }
  assert.equal(windows.realPath, realpathSync.native)
  // A missing path is kept as written; any other failure is not swallowed.
  const root = realpathSync.native(tmpdir())
  assert.equal(windows.canonical(path.join(root, "definitely-missing-desk-guard")), path.join(root, "definitely-missing-desk-guard"))
  assert.equal(pathForms(process.platform).canonical(root), root)
  assert.throws(() => windows.canonical("bad\0path"))
})
