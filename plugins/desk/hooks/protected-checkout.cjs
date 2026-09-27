#!/usr/bin/env node
"use strict";

// Desk's protected-checkout guard: a Claude PreToolUse and Copilot preToolUse hook on shell tools.
//
// Threat model (controller ruling, fix round 1). The guard stops well-intentioned agents from
// accidentally moving a shared checkout off its state branch or discarding other sessions'
// work. It is not a sandbox against a determined adversary. It must deny every spelling an
// agent would plausibly produce, fail closed only where it cannot tell which program runs, and
// always answer within the hosts' 10 s hook deadline: inspection has one 7 s budget and one
// 20,000-step budget across all Bash and PowerShell inspection and its Git reads (denying, with
// a reason that names the budget, when either runs out), it yields to the event loop as it
// goes, and this entry point answers "deny" at 9 s whatever happens.
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
// --keep, a reset that moves HEAD, and mixed resets that unstage (like restore --staged);
// restore --source or --staged; clean; stash (except list and show); branch -f, -D, -m, -C
// or -u of the current or state branch; other rebases and merges; pulls from another
// repository or branch; --autostash; force, mirror, delete, prune and other-branch pushes,
// including through saved remote.<name>.mirror/push or push.default=matching; fetches into
// the checkout's branch; commit --amend of a pushed commit; worktree remove --force of a
// protected checkout; worktree prune; bisect; git config writes to the desk, alias, include,
// remote, push, branch, rebase, pull, merge, fetch and url sections; and push, pull, rebase,
// fetch or merge under a -c, --config-env or GIT_CONFIG_* override of the configuration those
// rules trust. Aliases from any of those sources are expanded, case-insensitively, with the
// issuing command's options. The deny message says what is protected and what to do instead.
//
// Commands the guard cannot fully resolve. The inspector never runs the command. A value it
// cannot compute (a $(...) or backtick substitution other than literal pwd, echo, printf '%s'
// or mktemp) is unknown. The guard fails closed only when an unknown value could decide a Git
// operation:
// - an unknown program whose own text, or the substitution that computed it, names `git`
//   (quotes and escapes removed) or evaluates code (eval, source, ., iex, Invoke-Expression);
//   an unknown program whose arguments read like Git (-C, -c, --git-dir, --work-tree,
//   --config-env, or a checked subcommand such as checkout) is judged as Git;
// - an unknown eval, source/. or shell -c script;
// - an unknown directory, Git subcommand or operand for a Git operation the policy must check
//   (for example `cd "$(pick)" && git checkout main`; `cd "$(pick)" && git commit` passes).
// A program whose name is unknown is judged as Git when its arguments read like Git; a computed
// directory with a known name ("$(npm bin)/nx") is that program. `git rev-parse --show-toplevel`
// resolves to the checkout containing the directory, and a tag an earlier `git tag` creates counts.
// A here-document (attached to the command that opened it), here-string or literal echo/printf
// piped into a shell is inspected as that shell's script; a script piped or redirected into a
// shell that Desk cannot read literally fails closed. A tag an earlier `git tag` creates counts
// unless a local branch has its name.
//
// PowerShell (fix round 4 ruling) is a closed allowlist. A command that names `git` (git.exe, or
// a path ending in either) passes only when each statement naming it is `git <args>`,
// `$name = git <args>`, or `git <args>` piped to Out-String, Select-String, Select-Object,
// Where-Object, ForEach-Object, Measure-Object, Sort-Object, Out-Null or Write-Output with no Git
// inside, each argument literal text or a plain $variable (an unknown one takes its most dangerous
// reading). Anything else that names Git is denied with a request for separate plain git commands.
// Statements without Git are walked for their location, variables and environment; whatever may
// or may not run leaves what it could change unknown.
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
// The hosts stop a hook at 10 s; answer first, and deny, if inspection has not finished at 9 s.
const deadline = setTimeout(() => {
  const decision = { permissionDecision: "deny", permissionDecisionReason: "Desk could not finish checking this command in time, so it is denied to keep a protected checkout safe. Retry it, or work in your own worktree: git worktree add --detach \"$(mktemp -d)\" <ref>" };
  process.stdout.write(`${JSON.stringify(process.argv[2] === "claude" ? { hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } } : decision)}\n`);
  process.exit(0);
}, Number(process.env.DESK_GUARD_DEADLINE_MS) || 9000);
process.stdin.on("end", async () => {
  try {
    const { protectedCheckoutHook } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/protected-checkout.js")).href);
    const output = await protectedCheckoutHook(JSON.parse(input), process.argv[2]);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`Desk protected-checkout guard could not inspect this command: ${error.message}\n`);
    process.exitCode = 2;
  } finally {
    clearTimeout(deadline);
  }
});
