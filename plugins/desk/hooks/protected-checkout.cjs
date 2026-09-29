#!/usr/bin/env node
"use strict";

// Desk's protected-checkout guard: a Claude PreToolUse and Copilot preToolUse hook on shell tools.
//
// Threat model (controller ruling, fix round 1). The guard stops well-intentioned agents from
// accidentally moving a shared checkout off its state branch or discarding other sessions'
// work. It is not a sandbox against a determined adversary. It must deny every spelling an
// agent would plausibly produce, fail closed only where a value it cannot compute decides a
// checked Git operation, and always answer within the hosts' 10 s hook deadline: inspection has
// one 7 s budget and one 20,000-step budget across all Bash and PowerShell inspection and its
// Git reads (denying, with a reason that names the budget, when either runs out), it yields to
// the event loop as it goes, and this entry point answers "deny" at 9 s whatever happens.
//
// Purpose (narrowed on 2026-09-27). A checkout whose local Git config has desk.protected=true is
// shared by sessions. The guard denies only what moves its HEAD off its state branch, rewrites
// pushed history, or discards other sessions' work. Everything else is allowed, and no denial
// sends an agent to a worktree for an ordinary desk write.
//
// Allowed in a protected checkout: read-only Git, plumbing that leaves HEAD and the tree alone,
// add, rm, mv, commit, commit --amend of an unpushed commit, unstaging or restoring named paths
// (globs that name files too), non-force pushes of any branch or tag, deleting another branch on
// the remote, every merge, pull and rebase onto the state branch's own upstream (with or without
// --autostash or rebase/merge.autoStash), config writes to another file, worktree add, list and
// prune.
//
// Denied: checkout/switch to another branch or a detached commit; reset --hard, --merge, --keep and
// a reset that moves HEAD; unstaging or restoring any pathspec that covers the checkout root (no
// path, . or .. spelled any way, :/, wildcard-only patterns such as * and */, magic and exclude
// pathspecs, the root as an absolute path such as "$PWD", or --pathspec-from-file); symbolic-ref
// HEAD to another ref; update-ref of HEAD, the current or the state branch; read-tree -u with
// --reset or -m; checkout-index -f of -a, --stdin or root-covering paths; clean; stash (except list
// and show); branch -f, -D, -m, -C or -u of the current or state branch; other rebases; pulls with
// --rebase from another repository or branch; force, mirror and prune pushes and deleting the state
// branch on the remote, including through saved remote.<name>.mirror/push or push.default=matching;
// fetches into the checkout's branch; commit --amend of a pushed commit; worktree remove --force of
// a protected checkout; bisect; git config writes to the checkout's own desk, alias, include,
// remote, push, branch, rebase, pull, merge, fetch and url sections; and push, pull, rebase, fetch
// or merge under a -c, --config-env or GIT_CONFIG_* override of the configuration those rules trust
// (an insteadOf that only adds credentials to the same URL is not an override). Aliases from any of
// those sources are expanded, case-insensitively, with the issuing command's options. The deny
// message says what is protected and what to do instead, and credentials (URL user information,
// scp-style token users, Authorization values, known token prefixes) are redacted from it and from
// the hook's own error message.
//
// Commands the guard cannot fully resolve. The inspector never runs the command. A value it
// cannot compute (a $(...) or backtick substitution other than literal pwd, echo, printf '%s'
// or mktemp) is unknown. The guard fails closed only when an unknown directory, Git
// subcommand or operand decides a Git operation the policy must check (for example
// `cd "$(pick)" && git checkout main`; `cd "$(pick)" && git commit` passes), or when an
// unknown worktree to force-remove could be a protected one. An unknown program is judged as
// Git only when its arguments read like Git (-C, -c, --git-dir, --work-tree, --config-env, or a
// checked subcommand such as checkout). Code Desk cannot read passes (a script file, source,
// `cat x | bash`, `curl ... | sh`, `eval "$(...)"`); inline code it can read (`bash -c "..."`, a
// here-document or literal echo piped into a shell) is inspected like any other command.
// `git rev-parse --show-toplevel` resolves to the checkout containing the directory, and a tag an
// earlier `git tag` creates counts unless a local branch has its name. Brace expansion, process
// substitution, set -e, and directories the command itself creates are modeled.
//
// PowerShell (fix round 4 ruling, narrowed on 2026-09-27) runs each Git call through the same
// policy, wherever it appears: Git inside groups, subexpressions, script blocks, control
// statements, functions, Invoke-Command, `& git`, a variable whose known value is Git, and a
// literal iex, [scriptblock]::Create or shell script runs as its own statement. A statement that
// names Git in its own text must be `git <args>`, `$name = git <args>`, or `git <args>` piped to
// Out-String, Select-String, Select-Object, Where-Object, ForEach-Object, Measure-Object,
// Sort-Object, Out-Null or Write-Output with no Git inside, each argument literal text, a plain
// $variable or a group standing for one value (an unknown one takes its most dangerous
// reading); anything else there is denied with a request for separate plain git commands. Code
// Desk cannot read passes unless its readable text names Git. Statements without Git are walked
// for their location, variables and environment; whatever may or may not run leaves what it
// could change unknown. The PowerShell allowlist never fires in an unprotected checkout.
// When the shell text cannot be parsed at all, it is denied only if it names a Git operation
// whose rule could deny it there and does not run in a known unprotected checkout. Everything
// else, such as `echo "$(date)"`, `cd "$wt" && node x.js` or `jq . f.json | grep x`, is allowed.
//
// Inspection runs Git only from a trusted system location, never the command's PATH or
// loader settings. Policy: ../mcp/src/runtime/git-guard-policy.js; shell model:
// ../mcp/src/runtime/shell-commands.js and powershell-commands.js; docs: ../docs/protected-checkouts.md.
//
// The 9 s deadline below (fix round 1's own backstop) is migrated onto the
// failure contract (spec.md §1's table, row 5, Part 5): a *repeated* timeout
// of the exact same command -- not just one slow call -- now also emits a
// `Desk problem:` block and queues the detached filer, the same way every
// other migrated mechanism does. The plain "denied to keep a protected
// checkout safe" decision, and this hook's exit-code contract, are unchanged
// either way; see mcp/src/runtime/protected-checkout-repeat.js for the
// counting itself, kept in Desk's own state directory, never inside a desk.

