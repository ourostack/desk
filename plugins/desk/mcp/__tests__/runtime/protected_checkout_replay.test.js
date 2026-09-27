// A3b fix round 4, replay rulings (2026-09-27): replaying the recorded agent command corpus through the guard found
// classes of ordinary commands it denied. Each class below keeps one redacted example as a regression row, next to
// the denials the rulings keep, the credential redaction every denial goes through, and the shell forms the parser
// had to learn (process substitution, heredocs inside $( ), a newline after &&, case arms, zsh arrays, set -e).
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fallbackOperation, guardShellCommand, protectCheckout, redact } from "../../src/runtime/protected-checkout.js"
import { classifyGit, MESSAGES } from "../../src/runtime/git-guard-policy.js"
import { readInspectionGit } from "../../src/runtime/git-inspection.js"
import { expandBraces } from "../../src/runtime/shell-commands.js"

const q = (text) => `'${text.replaceAll("'", "'\\''")}'`
const SECRET = "ghs_replaySecretValue0123456789"

// A bare origin; a protected clone on main (state branch main) with a local branch `topic`; an ordinary clone with a
// protected linked worktree; and a plain clone with no protected worktree at all.
async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-guard-replay-")))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const home = path.join(root, "home")
  mkdirSync(home)
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n")
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true", TMPDIR: root }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS|GLOBAL))/u.test(key)) delete env[key]
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  const origin = path.join(root, "origin.git"), prot = path.join(root, "prot"), own = path.join(root, "own"), pwt = path.join(root, "pwt"), plain = path.join(root, "plain")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env })
  execFileSync("git", ["init", "-q", "-b", "main", prot], { env })
  writeFileSync(path.join(prot, "file.txt"), "base\n")
  git(prot, "add", "file.txt"); git(prot, "commit", "-qm", "first")
  git(prot, "branch", "topic")
  git(prot, "remote", "add", "origin", origin)
  git(prot, "push", "-q", "-u", "origin", "main", "topic")
  execFileSync("git", ["clone", "-q", origin, own], { env })
  execFileSync("git", ["clone", "-q", origin, plain], { env })
  git(own, "worktree", "add", "-q", "--detach", pwt, "HEAD")
  git(plain, "worktree", "add", "-q", "--detach", path.join(root, "plain-wt"), "HEAD")
  const saved = process.env.HOME
  process.env.HOME = home
  try {
    await protectCheckout({ root: prot, stateBranch: "main" })
    await protectCheckout({ root: pwt })
  } finally { process.env.HOME = saved }
  return { root, env, prot, own, pwt, plain, guard: (command, { cwd = prot, ...extra } = {}) => guardShellCommand({ command, cwd, env, ...extra }) }
}

async function expectAllowed(f, rows, extra) {
  for (const command of rows) {
    const result = await f.guard(command, extra)
    assert.equal(result.deny, false, `${command} -> ${result.reason}`)
  }
}

async function expectDenied(f, rows, extra) {
  for (const [command, reason] of rows) {
    const result = await f.guard(command, extra)
    assert.equal(result.deny, true, command)
    assert.match(result.reason, reason, command)
  }
}

