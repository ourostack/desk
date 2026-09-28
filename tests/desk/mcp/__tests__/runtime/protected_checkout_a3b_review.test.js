// A3b review regressions: the reviewer's probe matrix (task-A3b-review-evidence/probes.mjs,
// target.mjs, followups.mjs and timeout2.mjs), replayed against the guard. Rows the review
// reproduced as real bypasses are also executed for real after the guard denies them, to prove
// the denial protects something.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { GUARD_INSPECTION_BUDGET_MS, guardShellCommand, protectCheckout } from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout.js"
import { MESSAGES } from "../../../../../plugins/desk/mcp/src/runtime/git-guard-policy.js"
import { POWERSHELL_GIT_FORMS } from "../../../../../plugins/desk/mcp/src/runtime/powershell-commands.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "protected-checkout.cjs")
const q = (text) => `'${text.replaceAll("'", "'\\''")}'`
const psq = (text) => `'${text.replaceAll("'", "''")}'`
const pwsh = !spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).error

// The reviewer's fixture: a bare origin with a foreign `other` branch, a protected clone on main with
// desk.stateBranch=main, an ordinary clone and a foreign bare repository.
async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-guard-a3b-review-")))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const home = path.join(root, "home")
  mkdirSync(home)
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[pull]\n\trebase = false\n")
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS|GLOBAL))/u.test(key)) delete env[key]
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  const origin = path.join(root, "origin.git"), prot = path.join(root, "prot"), own = path.join(root, "own"), foreign = path.join(root, "foreign.git")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env })
  execFileSync("git", ["init", "-q", "-b", "main", prot], { env })
  writeFileSync(path.join(prot, "file.txt"), "base\n")
  git(prot, "add", "file.txt"); git(prot, "commit", "-qm", "first")
  git(prot, "branch", "topic")
  writeFileSync(path.join(prot, "file.txt"), "second\n")
  git(prot, "commit", "-qam", "second"); git(prot, "tag", "v1")
  git(prot, "remote", "add", "origin", origin)
  git(prot, "push", "-q", "-u", "origin", "main", "topic")
  execFileSync("git", ["clone", "-q", origin, own], { env })
  git(own, "switch", "-qc", "other"); writeFileSync(path.join(own, "other.txt"), "other\n"); git(own, "add", "other.txt")
  git(own, "commit", "-qm", "other work"); git(own, "push", "-q", "origin", "other"); git(own, "switch", "-q", "main")
  git(prot, "fetch", "-q", "origin")
  execFileSync("git", ["clone", "-q", "--bare", origin, foreign], { env })
  git(foreign, "update-ref", "refs/heads/main", "refs/heads/other")
  await protectCheckout({ root: prot, stateBranch: "main" })
  const state = () => ({ head: git(prot, "rev-parse", "HEAD"), branch: spawnSync("git", ["-C", prot, "symbolic-ref", "-q", "HEAD"], { env, encoding: "utf8" }).stdout.trim(), stash: git(prot, "stash", "list"), remote: git(prot, "ls-remote", origin) })
  return { root, env, git, origin, prot, own, foreign, state, guard: (command, { cwd = prot, powershell = false } = {}) => guardShellCommand({ command, cwd, env, powershell }) }
}