const { pathToFileURL } = require("node:url");
const path = require("node:path");

function commandTextFromRawInput(raw) {
  try {
    const parsed = JSON.parse(raw);
    let args = parsed.tool_input ?? parsed.toolArgs;
    if (typeof args === "string") args = JSON.parse(args);
    return typeof args?.command === "string" ? args.command : "";
  } catch {
    return "";
  }
}

function defaultSpawnFiler({ mechanism, reason, host, env = process.env }) {
  const { compatibleCommand, launchCommand } = require("./boot-checks.cjs");
  const script = path.join(__dirname, "..", "mcp", "scripts", "file-desk-problem.js");
  const command = compatibleCommand(script, "--mechanism", mechanism, "--reason", reason || "unknown", "--host", host || "unknown");
  // Fire-and-forget, exactly like ask-gate.cjs's own filer: not awaited, and its own rejection swallowed.
  launchCommand(command, env).catch(() => {});
}

/**
 * Builds the guard's own 9 s-deadline answer, adding a `Desk problem:` block
 * (and queuing the detached filer, never awaited) only when the same
 * command's signature has now timed out repeatedly (spec.md §1's table, row
 * 5) -- see mcp/src/runtime/protected-checkout-repeat.js. The plain deny
 * decision is unchanged either way. Exported for tests; the real entry
 * point below is the only production caller.
 */
async function deadlineDecision({ rawInput, host, deadlineMs, env = process.env, spawnFiler = defaultSpawnFiler } = {}) {
  const decision = {
    permissionDecision: "deny",
    permissionDecisionReason: "Desk could not finish checking this command in time, so it is denied to keep a protected checkout safe. Retry it.",
  };
  let block = null;
  try {
    const command = commandTextFromRawInput(rawInput);
    const { repeatedTimeoutDeskProblem } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/protected-checkout-repeat.js")).href);
    const result = repeatedTimeoutDeskProblem({ command, env, deadlineMs });
    if (result.block) {
      block = result.block;
      try {
        spawnFiler({ mechanism: "protected-checkout", reason: `repeated timeout (${result.count}x)`, host, env });
      } catch {
        // Best-effort: the block still reports "filing in background" honestly enough -- the next repeated timeout tries again.
      }
    }
  } catch {
    // Never let the repeated-timeout signal itself change whether, or how fast, this deadline answers.
  }
  return { decision, block };
}

module.exports = { deadlineDecision, commandTextFromRawInput };

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  const deadlineMs = Number(process.env.DESK_GUARD_DEADLINE_MS) || 9000;
  // The hosts stop a hook at 10 s; answer first, and deny, if inspection has not finished at 9 s.
  const deadline = setTimeout(async () => {
    const { decision, block } = await deadlineDecision({ rawInput: input, host: process.argv[2], deadlineMs });
    if (block) process.stderr.write(`${block}\n`);
    process.stdout.write(`${JSON.stringify(process.argv[2] === "claude" ? { hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } } : decision)}\n`);
    process.exit(0);
  }, deadlineMs);
  process.stdin.on("end", async () => {
    try {
      const { protectedCheckoutHook } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/protected-checkout.js")).href);
      const output = await protectedCheckoutHook(JSON.parse(input), process.argv[2]);
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) {
      // The message can quote the command, so it goes through the same credential redaction as a denial; if the guard
      // module itself cannot load, only the error's name is written.
      const detail = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/protected-checkout.js")).href)
        .then(({ redact }) => redact(String(error?.message ?? error)), () => String(error?.name ?? "Error"));
      process.stderr.write(`Desk protected-checkout guard could not inspect this command: ${detail}\n`);
      process.exitCode = 2;
    } finally {
      clearTimeout(deadline);
    }
  });
}