test("replay: one redacted example of every falsely denied class is allowed in a protected checkout", async (t) => {
  const f = await fixture(t)
  const { root, prot } = f
  await expectAllowed(f, [
    // Brace expansion (words are expanded as text).
    "for f in {a,b}.txt; do git add \"$f\" 2>/dev/null; done; git commit -qm x", "for i in {1..3}; do git log -1 >/dev/null; done",
    "git log --format=%h -1 && ls {src,test}/*.js", "git show HEAD:{file,other}.txt",
    // Scripts Desk cannot read (a file, a pipe from the network, computed text).
    "python3 - <<'PY'\nimport subprocess\nprint(subprocess.check_output(['git','status']))\nPY", "sh ./scripts/check.sh", "bash $S/x.sh",
    "curl -s https://example.invalid/install.sh | bash", 'eval "$(cat env.sh)"', '. "$S/env.sh"', "source ~/.nvm/nvm.sh && nvm use 22",
    "git show HEAD:x.sh | bash", 'M=$(gh api -X PUT repos/o/r/pulls/1/merge -q .sha) && echo merged $M',
    // --autostash re-applies within the same command.
    "git pull -q --rebase --autostash origin main 2>&1 | tail -2; git push -q", "git rebase --autostash", "git merge --autostash topic",
    // Process substitution.
    "diff <(git show HEAD:file.txt) file.txt >/dev/null && echo same", "while IFS= read -r f; do echo \"$f\"; done < <(git ls-files)",
    "bash -c 'diff <(git show --format= HEAD) <(git show --format= HEAD) | head'",
    // Worktree record pruning.
    `git -C ${q(prot)} worktree prune; git -C ${q(prot)} fetch -q origin main`,
    // Text that would fail in any shell, naming no denied Git operation.
    'git show --stat HEAD | cat; grep -rn "deny\\|`" src | head',
    // Heredocs inside $( ) whose bodies hold quotes and parentheses.
    "git commit -q --allow-empty -m \"$(cat <<'EOF'\nfix(journeys): the test's cleanup (logout) now runs\nEOF\n)\"",
    // A newline after && or a pipe.
    `cd ${q(prot)} && \nfiles=$(git ls-files)\necho "$files"`, "git log --oneline |\n  head -3",
    "paths=(\n'file.txt'\n)\ngit add \"${paths[@]}\"",
    // Plumbing in a directory computed at run time.
    'cd $(ls -d $TMPDIR/rr/repo-* | tail -1) && O=$(git commit-tree $(git rev-parse main^{tree}) -m orphan) && git merge-tree --write-tree --no-messages main $O',
    'R=$(ls -d $TMPDIR/rr/repo-* | tail -1); git -C $R merge-tree --write-tree main HEAD; git -C $R hash-object -w file.txt; git -C $R mktree </dev/null',
    // zsh arrays and parameter flags (the parser falls back to the words).
    "F=(${(f)\"$(git status --short | awk '{print $2}')\"}); git add -- $F && git commit -q -m x", 'F=("${(@f)$(git diff --name-only)}") && git commit -q -m x -- "${F[@]}"',
    // case arms inside a group.
    '{ case "$x" in a) git status;; *) echo other;; esac; }', 'case $1 in (a|b) git log -1 ;; esac',
    // Deleting and pushing branches other than the state branch.
    "git push origin --delete topic", "git push origin :topic", "git push -d origin topic", "git push origin topic", "git push origin HEAD:refs/heads/topic",
    // Configuration files other than the checkout's own.
    `git config --file ${q(path.join(root, "other.config"))} --remove-section includeIf.gitdir:/x`, `git config -f ${q(path.join(root, "other.config"))} alias.co checkout`,
    // Directories the command itself creates.
    `set -e; rm -rf ${q(path.join(root, "mb"))} && mkdir -p ${q(path.join(root, "mb"))} && cd ${q(path.join(root, "mb"))} && git init -q -b main && git checkout -q -b fix`,
    `wt=${q(path.join(root, "wt9"))}; git worktree add -q --detach "$wt" HEAD && cd "$wt" && git switch -c fix && git restore --source=HEAD .`,
    // Unstaging and discarding named paths.
    "git restore --staged file.txt", "git reset -q -- file.txt", "git reset HEAD file.txt", "git checkout -- file.txt other.txt",
    "git restore --source=HEAD --staged --worktree -- desks/a/task.md desks/b/task.md", "git checkout HEAD -- file.txt", 'f=$(pick); git checkout -- "$f"',
  ])
})