// [id, shell, from ("prot" or "own"), expected, command]
function rows(f) {
  const P = f.prot, O = f.own
  return [
    // Reported cases and implementer choices.
    ["op-add-commit-pull-push", "bash", "prot", "allow", "git add file.txt && git commit -qm 'desk state' && git pull -q --rebase && git push -q"],
    ["op-pull-rebase-origin-main", "bash", "prot", "allow", "git pull -q --rebase origin main"],
    ["op-push-origin-main", "bash", "prot", "allow", "git push -q origin main"],
    ["op-cd-wt-node", "bash", "prot", "allow", 'cd "$wt" && node x.js'],
    ["op-echo-date", "bash", "prot", "allow", 'echo "$(date)"'],
    ["op-ps-add-commit-pull-push", "pwsh", "prot", "allow", "git add file.txt; git commit -qm 'desk state'; git pull -q --rebase; git push -q"],
    ["op-ps-echo-date", "pwsh", "prot", "allow", 'Write-Output "$(Get-Date)"'],
    ["op-cd-prot-log-diff-redirect", "bash", "own", "allow", `cd ${q(P)} && { git log -1; git diff; } > ${q(f.root + "/out.txt")}`],
    ["choice-stash-list", "bash", "prot", "allow", "git stash list"],
    ["choice-bisect-log", "bash", "prot", "allow", "git bisect log"],
    ["choice-clean-n", "bash", "prot", "deny", "git clean -n"],
    ["choice-worktree-prune", "bash", "prot", "allow", "git worktree prune"],
    ["choice-amend-pushed", "bash", "prot", "deny", "git commit -q --amend -m amended"],
    ["choice-amend-abbrev", "bash", "prot", "deny", "git commit -q --amen -m amended"],
    // A3's reproductions.
    ["a3-restore-sour", "bash", "prot", "deny", "git restore --sour=HEAD -- ."],
    ["a3-restore-sour-path", "bash", "prot", "allow", "git restore --sour=HEAD -- file.txt"],
    ["a3-branch-forc-current", "bash", "prot", "deny", "git branch --forc main HEAD~1"],
    ["a3-ansi-c", "bash", "own", "deny", `git -C $${q(P)} checkout -q --detach HEAD`],
    ["a3-unquoted-var-words", "bash", "own", "deny", `G='git -C ${P}'; $G checkout -q --detach HEAD`],
    ["a3-ps-variable", "pwsh", "own", "deny", `$repo = ${psq(P)}; git -C $repo checkout -q --detach HEAD`],
    ["a3-ps-sl", "pwsh", "own", "deny", `sl ${psq(P)}; git checkout -q --detach HEAD`],
    ["a3-ps-literalpath-case", "pwsh", "own", "deny", `Set-Location -literalpath ${psq(P)}; git checkout -q --detach HEAD`],
    ["a3-ps-quoted-subexpr", "pwsh", "own", "deny", `"$(git -C ${psq(P)} checkout -q --detach HEAD)"`],
    ["a3-ps-failed-and", "pwsh", "prot", "deny", `git -C ${psq(f.root + "/missing")} status && Set-Location ${psq(O)}; git checkout -q --detach HEAD`],
    ["a3-bash-second-assignment", "bash", "own", "deny", `X=${q(P)}; A=1 P=$X; git -C "$P" checkout -q --detach HEAD`],
    ["a3-case-no-match", "bash", "own", "deny", `false; case x in y) echo unreachable;; esac && git -C ${q(P)} checkout -q --detach HEAD`],
    ["a3-restore-no-o", "bash", "prot", "deny", "git restore --source=HEAD~1 --no-o -- :/"],
    ["a3-multiline-case-unprotected", "bash", "own", "allow", "case x in\n  x) echo harmless;;\nesac"],
    ["a3-git-dir-flag", "bash", "own", "deny", `git --git-dir=${q(P + "/.git")} --work-tree=${q(P)} checkout -q --detach HEAD`],
    // The loosened rules.
    ["new-push-head-other", "bash", "prot", "allow", "git push -q origin HEAD:other"],
    ["new-push-force-with-lease", "bash", "prot", "deny", "git push -q --force-with-lease"],
    ["new-push-plus-refspec", "bash", "prot", "deny", "git push -q origin +main"],
    ["new-push-u-other", "bash", "prot", "allow", "git push -q -u origin other"],
    ["new-push-other-into-main", "bash", "prot", "allow", "git push -q origin topic:main"],
    ["new-pull-other-branch", "bash", "prot", "allow", "git pull -q origin other"],
    ["new-pull-rebase-other-branch", "bash", "prot", "deny", "git pull -q --rebase origin other"],
    ["new-pull-rebase-merges-foreign", "bash", "prot", "deny", "git pull -q --rebase=merges origin other"],
    ["new-pull-url-no-refspec", "bash", "prot", "allow", `git pull -q --no-rebase --no-edit ${q(f.foreign)}`],
    ["new-pull-rebase-url", "bash", "prot", "deny", `git pull -q --rebase ${q(f.foreign)} main`],
    ["new-pull-dot", "bash", "prot", "allow", "git pull -q . topic"],
    ["new-merge-no-ff-only", "bash", "prot", "allow", "git merge -q --no-edit origin/other"],
    ["new-merge-ff-only-foreign", "bash", "prot", "allow", "git merge -q --ff-only origin/other"],
    ["new-rebase-i-upstream", "bash", "prot", "allow", "git rebase -i"],
    ["new-rebase-i-HEAD~1", "bash", "prot", "deny", "git rebase -i HEAD~1"],
    ["new-rebase-u-minus", "bash", "prot", "deny", "git rebase -i '@{u}~1'"],
    ["new-rebase-origin-main-minus", "bash", "prot", "deny", "git rebase origin/main~1"],
    ["new-rebase-foreign", "bash", "prot", "deny", "git rebase origin/other"],
    ["new-amend-pushed", "bash", "prot", "deny", "git commit -q --amend --no-edit"],
    ["new-hookspath-commit", "bash", "prot", "allow", `git -c core.hooksPath=${q(f.root + "/hooks")} commit -q --allow-empty -m via-hook`],
    // Aliases.
    ["new-alias-c", "bash", "prot", "deny", "git -c alias.co='checkout -q --detach HEAD' co"],
    ["new-alias-c-shell", "bash", "prot", "deny", "git -c alias.co='!git checkout -q --detach HEAD' co"],
    ["new-alias-upper-key", "bash", "prot", "deny", "git -c alias.CO='checkout -q --detach HEAD' co"],
    ["new-alias-upper-section", "bash", "prot", "deny", "git -c Alias.co='checkout -q --detach HEAD' co"],
    ["new-alias-config-env", "bash", "prot", "deny", "CO='checkout -q --detach HEAD' git --config-env=alias.co=CO co"],
    ["new-alias-git-config-count", "bash", "prot", "deny", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.co GIT_CONFIG_VALUE_0='checkout -q --detach HEAD' git co"],
    ["new-alias-git-dir-flag", "bash", "own", "deny", `git --git-dir=${q(P + "/.git")} -c alias.x='checkout -q --detach HEAD' x`],
    ["new-alias-git-dir-shell", "bash", "own", "deny", `git --git-dir=${q(P + "/.git")} -c alias.x='!git stash' x`],
    ["new-alias-stash", "bash", "prot", "deny", "git -c alias.save='stash' save"],
    ["new-alias-missing", "bash", "prot", "allow", "git nosuchalias"],
    // Substitutions and stdin scripts.
    ["new-subst-echo", "bash", "own", "deny", `echo "$(git -C ${q(P)} checkout -q --detach HEAD)"`],
    ["new-subst-backtick", "bash", "own", "deny", `ls \`git -C ${q(P)} reset -q --hard HEAD~1\``],
    ["new-subst-assign", "bash", "own", "deny", `x=$(git -C ${q(P)} stash); echo "$x"`],
    ["new-subst-local-export", "bash", "own", "deny", `export x="$(git -C ${q(P)} stash)"`],
    ["new-subst-if", "bash", "own", "deny", `if [ -n "$(git -C ${q(P)} stash)" ]; then echo y; fi`],
    ["new-subst-proc", "bash", "own", "deny", `cat <(git -C ${q(P)} checkout -q --detach HEAD)`],
    ["new-subst-arith", "bash", "own", "deny", `echo $(( $(git -C ${q(P)} stash >/dev/null; echo 1) + 1 ))`],
    ["new-subst-array", "bash", "own", "deny", `a=( $(git -C ${q(P)} stash) )`],
    ["new-subst-dbl-bracket", "bash", "own", "deny", `[[ -n $(git -C ${q(P)} stash) ]] && echo y`],
    ["new-heredoc-bash", "bash", "own", "deny", `bash <<'EOF'\ngit -C ${q(P)} checkout -q --detach HEAD\nEOF`],
    ["new-herestring-bash", "bash", "own", "deny", `bash <<< ${q(`git -C ${P} stash`)}`],
    ["new-pipe-bash", "bash", "own", "deny", `echo ${q(`git -C ${P} checkout -q --detach HEAD`)} | bash`],
    ["new-pipe-bash-harmless", "bash", "own", "allow", "echo 'echo harmless' | bash"],
    // Round 4 ruling: a script piped into a shell that Desk cannot read literally fails closed.
    ["new-pipe-file-bash", "bash", "own", "allow", "cat script | sh"],
    // Unknown programs.
    ["new-unknown-prog-printf", "bash", "own", "deny", `$(printf 'g%s' it) -C ${q(P)} checkout -q --detach HEAD`],
    ["new-unknown-prog-file", "bash", "own", "deny", `X=$(cat ${q(f.root + "/cmd.txt")}); $X -C ${q(P)} checkout -q --detach HEAD`],
    ["new-unknown-prog-subcommand", "bash", "prot", "deny", "X=$(cat cmd.txt); $X stash"],
    ["new-unknown-prog-named", "bash", "own", "deny", `$(command -v git) -C ${q(P)} checkout -q --detach HEAD`],
    ["new-unknown-dir-checkout", "bash", "prot", "deny", 'cd "$(pick)" && git checkout topic'],
    ["new-unknown-dir-commit", "bash", "prot", "allow", 'cd "$(pick)" && git commit -qm x'],
    ["new-unknown-harmless", "bash", "prot", "allow", '"$(npm bin)/tsc" --version; jq . f.json | grep x; "$(pick)" --build x'],
    ["new-xargs", "bash", "own", "allow", `echo ${q(P)} | xargs -I{} git -C {} checkout -q --detach HEAD`],
    // Configuration.
    ["cfg-mirror-push", "bash", "prot", "deny", "git -c remote.origin.mirror=true push -q origin"],
    ["cfg-push-refspec-force", "bash", "prot", "deny", "git -c remote.origin.push=+refs/heads/main:refs/heads/main push -q origin"],
    ["cfg-push-refspec-foreign", "bash", "prot", "deny", "git -c remote.origin.push=refs/heads/main:refs/heads/other push -q origin"],
    ["cfg-persistent-mirror", "bash", "prot", "deny", "git config remote.origin.mirror true && git push -q origin"],
    ["cfg-pull-foreign-merge", "bash", "prot", "deny", "git -c branch.main.merge=refs/heads/other pull -q --no-rebase --no-edit"],
    ["cfg-rebase-foreign", "bash", "prot", "deny", "git -c branch.main.merge=refs/heads/other rebase -q"],
    ["cfg-rebase-at-u-foreign", "bash", "prot", "deny", "git -c branch.main.merge=refs/heads/other rebase -q '@{u}'"],
    ["cfg-set-upstream-then-pull", "bash", "prot", "deny", "git branch -q -u origin/other && git pull -q --no-rebase --no-edit"],
    ["cfg-set-upstream-own", "bash", "prot", "allow", "git branch -q -u origin/main && git pull -q"],
    ["cfg-autostash-pull", "bash", "prot", "allow", "git -c rebase.autoStash=true pull -q --rebase"],
    ["cfg-git-config-env-mirror", "bash", "prot", "deny", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.mirror GIT_CONFIG_VALUE_0=true git push -q origin"],
    ["cfg-git-config-parameters", "bash", "prot", "deny", "GIT_CONFIG_PARAMETERS=\"'remote.origin.mirror'='true'\" git push -q origin"],
    ["cfg-config-env-mirror", "bash", "prot", "deny", "M=true git --config-env=remote.origin.mirror=M push -q origin"],
    ["cfg-fetch-update-head-ok", "bash", "prot", "deny", "git fetch -q --update-head-ok . +HEAD~1:refs/heads/main"],
    ["cfg-fetch-into-main", "bash", "prot", "deny", "git fetch -q origin other:main"],
    ["cfg-harmless-override", "bash", "prot", "allow", "git -c core.pager=cat -c user.name=x push -q origin main; git -c color.ui=never log -1"],
    ["cfg-config-write-alias", "bash", "prot", "deny", "git config alias.co 'checkout --detach' && git co"],
    ["cfg-config-write-desk", "bash", "prot", "deny", "git config desk.protected false"],
    ["cfg-config-remove-section", "bash", "prot", "deny", "git config --remove-section remote.origin"],
    ["idx-reset-unstage-all", "bash", "prot", "deny", "git reset -q"],
    ["idx-restore-staged", "bash", "prot", "allow", "git restore --staged file.txt"],
    // PowerShell.
    ["ps-push-head-other", "pwsh", "own", "allow", `Set-Location ${psq(P)}; git push -q origin HEAD:other`],
    ["ps-push-fwl", "pwsh", "own", "deny", `git -C ${psq(P)} push -q --force-with-lease`],
    ["ps-pull-other", "pwsh", "own", "allow", `& git -C ${psq(P)} pull -q origin other`], // & git is git (replay ruling); a merge-mode pull moves no HEAD
    ["ps-merge", "pwsh", "prot", "allow", "git merge -q --no-edit origin/other"],
    ["ps-alias", "pwsh", "prot", "deny", "git -c alias.co='checkout -q --detach HEAD' co"],
    ["ps-alias-upper", "pwsh", "prot", "deny", "git -c alias.CO='checkout -q --detach HEAD' co"],
    ["ps-subexpr-write-output", "pwsh", "own", "deny", `Write-Output "$(git -C ${psq(P)} checkout -q --detach HEAD)"`],
    ["ps-assign-git", "pwsh", "own", "deny", `$out = git -C ${psq(P)} checkout -q --detach HEAD`],
    ["ps-assign-git-stash", "pwsh", "prot", "deny", "$s = git stash"],
    ["ps-null-assign", "pwsh", "own", "deny", `$null = git -C ${psq(P)} checkout -q --detach HEAD`],
    ["ps-assign-call", "pwsh", "own", "deny", `$r = & git -C ${psq(P)} checkout -q --detach HEAD`],
    ["ps-assign-env", "pwsh", "prot", "deny", "$env:X = git stash"],
    ["ps-assign-paren", "pwsh", "prot", "deny", "$n = (git stash).Length"],
    ["ps-assign-chained", "pwsh", "prot", "deny", "$a = $b = git stash"],
    ["ps-assign-readonly", "pwsh", "prot", "allow", "$s = git status --short; $d = Get-Date; $n = 3; $t = 'text'"],
    // Round 4 ruling: a statement that names Git outside the plain forms is denied.
    ["ps-group-names-git", "pwsh", "prot", "deny", "$p = (Get-Command git).Source"],
    ["ps-void", "pwsh", "own", "deny", `[void](git -C ${psq(P)} checkout -q --detach HEAD)`],
    ["ps-if", "pwsh", "own", "deny", `if (git -C ${psq(P)} checkout -q --detach HEAD) { 'y' }`],
    ["ps-out-null", "pwsh", "own", "deny", `git -C ${psq(P)} checkout -q --detach HEAD | Out-Null`],
    ["ps-unknown-prog", "pwsh", "own", "deny", `$g = -join ('g','i','t'); & $g -C ${psq(P)} checkout -q --detach HEAD`],
    ["ps-env-config", "pwsh", "prot", "deny", "$env:GIT_CONFIG_COUNT='1'; $env:GIT_CONFIG_KEY_0='remote.origin.mirror'; $env:GIT_CONFIG_VALUE_0='true'; git push -q origin"],
    ["ps-cfg-mirror", "pwsh", "prot", "deny", "git -c remote.origin.mirror=true push -q origin"],
    // Effective-checkout resolution (target.mjs).
    ["target-cd-own", "bash", "prot", "allow", `cd ${q(O)} && git checkout -q topic`],
    ["target-C-own", "bash", "prot", "allow", `git -C ${q(O)} stash`],
    ["target-group-redirect", "bash", "prot", "allow", `cd ${q(O)} && { git log -1; git diff; } > ${q(f.root + "/o.txt")}`],
    ["target-ps-own", "pwsh", "prot", "allow", `Set-Location ${psq(O)}; git stash`],
    ["target-cd-prot", "bash", "own", "deny", `cd ${q(P)} && git stash`],
    ["target-C-prot", "bash", "own", "deny", `git -C ${q(P)} stash`],
    ["target-ps-prot", "pwsh", "own", "deny", `Set-Location ${psq(P)}; git stash`],
    ["target-C-dot", "bash", "own", "deny", `cd ${q(P)}; git -C . reset -q --hard`],
    ["target-cd-minus", "bash", "prot", "deny", `cd ${q(O)} && cd - && git stash`],
    ["target-subshell", "bash", "prot", "deny", `(cd ${q(O)}); git stash`],
  ]
}

test("A3b review: every probe row gets the expected decision", async (t) => {
  const f = await fixture(t)
  const before = f.state()
  const mismatches = []
  for (const [id, shell, from, expected, command] of rows(f)) {
    const result = await f.guard(command, { cwd: from === "prot" ? f.prot : f.own, powershell: shell === "pwsh" })
    if ((result.deny ? "deny" : "allow") !== expected) mismatches.push(`${id}: expected ${expected}, got ${result.reason ?? "allow"}`)
  }
  assert.deepEqual(mismatches, [])
  assert.deepEqual(f.state(), before, "inspection changes nothing")
})

test("A3b review: the denial reasons name what the new rules protect", async (t) => {
  const f = await fixture(t)
  const reason = async (command, extra) => (await f.guard(command, extra)).reason
  assert.equal(await reason("git -c remote.origin.mirror=true push -q origin"), `Desk protected checkout ${f.prot}: ${MESSAGES.override("remote.origin.mirror", "push")}`)
  assert.equal(await reason(`git pull -q --rebase ${q(f.foreign)}`), `Desk protected checkout ${f.prot}: ${MESSAGES.pull}`)
  assert.equal(await reason("git config remote.origin.mirror true"), `Desk protected checkout ${f.prot}: ${MESSAGES.config("remote.origin.mirror")}`)
  assert.equal(await reason("git branch -u origin/other"), `Desk protected checkout ${f.prot}: ${MESSAGES.upstream}`)
  assert.equal(await reason("git fetch origin other:main"), `Desk protected checkout ${f.prot}: ${MESSAGES.fetch}`)
  assert.equal(await reason("git reset"), `Desk protected checkout ${f.prot}: ${MESSAGES.unstage}`)
  assert.equal(await reason("$s = git stash", { powershell: true }), `Desk protected checkout ${f.prot}: ${MESSAGES.stash}`)
  // Saved configuration that turns a plain push into a mirror or forced push; non-force pushes of other refs pass.
  for (const [key, value, message] of [["remote.origin.mirror", "true", MESSAGES.pushForce], ["remote.origin.push", "+refs/heads/main:refs/heads/main", MESSAGES.pushForce], ["remote.origin.push", "refs/heads/main:refs/heads/other"], ["push.default", "matching"]]) {
    f.git(f.prot, "config", key, value)
    assert.equal(await reason("git push -q"), message && `Desk protected checkout ${f.prot}: ${message}`, key)
    f.git(f.prot, "config", "--unset-all", key)
  }
  // A saved pull.rebase makes a pull of another branch a rebase onto it; --no-rebase merges.
  f.git(f.prot, "config", "pull.rebase", "true")
  assert.equal(await reason("git pull -q origin other"), `Desk protected checkout ${f.prot}: ${MESSAGES.pull}`)
  assert.equal(await reason("git pull -q --no-rebase origin other"), undefined)
  assert.equal(await reason("git pull -q --rebase=false origin other"), undefined)
  f.git(f.prot, "config", "branch.main.rebase", "false")
  assert.equal(await reason("git pull -q origin other"), undefined, "the branch's own setting wins")
  f.git(f.prot, "config", "--unset", "branch.main.rebase")
  f.git(f.prot, "config", "--unset", "pull.rebase")
  f.git(f.prot, "config", "remote.origin.push", "refs/heads/main:refs/heads/main")
  assert.equal(await reason("git push -q"), undefined, "a configured push of the state branch itself")
})

// Rows the review reproduced as real bypasses: the guard now denies them, and running them for
// real in a fresh fixture shows what the denial protects.
test("A3b review: reproduced bypasses are denied, and would have changed the protected checkout or its remote", async (t) => {
  const cases = [
    ["ps-assign-git", "pwsh", "own", (f) => `$out = git -C ${psq(f.prot)} checkout -q --detach HEAD`, "branch"],
    ["ps-assign-git-stash", "pwsh", "prot", () => "$s = git stash", "stash", (f) => writeFileSync(path.join(f.prot, "file.txt"), "another session's edit\n")],
    ["ps-unknown-prog", "pwsh", "own", (f) => `$g = -join ('g','i','t'); & $g -C ${psq(f.prot)} checkout -q --detach HEAD`, "branch"],
    ["new-unknown-prog-printf", "bash", "own", (f) => `$(printf 'g%s' it) -C ${q(f.prot)} checkout -q --detach HEAD`, "branch"],
    ["new-pull-rebase-url", "bash", "prot", (f) => `git pull -q --rebase ${q(f.foreign)} main`, "head"],
    ["cfg-mirror-push", "bash", "prot", () => "git -c remote.origin.mirror=true push -q origin", "remote"],
    ["cfg-set-upstream-then-pull", "bash", "prot", () => "git branch -q -u origin/other && git pull -q --no-rebase --no-edit", "head"],
    ["cfg-fetch-update-head-ok", "bash", "prot", () => 'git fetch -q --update-head-ok . "+$(git rev-parse HEAD~1):refs/heads/main"', "head"],
    ["new-alias-upper-key", "bash", "prot", () => "git -c alias.CO='checkout -q --detach HEAD' co", "branch"],
    ["new-alias-git-dir-flag", "bash", "own", (f) => `git --git-dir=${q(f.prot + "/.git")} -c alias.x='checkout -q --detach HEAD' x`, "branch"],
    ["new-heredoc-bash", "bash", "own", (f) => `bash <<'EOF'\ngit -C ${q(f.prot)} checkout -q --detach HEAD\nEOF`, "branch"],
  ]
  for (const [id, shell, from, build, changed, setup] of cases) {
    if (shell === "pwsh" && !pwsh) { t.diagnostic(`${id}: native PowerShell unavailable; decision still checked`) }
    const f = await fixture(t)
    setup?.(f)
    const command = build(f), cwd = from === "prot" ? f.prot : f.own
    assert.equal((await f.guard(command, { cwd, powershell: shell === "pwsh" })).deny, true, id)
    if (shell === "pwsh" && !pwsh) continue
    const before = f.state()
    const args = shell === "pwsh" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] : ["--noprofile", "--norc", "-c", command]
    spawnSync(shell === "pwsh" ? "pwsh" : "bash", args, { cwd, env: f.env, encoding: "utf8", timeout: 60000 })
    assert.notEqual(f.state()[changed], before[changed], `${id} changes ${changed} when run`)
  }
})

test("A3b review: the reviewer's payloads are denied by both registered hooks for parent and child agents", async (t) => {
  const f = await fixture(t)
  for (const [shell, command] of [["pwsh", `$out = git -C ${psq(f.prot)} checkout -q --detach HEAD`], ["bash", `$(printf 'g%s' it) -C ${q(f.prot)} checkout -q --detach HEAD`], ["bash", "git -c remote.origin.mirror=true push -q origin"]]) {
    for (const host of ["claude", "copilot"]) {
      for (const child of [false, true]) {
        const tool = shell === "pwsh" ? (host === "claude" ? "PowerShell" : "powershell") : (host === "claude" ? "Bash" : "bash")
        const input = host === "claude" ? { tool_name: tool, tool_input: { command }, cwd: f.prot, agent_id: child ? "child" : undefined }
          : { toolName: tool, toolArgs: JSON.stringify({ command }), cwd: f.prot, agentId: child ? "child" : undefined }
        const result = spawnSync(process.execPath, [hook, host], { cwd: f.prot, env: f.env, input: JSON.stringify(input), encoding: "utf8" })
        assert.equal(result.status, 0, result.stderr)
        const output = JSON.parse(result.stdout)
        assert.equal((output.hookSpecificOutput ?? output).permissionDecision, "deny", `${host} ${child}: ${command}`)
      }
    }
  }
})

// timeout2.mjs: every inspection read of the protected checkout blocks on a FIFO included from its configuration.
async function slowGit(t, f, delayMs) {
  const fifo = path.join(f.root, "slow.cfg")
  execFileSync("mkfifo", [fifo])
  f.git(f.prot, "config", "include.path", fifo)
  const writer = spawn(process.execPath, ["-e", `
    const fs = require("node:fs")
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    for (;;) { const fd = fs.openSync(${JSON.stringify(fifo)}, "w"); sleep(${delayMs}); fs.closeSync(fd) }
  `], { stdio: "ignore" })
  t.after(() => writer.kill("SIGKILL"))
}

test("A3b review: one inspection budget bounds the decision below the hosts' 10 s hook deadline", { skip: process.platform === "win32" ? "mkfifo is POSIX-only" : false }, async (t) => {
  assert.ok(GUARD_INSPECTION_BUDGET_MS <= 7000, "the budget leaves room inside the 10 s hook timeout")
  for (const manifest of ["hooks.json", "copilot-hooks.json"]) {
    const text = JSON.stringify(JSON.parse((await import("node:fs")).readFileSync(path.join(plugin, "hooks", manifest), "utf8")))
    assert.match(text, /protected-checkout\.cjs[^}]*"timeout(?:Sec)?":10/u, manifest)
  }
  const f = await fixture(t)
  // Git that answers only long after the 2 s budget, so every command that needs a Git read takes the budget path on any
  // runner. (With Git that answered in 1.5 s, a fast runner decided allowed commands such as a pull into main on content.)
  await slowGit(t, f, 60000)
  // Allowed commands need no reads, so slow Git does not delay them.
  for (const command of ["git status", "git add file.txt && git commit -qm x", "git log -1"]) {
    const started = Date.now()
    assert.equal((await f.guard(command)).deny, false, command)
    assert.ok(Date.now() - started < 1000, command)
  }
  for (const command of ["git checkout topic", "git pull -q origin other", "git push -q origin HEAD:other"]) {
    const started = Date.now()
    const result = await guardShellCommand({ command, cwd: f.prot, env: f.env, budgetMs: 2000 })
    const elapsed = Date.now() - started
    assert.equal(result.deny, true, command)
    assert.ok(elapsed < 3500, `${command} decided in ${elapsed} ms`)
    assert.match(result.reason, /within its 2 s budget because Git answered too slowly/u, command)
  }
  // The registered hook answers "deny" at its own deadline even if inspection has not finished.
  const input = { tool_name: "Bash", tool_input: { command: "git checkout topic" }, cwd: f.prot }
  const started = Date.now()
  const result = spawnSync(process.execPath, [hook, "claude"], { cwd: f.prot, env: { ...f.env, DESK_GUARD_DEADLINE_MS: "300" }, input: JSON.stringify(input), encoding: "utf8" })
  assert.ok(Date.now() - started < 5000)
  assert.equal(result.status, 0, result.stderr)
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /could not finish checking this command in time/u)
})

