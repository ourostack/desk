// Finding `git … commit` invocations in a shell command, in memory only.
// Every command here is invented. The function returns only directories
// (never any other part of the command), which the last test proves by
// planting a sentinel in the commit message.

import { test } from "node:test"
import assert from "node:assert/strict"

import { DESK_MARKER, gitCommitCwds } from "../../src/factory/shell-git.js"

const BASE = "/base/repo"
const HOME = "/home/someone"
const find = (command, overrides = {}) => gitCommitCwds({ command, cwd: BASE, home: HOME, ...overrides })

test("a plain or quiet git commit runs in the call's cwd", () => {
  assert.deepEqual(find("git commit -q -m \"update the card\""), [BASE])
  assert.deepEqual(find("git commit"), [BASE])
  assert.deepEqual(find("/usr/bin/git commit -q"), [BASE])
})

test("-C sets the directory, relative -C resolves against the cwd, and several -C options chain", () => {
  assert.deepEqual(find("git -C /abs/desk commit -m x"), ["/abs/desk"])
  assert.deepEqual(find("git -C sub commit -m x"), ["/base/repo/sub"])
  assert.deepEqual(find("git -C a -C b commit"), ["/base/repo/a/b"])
  assert.deepEqual(find("git -C /x -C ../y commit"), ["/y"])
})

test("global options before the subcommand are skipped, with or without a value", () => {
  assert.deepEqual(find("git -c user.name=\"Ari Mendelow\" -c user.email=a@b.c commit -q -m done"), [BASE])
  assert.deepEqual(find("git --no-pager -p commit"), [BASE])
  assert.deepEqual(find("git --namespace ns --config-env a=B --super-prefix p commit"), [BASE])
})

test("other subcommands, git words in arguments, lookalike subcommands and comments never match", () => {
  for (const command of [
    "git status",
    "git log --grep commit",
    "git commit-tree HEAD^{tree}",
    "echo git commit",
    "git show commit",
    "# git commit",
    "git",
    "git -C",
    "git -C commit",
    "gitx commit",
  ]) {
    assert.deepEqual(find(command), [], command)
  }
})

test("cd earlier in the same command moves later commits; separators inside quotes do not split", () => {
  assert.deepEqual(find("cd /d && git add x && git commit -q -m \"a && b; c | d\""), ["/d"])
  assert.deepEqual(find("cd /d; git commit -m 'one; two'"), ["/d"])
  assert.deepEqual(find("cd /p >/dev/null || exit 1\ngit commit"), ["/p"])
  assert.deepEqual(find("cd sub && git -C inner commit"), ["/base/repo/sub/inner"])
  assert.deepEqual(find("(cd /s && git commit) & wait"), ["/s"])
  assert.deepEqual(find("cd -P /q && git commit"), ["/q"])
})

test("--git-dir, --work-tree, GIT_DIR and GIT_WORK_TREE point Git elsewhere, so the directory is unknown", () => {
  for (const command of [
    "git --git-dir=/other/.git commit",
    "git --git-dir /other/.git commit",
    "git --work-tree /other commit",
    "git --work-tree=/other commit",
    "GIT_DIR=/other/.git git commit",
    "GIT_WORK_TREE=/other git commit",
    "env GIT_DIR=/other/.git git commit",
    "export GIT_DIR=/other/.git; git commit",
    "GIT_WORK_TREE=/other; git commit",
    "git --git-dir=/other/.git -c a=b --no-pager commit",
    "git --work-tree /other -C sub commit",
  ]) {
    assert.deepEqual(find(command), [null], command)
  }
  assert.deepEqual(find("git --git-dir=/other/.git status && git --work-tree /o log --grep commit"), [])
  assert.deepEqual(find("git --work-tree"), [])
  // A word that only looks like one, inside a message, changes nothing.
  assert.deepEqual(find("git commit -m \"GIT_DIR=x\" && echo GIT_WORK_TREE=y && git commit"), [BASE])
  assert.deepEqual(find("A=1 git commit"), [BASE])
  const ps = (command) => gitCommitCwds({ command, cwd: "C:\\base", home: "C:\\Users\\me", dialect: "powershell" })
  assert.deepEqual(ps("$env:GIT_DIR = \"C:\\other\\.git\"; git commit"), [null])
  assert.deepEqual(ps("$env:git_work_tree='C:\\o'; git commit"), [null])
})

