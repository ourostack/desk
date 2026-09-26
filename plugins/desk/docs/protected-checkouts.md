# Protected checkouts

Desk's [Claude `PreToolUse`](../hooks/hooks.json) and [Copilot `preToolUse`](../hooks/copilot-hooks.json) plugin hooks guard shell calls for every agent using the plugin, without a parent-agent or subagent exemption. Claude registers both native `Bash` and `PowerShell`; tool names select the corresponding grammar. The hooks leave ordinary host permission checks in place and install no Git hooks, shell aliases or terminal configuration. A human invoking Git directly is unaffected. The [executable command table](../mcp/__tests__/runtime/protected_checkout.test.js) and [review regressions](../mcp/__tests__/runtime/protected_checkout_review.test.js) exercise registered commands with parent and child payloads, compare HEAD and the reflog, and then invoke Git directly.

## Policy

The [guard](../mcp/src/runtime/protected-checkout.js) denies these Git operations when the **target checkout's saved local configuration** has `desk.protected=true`: `checkout`, `switch`, `reset`, `rebase`, `pull`, `merge`, `stash`, `restore --source` (including `-s`), `clean`, `branch -f` (including `--force`), and `worktree remove --force` (including `-f`). The rule covers the named commands, including inspection options such as `stash list` and `clean -n`; it is not a blanket ban on Git writes. `status`, `diff`, `log`, `fetch`, `add`, `commit`, `push`, ordinary `restore`, and `worktree add` remain under the host's normal policy. The [option parser](../mcp/src/runtime/git-guard-options.js) handles unambiguous spellings such as `--sour` and `--forc`, negation and option operands: `branch --format -f` consumes `-f` as a value rather than treating it as force. Force-removal checks the checkout being removed with its own Git identity, without the issuing command's location overrides.

The denial text is exactly:

```text
shared checkout: use git worktree add --detach "$(mktemp -d)" <ref>
```

Use the task's approved source ref and an owned worktree. The [Desk-to-Superpowers adapter](../skills/using-superpowers-with-desk/SKILL.md) passes this rule into both implementer and reviewer briefs:

> verify or validate in your own worktree; never in a checkout your task does not own

## Bound roots and local configuration

[Desk admission](../mcp/src/runtime/desk-session.js) marks each resolved root before activation can fail. This applies to the common admission path used by both launchers, including explicit roots supplied by overlays; no host-profile edit is needed. A non-Git root is left alone. A failed configuration write is an admission error and is retried by the existing admission machinery rather than reported as protected.

The [marker writer](../mcp/src/runtime/protected-checkout.js) writes `desk.protected=true` to `<actual-git-dir>/desk-protected.config` and includes that file from local Git configuration under an exact `includeIf.gitdir:<actual-git-dir>.path` condition. This avoids both shared `.git/config` inheritance and Git's copying of `config.worktree` into new worktrees. It does not enable `extensions.worktreeConfig` or migrate repository settings. Paths are taken from Git, with pattern metacharacters escaped. [Regression coverage](../mcp/__tests__/runtime/protected_checkout.test.js) proves that a new worktree is usable until it is itself bound.

An operator may also opt a repository and its linked worktrees into the guard directly:

```sh
git config --local desk.protected true
```

That explicit shared setting applies to all its worktrees; prefer Desk's checkout-specific marker when only the bound checkout should be protected. The guard ignores global and command-scope policy values, so `git -c desk.protected=false ...` cannot override the saved marker. It also honors worktree-scope configuration where that Git feature is already enabled. See [Git's configuration scopes and conditional includes](https://git-scm.com/docs/git-config).

## Shell boundary

The [Bash inspector](../mcp/src/runtime/shell-commands.js) tokenizes commands without executing them. It follows quoted and escaped words, ANSI-C `$'...'` literals, unquoted variable field splitting, home-directory expansion, `cd`, repeated `git -C`, Git directory options and environment assignments, command lists, `&&`/`||`, pipelines, background commands, groups, conditionals, `case`, literal loops and functions, shell wrappers and positional arguments, Git aliases, substitutions and here-documents. Logical and physical directory state are separate: [native physical traversal](../mcp/src/runtime/shell-paths.js) follows symlinks before `..`, while default logical `cd` uses its logical path. `CDPATH` is modeled. Literal quoted text and quoted here-document bodies are not treated as commands; unknown external exit statuses retain both possible conditional paths. Valid non-Git `case` expressions remain non-applicable, rather than becoming hook errors. [Tests](../mcp/__tests__/runtime/protected_checkout_review.test.js) compare both symlink directions and mutation/read-only controls against real Bash and Git.

The [PowerShell interpreter](../mcp/src/runtime/powershell-commands.js) uses separate assignment, variable, command and parameter rules. It models case-insensitive local variables, `$env:` assignment, `sl`/`cd`/`Set-Location`, `-Path`/`-LiteralPath`, redirects, subexpressions and explicit nested shell selection; it does not apply Bash word splitting to PowerShell variables. The [review regressions](../mcp/__tests__/runtime/protected_checkout_review.test.js) run literal examples against clean-profile PowerShell when installed and invoke the registered PowerShell hook command on that host.

Inspection itself has a [separate trust boundary](../mcp/src/runtime/git-inspection.js). It resolves Git from standard system installation locations independently of candidate input, executes that absolute path and uses the captured host environment rather than candidate `PATH`, `HOME`, loader settings or `GIT_EXEC_PATH`. Only modeled Git location variables are admitted to the read-only inspection subprocess. An executable sentinel regression proves that proposed `PATH=... git ...` and `PATH=... /absolute/git ...` commands do not execute the candidate-selected program during inspection.

This is a guard for shell-visible Git operations, **not a sandbox against an agent deliberately rewriting its own policy or executing arbitrary code**. It does not interpret Python, JavaScript, sourced scripts, executable files, arbitrary shell expansion results or remote shell sessions. General computed shell state and repeated dynamic loop iterations are not fully evaluated. Literal `pwd`, `echo` and `printf '%s'` substitutions can resolve Bash paths without executing the command; PowerShell recognizes literal `Get-Location`/`pwd` subexpressions. Other computed output remains unknown, and an unknown executable or target directory produces an explicit inspection error rather than an unprotected-checkout result. Malformed or over-complex input and Git inspection failures also produce explicit errors; parser errors are never blanket-allowed. Native host hook disablement and timeout behavior remain host-owned; see the [Claude hook reference](https://code.claude.com/docs/en/hooks) and [Copilot hook reference](https://docs.github.com/en/copilot/reference/hooks-reference).