test("A3b review: configuration sources, alias forms and stdin scripts cover every parser path", async (t) => {
  const f = await fixture(t)
  const P = f.prot, O = f.own
  const decide = async (command, extra = {}) => (await f.guard(command, extra)).reason ?? "allow"
  const cases = [
    // Configuration overrides from every source; keys without a value, sections without a variable.
    ["git -c mirror push -q origin", "allow"],
    ["GIT_CONFIG_PARAMETERS=\"'remote.origin.mirror'\" git push -q origin", /override remote\.origin\.mirror/u],
    ["GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=remote.origin.push git push -q origin", /override remote\.origin\.push/u],
    ["M=true git --config-env remote.origin.mirror=M push -q origin", /override remote\.origin\.mirror/u],
    ["git --config-env bad push -q origin main", "allow"],
    ["git --config-env", "allow"],
    // git config writes.
    // --file names another file, not the checkout's configuration (replay ruling, 2026-09-27).
    [`git config --file ${q(f.root + "/x.cfg")} --local remote.origin.url x`, "allow"],
    ["git config set remote.origin.mirror true", /would change remote\.origin\.mirror/u],
    ["git config --edit", /would change the configuration file/u],
    ["git config --unset user.name", "allow"],
    // Upstream changes to a branch that is not protected.
    ["git branch -u origin/other topic", "allow"],
    // Aliases whose target or value is unknown.
    ["cd \"$(pick)\" && git -c alias.co=status co", "allow"],
    ["cd \"$(pick)\" && git -c alias.x='!echo hi' x", /could not resolve which checkout/u],
    ["git --config-env=alias.co=UNSET_ALIAS_VALUE co", /could not resolve a Git alias/u],
    // Stdin: a piped group is not a literal, so the shell's script is unreadable and passes (unreadable code is not judged); a
    // shell with a script operand reads no stdin script.
    ["{ echo 'git stash'; } | bash", "allow"],
    ["echo 'git stash' | bash script.sh", "allow"],
    ["echo 'git stash' | bash -", /git stash takes other sessions/u],
  ]
  for (const [command, expected] of cases) {
    const got = await decide(command)
    if (expected === "allow") assert.equal(got, "allow", command)
    else assert.match(got, expected, command)
  }
  assert.match(await decide(`git --git-dir ${q(P + "/.git")} --namespace ns -c alias.x='!git stash' x`, { cwd: O }), /git stash takes other sessions/u)
  // A group runs its Git as its own statement (replay ruling, 2026-09-27).
  for (const command of ["$x = (git stash)"]) assert.match(await decide(command, { powershell: true }), /git stash takes other sessions/u)
  assert.equal(await decide("$e = @(); $f = () + 1", { powershell: true }), "allow")
  // An upstream on the local repository itself ("."), and a key saved without a value.
  f.git(P, "config", "branch.main.remote", ".")
  f.git(P, "config", "branch.main.merge", "refs/heads/main")
  assert.equal(await decide("git rebase main"), "allow")
  f.git(P, "config", "branch.main.remote", "origin")
  writeFileSync(path.join(P, ".git", "config"), `${(await import("node:fs")).readFileSync(path.join(P, ".git", "config"), "utf8")}[remote "origin"]\n\tmirror\n`)
  assert.equal((await f.guard("git push -q")).reason, `Desk protected checkout ${P}: ${MESSAGES.pushForce}`)
  f.git(P, "config", "--unset-all", "remote.origin.mirror")
  // desk.protected spellings Git accepts, and a policy Git cannot read.
  for (const [value, protectedValue] of [["false", false], ["0", false], ["2", true], ["", false], ["on", true]]) {
    f.git(P, "config", "desk.protected", value)
    assert.equal((await f.guard("git stash")).deny, protectedValue, `desk.protected=${value}`)
  }
  f.git(P, "config", "desk.protected", "true")
  writeFileSync(path.join(f.root, "broken.cfg"), "[broken\n")
  f.git(P, "config", "include.path", path.join(f.root, "broken.cfg"))
  assert.match((await f.guard("git stash")).reason, /cannot read checkout protection/u)
  // A spent budget denies before any read starts.
  writeFileSync(path.join(f.root, "broken.cfg"), "")
  assert.match((await guardShellCommand({ command: "git checkout topic", cwd: P, env: f.env, budgetMs: 0 })).reason, /within its 0 s budget/u)
})