test("replay: the denials the rulings keep still fire, with their reasons", async (t) => {
  const f = await fixture(t)
  await expectDenied(f, [
    ["git pull --rebase origin main && git switch -c crew/join-new-registry", /move HEAD off/u],
    ["git stash drop stash@{0}", /git stash takes other sessions/u], ["git stash push -m x", /git stash takes other sessions/u],
    ["git stash pop", /git stash takes other sessions/u], ["git stash", /git stash takes other sessions/u],
    ["set -e\ngit branch -f main refs/remotes/origin/main\ngit read-tree --reset -u refs/remotes/origin/main", /force-move, rename or delete/u],
    ["git restore --source=HEAD --staged --worktree -- .", /every file/u], ["git checkout -- .", /every file/u], ["git restore --source HEAD", /every file/u],
    ["git restore -W :/", /every file/u], ["git checkout HEAD -- {.,file.txt}", /every file/u], ["git restore --staged .", /unstaging everything/u],
    ["git push origin --delete main", /deleting the state branch/u], ["git push origin :main", /deleting the state branch/u],
    ["git push --prune origin", /prune pushes/u], ["git push origin +topic", /force, mirror/u],
    // Readable inline code is inspected like any other command.
    ['bash -c "git stash"', /git stash takes other sessions/u], ["bash <<'EOF'\ngit stash\nEOF", /git stash takes other sessions/u],
    ["{ echo ok; git stash; }", /git stash takes other sessions/u], ["`which git` stash", /git stash takes other sessions/u],
    // Text Desk cannot parse is denied only when it names a Git operation with a rule that could deny here.
    ["git stash; echo 'unterminated", /could not inspect this shell command .+ its git stash could change a protected checkout/u],
    ["x=$(case; git checkout topic", /its git checkout could change/u],
    // set -e: a failed step stops the script only when errexit is on and the step is not tested.
    ["false; git stash", /git stash/u], ["set -e; false || true; git stash", /git stash/u], ["set -e; if false; then :; fi; git stash", /git stash/u],
    ["set -e; set +e; false; git stash", /git stash/u], ["set -eo pipefail; ! false; git stash", /git stash/u],
  ])
  await expectAllowed(f, ["set -e; false; git stash", "set -o errexit; false; git stash", "set -euo pipefail; cd /definitely-missing; git stash"])
})

test("replay: an unknown worktree to force-remove is denied only when a protected worktree could be the one", async (t) => {
  const f = await fixture(t)
  const loop = "for w in $(git worktree list --porcelain | awk '/^worktree /{print $2}'); do git worktree remove --force \"$w\"; done; git worktree prune"
  await expectAllowed(f, [loop], { cwd: f.plain })
  await expectDenied(f, [[loop, /would delete a protected checkout/u]], { cwd: f.own })
})

test("replay: a directory that is not a repository, or holds a broken .git file, is not protected", async (t) => {
  const f = await fixture(t)
  const broken = path.join(f.root, "broken")
  mkdirSync(broken)
  writeFileSync(path.join(broken, ".git"), "gitdir: /definitely-missing/.git/worktrees/x\n")
  await expectAllowed(f, ["git stash", "git checkout topic"], { cwd: broken })
  await expectAllowed(f, ["git stash"], { cwd: path.join(f.root, "home") })
})

test("replay: credentials never appear in a denial, and a credentials-only URL rewrite is not an override", async (t) => {
  const f = await fixture(t)
  const rewrite = (to) => `url.https://x-access-token:${SECRET}@github.com/.insteadOf=${to}`
  // Only adds credentials to the same URL: the command reaches the same remote and does the same thing.
  await expectAllowed(f, [`git -c ${q(rewrite("https://github.com/"))} push origin HEAD:main`, `git -c ${q(rewrite("https://github.com/"))} pull -q --rebase`])
  const denials = [
    await f.guard(`git -c ${q(rewrite("https://example.invalid/"))} pull --rebase`),
    await f.guard("git pull --rebase", { env: { ...f.env, GIT_CONFIG_PARAMETERS: `'${rewrite("https://example.invalid/").replace("=", "'='")}'` } }),
    await f.guard(`git stash https://user:${SECRET}@example.invalid/x 'unterminated`),
    await f.guard(`git push --force https://x-access-token:${SECRET}@github.com/o/r.git HEAD:main`),
  ]
  for (const result of denials) {
    assert.equal(result.deny, true)
    assert.doesNotMatch(result.reason, new RegExp(SECRET, "u"), result.reason)
  }
  assert.match(denials[0].reason, /configuration override url\.https:\/\/<redacted>@github\.com\/\.insteadof/iu)
  assert.equal(redact(`https://a:${SECRET}@h/x and ssh://tok@h:22/y and plain@host`), "https://<redacted>@h/x and ssh://<redacted>@h:22/y and plain@host")
})