test("pushd, popd and subshells are not modeled: the directory becomes unknown until an absolute cd", () => {
  assert.deepEqual(find("cd /other && pushd $DESK && popd && git commit"), [null])
  assert.deepEqual(find("pushd /other && popd && git commit"), [null])
  assert.deepEqual(find("pushd /p >/dev/null || exit 1\ngit commit"), [null])
  assert.deepEqual(find("(cd /other && git commit); git commit"), ["/other", null])
  assert.deepEqual(find("cd /d && (git commit)"), [null])
  assert.deepEqual(find("(true); cd /again && git commit"), ["/again"])
  const ps = (command) => gitCommitCwds({ command, cwd: "C:\\base", home: "C:\\Users\\me", dialect: "powershell" })
  assert.deepEqual(ps("Push-Location D:\\x; Pop-Location; git commit"), [null])
})

test("two commits in one command are both found, and the same directory is reported once", () => {
  assert.deepEqual(find("git commit -m a && git -C /x commit -m b"), [BASE, "/x"])
  assert.deepEqual(find("git commit -m a; git commit -m b"), [BASE])
})

test("assignments and wrapper words before git are skipped", () => {
  assert.deepEqual(find("GIT_AUTHOR_DATE=now GIT_COMMITTER_DATE=now git commit"), [BASE])
  assert.deepEqual(find("env A=1 git commit"), [BASE])
  assert.deepEqual(find("command git commit"), [BASE])
  assert.deepEqual(find("time nohup git commit"), [BASE])
})

test("a heredoc body is never read as commands, quoted or not", () => {
  const quoted = "git commit -F - <<'EOF'\ncd /evil\ngit -C /other commit\nEOF\ngit -C /y commit"
  assert.deepEqual(find(quoted), [BASE, "/y"])
  const unquoted = "git commit -F - <<-EOF\n\tgit -C /other commit\n\tEOF\n"
  assert.deepEqual(find(unquoted), [BASE])
  const doubleQuoted = "cat <<\"END\" > f\ngit -C /other commit\nEND\ngit commit"
  assert.deepEqual(find(doubleQuoted), [BASE])
  // The Claude Code habit: a heredoc inside a double-quoted command substitution.
  const substituted = "git commit -q -m \"$(cat <<'EOF'\nsubject; git -C /other commit\n\nbody\nEOF\n)\""
  assert.deepEqual(find(substituted), [BASE])
  // A here-string (`<<<`) is not a heredoc.
  assert.deepEqual(find("git commit -F - <<< msg\ngit -C /z commit"), [BASE, "/z"])
  // An unterminated heredoc swallows the rest.
  assert.deepEqual(find("git commit -F - <<EOF\ngit -C /never commit"), [BASE])
  // Space before the delimiter is allowed.
  assert.deepEqual(find("git commit -F - << END\ngit -C /o commit\nEND"), [BASE])
  // A heredoc operator with no delimiter word is ignored.
  assert.deepEqual(find("git commit <<"), [BASE])
})

test("$DESK and its braced form become the desk marker, which later relative steps extend", () => {
  assert.deepEqual(find("git -C \"$DESK\" commit"), [DESK_MARKER])
  assert.deepEqual(find("git -C ${DESK}/sub commit"), [`${DESK_MARKER}/sub`])
  assert.deepEqual(find("cd $DESK && git -C track commit"), [`${DESK_MARKER}/track`])
  assert.deepEqual(find("cd \"$DESK\" && cd .. && git commit"), [null])
  assert.deepEqual(find("cd $DESK && git -C /abs commit"), ["/abs"])
})

test("~ and $HOME expand to the home folder; no home means unresolved", () => {
  assert.deepEqual(find("git -C ~/desk commit"), ["/home/someone/desk"])
  assert.deepEqual(find("git -C ~ commit"), [HOME])
  assert.deepEqual(find("git -C \"$HOME/desk\" commit"), ["/home/someone/desk"])
  assert.deepEqual(find("cd && git commit"), [HOME])
  assert.deepEqual(find("git -C ~/desk commit", { home: undefined }), [null])
  assert.deepEqual(find("cd && git commit", { home: null }), [null])
})

test("an unresolvable directory gives a null cwd, never a guess", () => {
  assert.deepEqual(find("git -C \"$OTHER\" commit"), [null])
  assert.deepEqual(find("git -C `pwd` commit"), [null])
  assert.deepEqual(find("cd - && git commit"), [null])
  assert.deepEqual(find("git -C rel commit", { cwd: null }), [null])
  assert.deepEqual(find("git commit", { cwd: undefined }), [null])
  assert.deepEqual(find("git -C /abs commit", { cwd: null }), ["/abs"])
})