// Re-review 1 (task-A3b-rereview-1-evidence/rr1-variants.mjs, rr1-probes.mjs, rr1-probes2.mjs).
test("A3b re-review: every PowerShell assignment form runs the command it captures", async (t) => {
  const f = await fixture(t)
  const deny = [
    "$x=git stash", "$x =git stash", "${x} = git stash", "$x += git stash", "$x -= git stash", "$x ??= git stash",
    "$global:x = git stash", "$local:x = git stash", "$private:x = git stash", "$script:x = git stash",
    "[string]$x = git stash", "[string[]]$files = git stash", "[int]$n = (git stash).Count", "$a, $b = git stash",
    "$x = if ($true) { git stash }", "$x = switch (1) { 1 { git stash } }", "$x = try { git stash } catch { }",
    "$x = foreach ($i in 1) { git stash }", "$h = @{}; $h.x = git stash", "$h = @{}; $h['x'] = git stash",
    "$x = git stash; $x", "if (Test-Path x) { git stash; echo hi }", "$x = while ($false) { git stash }",
    "& (Get-Command git) checkout main", "& (Get-Command x) stash", "$x = @(git stash)", `$x = "$(git stash)"`,
  ]
  for (const command of deny) assert.equal((await f.guard(command, { powershell: true })).deny, true, command)
  const allow = [
    // Replay ruling, 2026-09-27: typed, scoped and expression forms run the Git they capture under the same rules.
    "[string]$b = git rev-parse --abbrev-ref HEAD", "$script:b = git rev-parse HEAD", "(git log).Count", "@(git status --short)", "$x = 'git stash'",
    "$x = git status", "$x=git status", "$x =git status", "$x= git status",
    "$s = git status --porcelain; if ($s) { 'dirty' }", "$files = git diff --name-only; foreach ($f in $files) { Write-Output $f }",
    "$out = git push -q origin main 2>&1", "$null = git fetch", "& (Get-Command node) --version",
    "$x = $y", "$n = 3", "[void]$x", "$x.Count", "if ($true) { 'y' } else { 'n' }", "$h = @{}; $h.x = 1", "$x += 'more'",
  ]
  for (const command of allow) {
    const result = await f.guard(command, { powershell: true })
    assert.equal(result.deny, false, `${command}: ${result.reason}`)
  }
  // Either branch of a control statement may run, so a location it changes does not hide the protected checkout.
  assert.equal((await f.guard(`if ($true) { Set-Location ${psq(f.own)} }; git stash`, { powershell: true })).deny, true)
  assert.equal((await f.guard(`Set-Location ${psq(f.own)}; git stash`, { powershell: true })).deny, false)
  assert.match((await f.guard("$x = (git stash", { powershell: true })).reason, /could not inspect this shell command \(unresolved PowerShell expression\)/u)
  // Text that does not parse is judged by the Git operations it names: status passes, stash does not.
  assert.equal((await f.guard("git status; }", { powershell: true })).deny, false)
  assert.match((await f.guard("git stash; }", { powershell: true })).reason, /could not inspect this shell command .*git stash could change a protected checkout/u)
  if (!pwsh) { t.diagnostic("native PowerShell unavailable; decisions still checked"); return }
  for (const command of ["[string]$x = git stash", "$script:x = git stash", "$x = if ($true) { git stash }"]) {
    const real = await fixture(t)
    writeFileSync(path.join(real.prot, "file.txt"), "another session's edit\n")
    spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { cwd: real.prot, env: real.env, encoding: "utf8" })
    assert.notEqual(real.git(real.prot, "stash", "list"), "", `${command} stashes when run`)
  }
})