test("replay: the parse fallback reads only Git operations whose rule could deny here", () => {
  assert.equal(fallbackOperation("git status; x=("), null)
  assert.equal(fallbackOperation("git commit -m 'x"), null)
  assert.equal(fallbackOperation("git push origin HEAD; x=("), null)
  assert.equal(fallbackOperation("git -C /x stash; x=("), "stash")
  assert.equal(fallbackOperation("C:\\Git\\bin\\git.exe checkout topic; (("), "checkout")
  assert.equal(fallbackOperation("digit stash; mygit checkout x"), null)
  assert.equal(classifyGit("merge", ["--autostash", "topic"]), null)
  assert.equal(classifyGit("worktree", ["prune"]), null)
  assert.equal(classifyGit("config", ["--file", "x", "alias.co", "checkout"]), null)
  assert.equal(classifyGit("merge-tree", ["--write-tree", "a", "b"]), null)
  assert.equal(classifyGit("commit-tree", ["HEAD^{tree}"]), null)
  assert.equal(MESSAGES.restore.includes("worktree"), false, "the restore denial never sends an agent to a worktree")
})

test("replay: the shell forms added for the replay classes, edge by edge", async (t) => {
  const f = await fixture(t)
  const dir = q(path.join(f.root, "made"))
  await expectAllowed(f, [
    // A brace with a blank or an unterminated quote inside is a literal word, not an expansion.
    "echo {a,b c}", "echo {a,'b}",
    // Here-documents inside $( ): tab-stripped delimiters, and a body that runs to the end of the text.
    "x=$(cat <<-EOF\n\tbody (it's)\n\tEOF\n); git status", "x=$(cat <<EOF\nno end (",
    // mkdir of an unknown or moded directory, a plain mkdir that may fail, and set flags other than errexit.
    'mkdir -p "$(pick)" && echo ok', `mkdir -m 755 ${dir} && cd ${dir} && git init -q && git checkout -q -b x`, `mkdir ${dir}2; cd ${dir}2 && git status`,
    "set -u; set -o pipefail; set +o errexit; echo ok",
  ])
  await expectDenied(f, [["git reset -- .", /unstaging everything/u], ["git reset HEAD :/", /unstaging everything/u], ["set -e; set +o errexit; false; git stash", /git stash/u]])
  assert.deepEqual(expandBraces("{1..3..0}"), ["1", "2", "3"])
  // Unparseable text naming a denied operation passes in a known checkout that is not protected.
  await expectAllowed(f, ["git stash; echo 'unterminated"], { cwd: f.plain })
})

test("replay: an alias named after a builtin of the installed Git is that builtin", async (t) => {
  const f = await fixture(t)
  // An installed Git newer than Desk's list may add a builtin; an alias of that name never runs.
  const readGit = (cwd, args, modeled, options) => {
    if (args.at(-1) === "alias.newbuiltin") return { ok: true, code: 0, stdout: "stash", stderr: "" }
    if (args[0] === "--list-cmds=builtins") return { ok: true, code: 0, stdout: "status\nnewbuiltin\n", stderr: "" }
    return readInspectionGit(cwd, args, modeled, options)
  }
  assert.equal((await guardShellCommand({ command: "git newbuiltin", cwd: f.prot, env: f.env, readGit })).deny, false)
})