test("escapes and mixed quoting are unquoted like a shell would", () => {
  assert.deepEqual(find("git -C my\\ dir commit"), ["/base/repo/my dir"])
  assert.deepEqual(find("git -C \"a \\\"b\\\"\" commit"), ["/base/repo/a \"b\""])
  assert.deepEqual(find("git -C \"x\\y\" commit"), ["/base/repo/x\\y"])
  assert.deepEqual(find("git commit -m 'it'\"'\"'s' && git -C '/q r' commit"), [BASE, "/q r"])
  assert.deepEqual(find("git commit -m \"line\\\nnext\""), [BASE])
  assert.deepEqual(find("git -C \"\" commit"), [BASE])
  assert.deepEqual(find("git commit # trailing comment -C /x"), [BASE])
  assert.deepEqual(find("git commit -m x#y"), [BASE])
  assert.deepEqual(find("git commit -m \"unterminated"), [BASE])
  assert.deepEqual(find("git commit 2>&1 | tail -1"), [BASE])
})

test("command substitutions are one unknown word, and nothing inside them is read as a command", () => {
  assert.deepEqual(find("git -C $(pwd) commit"), [null])
  assert.deepEqual(find("git -C $(cd /x && git -C /y commit; pwd) commit"), [null])
  assert.deepEqual(find("git -C $(dirname $(pwd)) commit"), [null])
  assert.deepEqual(find("git -C `echo a b` commit"), [null])
  assert.deepEqual(find("git -C \"`pwd`/x\" commit"), [null])
  assert.deepEqual(find("git commit -m $(unclosed"), [BASE])
  assert.deepEqual(find("git commit -m `unclosed"), [BASE])
})

test("line continuations, a trailing backslash, bare assignments and lone redirections are harmless", () => {
  assert.deepEqual(find("git \\\ncommit -q"), [BASE])
  assert.deepEqual(find("git commit \\"), [BASE])
  assert.deepEqual(find("A=1; > out.txt; git commit"), [BASE])
})

test("an unknown dialect is read as a POSIX shell", () => {
  assert.deepEqual(gitCommitCwds({ command: "git -C sub commit", cwd: BASE, home: HOME, dialect: "fish" }), ["/base/repo/sub"])
})

test("a non-string command finds nothing", () => {
  for (const command of [undefined, null, 42, {}]) assert.deepEqual(find(command), [])
})

test("PowerShell: backslashes are literal, backtick escapes, Windows paths and $env:DESK resolve", () => {
  const ps = (command, cwd = "C:\\base") => gitCommitCwds({ command, cwd, home: "C:\\Users\\me", dialect: "powershell" })
  assert.deepEqual(ps("git -C C:\\Users\\me\\desk commit -m \"x\""), ["C:\\Users\\me\\desk"])
  assert.deepEqual(ps("git -C sub commit"), ["C:\\base\\sub"])
  assert.deepEqual(ps("Set-Location -Path D:\\d; git commit -m 'it''s'"), ["D:\\d"])
  assert.deepEqual(ps("sl $env:DESK; git commit"), [DESK_MARKER])
  assert.deepEqual(ps("Set-Location \"$env:DESK\\track\"; git commit"), [`${DESK_MARKER}/track`])
  assert.deepEqual(ps("git -C $env:USERPROFILE\\desk commit"), ["C:\\Users\\me\\desk"])
  assert.deepEqual(ps("git -C $HOME commit"), ["C:\\Users\\me"])
  assert.deepEqual(ps("git -C ~\\desk commit"), ["C:\\Users\\me\\desk"])
  assert.deepEqual(ps("git commit -m \"a`\"b\" && git.exe -C E:\\e commit"), ["C:\\base", "E:\\e"])
  assert.deepEqual(ps("& git commit"), ["C:\\base"])
  assert.deepEqual(ps("git -C $other commit"), [null])
  assert.deepEqual(ps("cd; git commit"), [null])
  assert.deepEqual(ps("git commit -m `$x"), ["C:\\base"])
  assert.deepEqual(ps("git -C `$lit commit"), ["C:\\base\\$lit"])
})

test("nothing but directories ever comes back: the commit message and other arguments are not returned", () => {
  const MESSAGE_SENTINEL = "COMMIT-MESSAGE-SENTINEL-9b1e"
  const result = find(`git add ${MESSAGE_SENTINEL}.md && git -c user.name="${MESSAGE_SENTINEL}" commit -q -m "${MESSAGE_SENTINEL}" --author="${MESSAGE_SENTINEL} <x@y>"`)
  assert.deepEqual(result, [BASE])
  assert.equal(JSON.stringify(result).includes(MESSAGE_SENTINEL), false)
})