test("A3b re-review: here-documents belong to the command that opens them, and literal pipes are scripts", async (t) => {
  const f = await fixture(t)
  const deny = [
    "bash <<'EOF' | tail -5\ngit stash\nEOF", "bash <<'EOF' 2>&1 | tee log.txt\ngit checkout -q --detach HEAD\nEOF",
    "bash <<'EOF' && echo done\ngit stash\nEOF", "sh <<'EOF'; echo done\ngit stash\nEOF", "bash <<'EOF' || true\ngit stash\nEOF",
    "{ bash <<'EOF'\ngit stash\nEOF\n} | cat", "bash << EOF\ngit stash\nEOF", "bash <<'EOF' > out.log 2>&1\ngit stash\nEOF",
    "printf '%s\\n' 'git stash' | sh", "printf 'git stash\\n' | bash", "echo -e 'git stash' | bash", "echo -ne 'git stash' | bash",
    "printf '%s %s\\n' git stash | bash",
  ]
  for (const command of deny) assert.equal((await f.guard(command)).deny, true, command)
  const allow = [
    // Replay ruling (2026-09-27): input Desk cannot read literally is unreadable code, which passes.
    "git show HEAD:x.sh | bash", "cat x.sh | bash", "printf '%d' 3 | bash",
    "cat <<'EOF' | wc -l\ngit stash\nEOF", "cat > a.md <<'EOF'\ngit stash\nEOF\ncat > b.md <<'EOF'\ngit checkout main\nEOF\ngit status --short",
    "git commit -q --allow-empty -F - <<'EOF'\nExplain git reset --hard\nEOF", "echo -n 'echo hi' | bash",
    "echo -E 'echo \\n' | sh", "printf '%%s' | bash", "echo -n | bash", "printf 'echo %s %s' a | bash",
    "cat <<'EOF' > notes.md && bash -n /dev/null\ngit stash is denied here\nEOF",
  ]
  for (const command of allow) {
    const result = await f.guard(command)
    assert.equal(result.deny, false, `${command}: ${result.reason}`)
  }
  // Real Bash runs the here-document through the command that opened it.
  const command = "bash <<'EOF' | tail -5\ngit stash\nEOF"
  writeFileSync(path.join(f.prot, "file.txt"), "another session's edit\n")
  spawnSync("bash", ["--noprofile", "--norc", "-c", command], { cwd: f.prot, env: f.env, encoding: "utf8" })
  assert.notEqual(f.git(f.prot, "stash", "list"), "")
})

