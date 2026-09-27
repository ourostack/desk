#!/usr/bin/env node
"use strict";

// Desk's protected-checkout guard: a Claude PreToolUse and Copilot preToolUse hook on shell tools.
//
// Purpose. A checkout whose local Git config has desk.protected=true is shared by sessions.
// The guard keeps its HEAD on its state branch and keeps other sessions' work in place. It
// does not stop the desk's normal write protocol: committing and pushing the state branch.
//
// Allowed in a protected checkout: read-only Git (status, log, diff, show, fetch, rev-parse,
// ls-files, branch listing, remote -v, config --get ...), add, rm, mv, commit, commit --amend
// of an unpushed commit, push of the current branch (or tags) without force, mirror, delete
// or prune, pull and rebase onto the branch's own upstream while on the state branch,
// merge --ff-only, merge/rebase --continue/--abort, worktree add and worktree list.
//
// Denied: checkout/switch to another branch or a detached commit; reset --hard, --merge,
// --keep or a reset that moves HEAD; restore --source or --staged; clean; stash (except list
// and show); branch -f, -D, -m or -C of the current or state branch; other rebases and
// merges; --autostash; force, mirror, delete, prune and other-branch pushes; commit --amend
// of a pushed commit; worktree remove --force of a protected checkout; worktree prune;
// bisect. The deny message says what is protected and what to do instead.
//
// Commands the guard cannot fully resolve. The inspector never runs the command. A value it
// cannot compute (a $(...) or backtick substitution other than literal pwd, echo, printf '%s'
// or mktemp) is unknown. The guard fails closed only when an unknown value could decide a Git
// operation:
// - an unknown program whose own text, or the substitution that computed it, names `git`
//   (quotes and escapes removed) or evaluates code (eval, source, ., iex, Invoke-Expression);
// - an unknown eval, source/. or shell -c script;
// - an unknown directory, Git subcommand or operand for a Git operation the policy must check
//   (for example `cd "$(pick)" && git checkout main`; `cd "$(pick)" && git commit` passes).
// When the shell text cannot be parsed at all, it is denied only if it mentions `git` or
// evaluates code in the same sense. Everything else, such as `echo "$(date)"`,
// `cd "$wt" && node x.js` or `jq . f.json | grep x`, is allowed.
//
// Inspection runs Git only from a trusted system location, never the command's PATH or
// loader settings. Policy: ../mcp/src/runtime/git-guard-policy.js; shell model:
// ../mcp/src/runtime/shell-commands.js and powershell-commands.js; docs: ../docs/protected-checkouts.md.

const { pathToFileURL } = require("node:url");
const path = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const { protectedCheckoutHook } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/protected-checkout.js")).href);
    const output = await protectedCheckoutHook(JSON.parse(input), process.argv[2]);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`Desk protected-checkout guard could not inspect this command: ${error.message}\n`);
    process.exitCode = 2;
  }
});