test("A3b re-review: a computed directory with a known program name is that program", async (t) => {
  const f = await fixture(t)
  for (const command of ['"$(npm bin)/nx" reset', '"$(npm bin)/lerna" clean --yes', "lerna clean", '"$(brew --prefix)/bin/gmake" -C build clean', '"$(git rev-parse --show-toplevel)/scripts/check.sh"']) {
    assert.equal((await f.guard(command)).deny, false, command)
  }
  for (const command of ['"$(dirname x)/git" stash', "$(printf 'g%s' it) stash", "X=$(cat f); $X stash"]) assert.equal((await f.guard(command)).deny, true, command)
  for (const command of ['& "$(Get-Location)/nx" reset']) assert.equal((await f.guard(command, { powershell: true })).deny, false, command)
})

test("A3b re-review: ordinary chained work the guard can resolve soundly passes", async (t) => {
  const f = await fixture(t)
  const allow = [
    "git tag v2 && git push -q origin v2", "git tag -a v3 -m 'release v3' && git push -q origin v3", "git tag -m note v4 HEAD; git push -q origin v4",
    'cd "$(git rev-parse --show-toplevel)" && git pull -q', 'cd "$(git rev-parse --show-toplevel)" && git push -q',
  ]
  for (const command of allow) {
    const result = await f.guard(command)
    assert.equal(result.deny, false, `${command}: ${result.reason}`)
  }
  // Non-force pushes of any name pass (2026-09-27 ruling), and so does a pull whose checkout Desk cannot resolve.
  for (const command of [
    `git -C ${q(f.own)} tag v2 && git push -q origin v2`, "git tag -d v2 && git push -q origin v2", "git tag --contains HEAD && git push -q origin HEAD",
    'GIT_DIR=x; cd "$(git rev-parse --show-toplevel)" && git pull', 'cd /; cd "$(git rev-parse --show-toplevel)" && git pull',
  ]) assert.equal((await f.guard(command)).deny, false, command)
  for (const command of [
    'cd "$(git rev-parse --show-toplevel)" && git stash', 'GIT_DIR=x; cd "$(git rev-parse --show-toplevel)" && git stash',
    'cd /; cd "$(git rev-parse --show-toplevel)" && git stash', 'cd "$(pick)"; cd "$(git rev-parse --show-toplevel)" && git stash',
  ]) assert.equal((await f.guard(command)).deny, true, command)
  assert.equal((await f.guard('cd "$(git rev-parse --show-toplevel)" && git pull', { cwd: f.own })).deny, false)
  // The top level is the nearest ancestor with a .git entry; outside any checkout it is unknown.
  mkdirSync(path.join(f.prot, "sub"))
  assert.equal((await f.guard('cd "$(git rev-parse --show-toplevel)" && git stash', { cwd: path.join(f.prot, "sub") })).deny, true)
  assert.match((await f.guard(`cd ${q(f.root)} && cd "$(git rev-parse --show-toplevel)" && git stash`)).reason, /could not resolve which checkout/u)
  assert.equal((await f.guard(`cd ${q(f.own)} && cd "$(git rev-parse --show-toplevel)" && git stash`)).deny, false, "the toplevel of the ordinary clone")
  // The real sequence succeeds.
  const real = spawnSync("bash", ["--noprofile", "--norc", "-c", "git tag v2 && git push -q origin v2"], { cwd: f.prot, env: f.env, encoding: "utf8" })
  assert.equal(real.status, 0, real.stderr)
})

// Re-review 2 (task-A3b-rereview-2-evidence/rr2-probes.mjs and rr2-extra.mjs).
test("A3b re-review 2: every PowerShell group is its own command sequence and stands for an unknown value", async (t) => {
  const f = await fixture(t)
  const pwt = path.join(f.root, "pwt")
  f.git(f.own, "worktree", "add", "-q", "--detach", pwt, "HEAD")
  await protectCheckout({ root: pwt })
  writeFileSync(path.join(f.root, "b.txt"), "topic\n")
  mkdirSync(path.join(f.prot, "sub"))
  const deny = [
    ["Set-Location (git rev-parse --show-toplevel); git stash", path.join(f.prot, "sub")],
    ["cd (git rev-parse --show-toplevel); git checkout -q topic", f.prot],
    [`Set-Location (Join-Path ${psq(f.root)} 'prot'); git stash`, f.own],
    ["git checkout -q (git rev-parse HEAD~1)", f.prot],
    [`git checkout -q (Get-Content ${psq(f.root + "/b.txt")})`, f.prot],
    ["git (Write-Output stash)", f.prot],
    [`git -C (Join-Path ${psq(f.root)} 'prot') stash`, f.own],
    ["$a = @('stash'); git @a", f.prot],
    ["$a = 'checkout', '-q', 'topic'; git @a", f.prot],
    ["$h = @{ a = git stash }", f.prot],
    ["[pscustomobject]@{ Out = git stash }", f.prot],
    ["$h = @{ a = 1; b=git stash }", f.prot],
    ["$h = @{ a= git stash }", f.prot],
    ["foreach ($l in git stash) { $l }", f.prot],
    ["[ValidateNotNull()][string]$x = git stash", f.prot],
    ["[ValidateSet('a', 'b')][string]$x = git stash", f.prot],
    ["git switch -q (Write-Output topic)", f.prot],
    [`git worktree remove --force (Join-Path ${psq(f.root)} 'pwt')`, f.own],
    ["git reset -q --hard (git rev-parse HEAD~1)", f.prot],
    ["git switch -q topic; git branch -D (Write-Output main)", f.prot],
    ["& (Get-Command git) status", f.prot],
    ["$x = (Get-Content x | Where-Object { git stash })", f.prot],
  ]
  for (const [command, cwd] of deny) assert.equal((await f.guard(command, { cwd, powershell: true })).deny, true, command)
  const allow = [
    // Replay ruling, 2026-09-27 (reverses the round 4 allowlist for these): Git inside a group, subexpression, script
    // block, function or control statement runs as its own statement under the same rules, so read-only uses pass.
    ["cd (git rev-parse --show-toplevel); git pull -q --rebase origin main", path.join(f.prot, "sub")],
    ["git push -q origin (git branch --show-current)", f.prot],
    ['Write-Host "Branch: $(git branch --show-current)"', f.prot],
    [`git commit -q --allow-empty -m (Get-Content ${psq(f.root + "/b.txt")} -Raw)`, f.prot],
    ["if (git status --porcelain) { git add -A; git commit -q -m x }", f.prot],
    ["function Get-Br { git branch --show-current }; Get-Br", f.prot],
    ["$h = @{ a = 'git stash'; b = 2 }", f.prot],
    ["foreach ($f in (git diff --name-only)) { Write-Output $f }", f.prot],
    ["$top = git rev-parse --show-toplevel; cd $top; git pull -q --rebase origin main", path.join(f.prot, "sub")],
    ["$b = git branch --show-current; git push -q origin $b", f.prot],
    ["$b = git rev-parse --abbrev-ref HEAD; git push -q origin $b", f.prot],
    ["git status --porcelain | ForEach-Object { $_.Substring(3) }", f.prot],
    ["$a = @('status'); Write-Output @a", f.prot],
    ["$h = @{}; $h.x = 1; $e = @{ (1) = 2 }", f.prot],
  ]
  for (const [command, cwd] of allow) {
    const result = await f.guard(command, { cwd, powershell: true })
    assert.equal(result.deny, false, `${command}: ${result.reason}`)
  }
  assert.equal((await f.guard("$a = @('stash'); git @a", { powershell: true })).reason, POWERSHELL_GIT_FORMS)
  if (!pwsh) { t.diagnostic("native PowerShell unavailable; decisions still checked"); return }
  // Real PowerShell: the checkout, stash and worktree-removal forms change the protected state.
  const checkout = await fixture(t)
  spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "git checkout -q (git rev-parse HEAD~1)"], { cwd: checkout.prot, env: checkout.env })
  assert.equal(checkout.state().branch, "", "HEAD detached")
  const stash = await fixture(t)
  writeFileSync(path.join(stash.prot, "file.txt"), "another session's edit\n")
  spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$h = @{ a = git stash }"], { cwd: stash.prot, env: stash.env })
  assert.notEqual(stash.git(stash.prot, "stash", "list"), "")
  writeFileSync(path.join(pwt, "unsaved.txt"), "unsaved\n")
  spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `git worktree remove --force (Join-Path ${psq(f.root)} 'pwt')`], { cwd: f.own, env: f.env })
  assert.equal((await import("node:fs")).existsSync(pwt), false, "the protected worktree and its unsaved file are gone")
})

// Round 4 (S6): a tag counts whenever an earlier `git tag` names it and no local branch has its name; if that `git tag` is
// skipped or fails, Git cannot push a name nothing resolves.
test("A3b re-review 2: non-force pushes of any name pass, and here-documents piped into shells are scripts", async (t) => {
  const f = await fixture(t)
  for (const command of [
    "cat <<'EOF' | bash\ngit stash\nEOF", "bash -s -- x <<'EOF'\ngit stash\nEOF", "cat <<< 'git stash' | sh",
  ]) assert.equal((await f.guard(command)).deny, true, command)
  for (const command of [
    'test -n "$NOPE" && git tag topic; git push -q origin topic', "git tag topic no-such-rev; git push -q origin topic",
    "git tag v2 && git push -q origin v2", "git add -A && git tag v3; git push -q origin v3", "bash -c 'git tag v4'; git push -q origin v4",
    "if true; then git tag v5; fi; git push -q origin v5", "false || git tag v6; git push -q origin v6", "[ -f x ]; git tag v7; git push -q origin v7",
    '[ -z "$(git status --porcelain)" ] && git tag v8 && git push -q origin v8', "if git tag v9; then git push -q origin v9; fi",
    'git push -q origin "$(git branch --show-current)"', 'git push -q origin "$(git rev-parse --abbrev-ref HEAD)"',
    "cat <<'EOF' | bash\necho harmless\nEOF", "bash -s -- x <<'EOF'\necho \"$1\"\nEOF",
  ]) {
    const result = await f.guard(command)
    assert.equal(result.deny, false, `${command}: ${result.reason}`)
  }
  // A detached HEAD has no current branch to push by name; a worktree's HEAD is read through its .git file.
  const wt = path.join(f.root, "wt")
  f.git(f.prot, "worktree", "add", "-q", "-b", "wt-branch", wt, "HEAD")
  await protectCheckout({ root: wt })
  assert.equal((await f.guard('git push -q origin "$(git branch --show-current)"', { cwd: wt })).deny, false)
  writeFileSync(path.join(wt, ".git"), "not a gitdir line\n")
  assert.equal((await f.guard('git push -q origin "$(git branch --show-current)"', { cwd: wt })).deny, true, "an unreadable .git file leaves the branch unknown")
  assert.equal((await f.guard('cd / && git push -q origin "$(git branch --show-current)"')).deny, false, "outside any checkout nothing is protected")
  // Detached, the current branch is empty and Git rejects the empty refspec itself.
  f.git(f.prot, "switch", "-q", "--detach", "HEAD")
  assert.equal((await f.guard('git push -q origin "$(git branch --show-current)"')).deny, false)
  assert.equal((await f.guard('git push -q origin "$(git rev-parse --abbrev-ref HEAD)"')).deny, false, "pushing HEAD while detached fails in Git itself")
  // A refspec whose start is unknown could force or delete.
  assert.match((await f.guard('git push -q origin "$(pick)"')).reason, /could not resolve a push refspec/u)
  assert.match((await f.guard('cd "$(pick)" && git push -q origin "$(pick)"')).reason, /could not resolve which checkout/u)
  assert.equal((await f.guard('git push -q origin "HEAD:$(pick)"')).deny, false)
})
