# Protected checkouts

Desk's [Claude `PreToolUse`](../hooks/hooks.json) and [Copilot `preToolUse`](../hooks/copilot-hooks.json) plugin hooks guard shell calls for every agent using the plugin, without a parent-agent or subagent exemption. Claude registers both native `Bash` and `PowerShell`; tool names select the corresponding grammar. The hooks leave ordinary host permission checks in place and install no Git hooks, shell aliases or terminal configuration. A human invoking Git directly is unaffected. The [executable command table](../mcp/__tests__/runtime/protected_checkout.test.js) and [review regressions](../mcp/__tests__/runtime/protected_checkout_review.test.js) exercise registered commands with parent and child payloads, compare HEAD and the reflog, and then invoke Git directly.

## Threat model

The guard stops well-intentioned agents from accidentally moving a shared checkout off its state branch or discarding other sessions' work. It is not a sandbox against a determined adversary. It denies every spelling an agent would plausibly produce, fails closed only where it cannot tell which program runs, and always answers within the hosts' 10 s hook deadline: inspection has one 7 s budget across all its Git reads and denies when that runs out, and the [hook entry point](../hooks/protected-checkout.cjs) answers "deny" at 9 s whatever happens. Allowed and read-only commands make no inspection reads.

## Policy

A protected checkout is shared by sessions. The [guard](../mcp/src/runtime/protected-checkout.js) keeps its HEAD on its state branch and keeps other sessions' work in place; it does not block the desk's normal write protocol of committing and pushing the state branch. The [policy](../mcp/src/runtime/git-guard-policy.js) applies only when the **target checkout's saved local configuration** has `desk.protected=true`; every other checkout is unaffected.

| Allowed in a protected checkout | Denied in a protected checkout |
| --- | --- |
| Read-only Git: `status`, `log`, `diff`, `show`, `fetch`, `rev-parse`, `ls-files`, branch listing, `remote -v`, `config --get`, `stash list`/`show`, `bisect log` | `checkout` or `switch` to another branch, a tag or a detached commit, including `-b`, `-B`, `--orphan` and `--detach`; `bisect start` and other bisect steps |
| `add`, `rm`, `mv`, `commit`, and `commit --amend` of a commit that no remote-tracking branch contains; `reset --soft HEAD` | `reset --hard`, `--merge` or `--keep`, a `reset <commit>` that moves HEAD, and every mixed `reset` (it unstages the shared index, like `restore --staged`); `checkout -f` and `switch -f` or `--discard-changes` |
| `push` of the current branch, `HEAD` or tags, with or without `-u` | `push --force`, `--force-with-lease`, `--force-if-includes`, `--mirror`, `--delete`, `--prune`, `--all`, `--branches`, `+` or `:dst` refspecs and pushes to another branch; `commit --amend` of a pushed commit |
| `pull`, `pull --rebase` and `pull --ff-only` on the state branch, from its own upstream (`<remote>/<state branch>`), naming at most that remote and branch | `pull` off the state branch, from another repository (a URL, a path, `.`) or another branch, and `--autostash` anywhere |
| `fetch`, into remote-tracking refs | `fetch --update-head-ok`, and fetch refspecs whose destination is the current or state branch |
| `config` reads, and writes outside the sections below; `branch -u <remote>/<state branch>` | `config` writes to the `desk`, `alias`, `include`, `includeIf`, `remote`, `push`, `branch`, `rebase`, `pull`, `merge`, `fetch` and `url` sections; `branch -u` of the current or state branch to anything else |
| `rebase` and `rebase <its upstream>` on the state branch, and `rebase --continue`, `--abort` and `--skip` | `rebase` onto anything else, `--onto`, `--root`, `--exec`, `--quit`, a second operand naming another branch |
| `merge --ff-only`, and `merge --continue`, `--abort` and `--quit` | any other `merge` |
| `worktree add`, `worktree list`, `worktree prune --dry-run`; `checkout`/`switch` to the current or state branch | `restore --source` or `--staged` (plain `restore` and `checkout -- <paths>` are allowed); `clean`; `stash`; `branch -f`, `-d`/`-D`, `-m`/`-M` or `-C` of the current or state branch; `worktree add -B` of either; `worktree prune`; `worktree remove --force` of a protected checkout |

Push, pull, rebase, fetch and merge trust Git's configuration, so they are denied under a `-c`, `--config-env`, `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` or `GIT_CONFIG_PARAMETERS` override of `remote.*.mirror`/`push`/`fetch`/`url`/`pushurl`/`tagopt`, `push.*`, `branch.*.merge`/`remote`/`rebase`/`pushRemote`, `rebase.*`, `pull.*`, `merge.*`, `fetch.*` or `url.*.insteadOf`. A plain push also reads the saved `remote.<name>.mirror`, `remote.<name>.push` and `push.default`: a mirror, a forced or other-branch configured refspec, or `matching` is denied. Aliases come from saved configuration and from every override source, case-insensitively, and are expanded with the issuing command's options (`-C`, `--git-dir`, `--work-tree`, `-c`); a shell alias inherits the location and `-c` settings Git exports to it.

The state branch is `desk.stateBranch` from the marker file, written when the host names one (`--state-branch` or `desk.state_branch`); when none is recorded, the current branch is the state branch. `-h` and `--help` are always allowed. The [option parser](../mcp/src/runtime/git-guard-options.js) follows Git 2.54's full option lists (hidden options included): unambiguous abbreviations such as `--sour`, `--forc` for `branch` and `--autost`, negations such as `--no-source`, and option values such as `branch --format -f`. When one mode option overrides another (`reset --hard --mixed`, `merge --ff-only --no-ff`), the last one wins, as in Git. Force-removal checks the checkout being removed with its own Git identity, without the issuing command's location overrides.

Every denial names the checkout and says what to do instead, for example:

```text
Desk protected checkout /path/to/desk: this would move HEAD off the checkout's branch. To leave the state branch, use your own worktree: git worktree add --detach "$(mktemp -d)" <ref>
Desk protected checkout /path/to/desk: git stash hides other sessions' work; commit or leave it
```

Use the task's approved source ref and an owned worktree. The [Desk-to-Superpowers adapter](../skills/using-superpowers-with-desk/SKILL.md) passes this rule into both implementer and reviewer briefs:

> verify or validate in your own worktree; never in a checkout your task does not own

## Bound roots and local configuration

[Desk admission](../mcp/src/runtime/desk-session.js) marks each resolved root before activation can fail. This applies to the common admission path used by both launchers, including explicit roots supplied by overlays; no host-profile edit is needed. A non-Git root is left alone. A failed configuration write is an admission error and is retried by the existing admission machinery rather than reported as protected.

The [marker writer](../mcp/src/runtime/protected-checkout.js) writes `desk.protected=true` to `<actual-git-dir>/desk-protected.config` and includes that file from local Git configuration under an exact `includeIf.gitdir:<actual-git-dir>.path` condition. This avoids both shared `.git/config` inheritance and Git's copying of `config.worktree` into new worktrees. It does not enable `extensions.worktreeConfig` or migrate repository settings. Paths are taken from Git, with pattern metacharacters escaped. [Regression coverage](../mcp/__tests__/runtime/protected_checkout.test.js) proves that a new worktree is usable until it is itself bound. When the host names a state branch, admission records it as `desk.stateBranch` in the same file; binding without one removes it.

An operator may also opt a repository and its linked worktrees into the guard directly:

```sh
git config --local desk.protected true
```

That explicit shared setting applies to all its worktrees; prefer Desk's checkout-specific marker when only the bound checkout should be protected. The guard ignores global and command-scope policy values, so `git -c desk.protected=false ...` cannot override the saved marker. It also honors worktree-scope configuration where that Git feature is already enabled. See [Git's configuration scopes and conditional includes](https://git-scm.com/docs/git-config).

## Shell boundary

The [Bash inspector](../mcp/src/runtime/shell-commands.js) tokenizes commands without executing them. It follows quoted and escaped words, ANSI-C `$'...'` literals, unquoted variable field splitting, home-directory expansion, `cd`, repeated `git -C`, Git directory options and environment assignments, command lists, `&&`/`||`, pipelines, background commands, groups, conditionals, `case`, literal loops and functions, shell wrappers and positional arguments, Git aliases, substitutions and here-documents. All leading assignment words remain scalar, including later words such as `A=1 P=$X`; ordinary command arguments still expand in the preceding shell environment. Logical and physical directory state are separate: [native physical traversal](../mcp/src/runtime/shell-paths.js) follows symlinks before `..`, while default logical `cd` uses its logical path. `CDPATH` is modeled. Literal quoted text and quoted here-document bodies are not treated as commands; unknown external exit statuses retain both possible conditional paths. Valid non-Git `case` expressions remain non-applicable, including multiline and empty forms. An unmatched or empty case succeeds independently of the preceding command's status. [Tests](../mcp/__tests__/runtime/protected_checkout_review.test.js) compare both symlink directions and mutation/read-only controls against real Bash and Git.

The [PowerShell interpreter](../mcp/src/runtime/powershell-commands.js) uses separate assignment, variable, command and parameter rules. It models case-insensitive local variables, `$env:` assignment, `sl`/`cd`/`Set-Location`, `-Path`/`-LiteralPath`, redirects, subexpressions and explicit nested shell selection; it does not apply Bash word splitting to PowerShell variables. A quoted string's resulting value is data, but its executable interpolation is inspected first. An unknown external status controlling `&&` or `||` preserves both reachable states, including their directories, variables, environments and statuses, before subsequent statements are inspected. The [review regressions](../mcp/__tests__/runtime/protected_checkout_review.test.js) run literal examples against clean-profile PowerShell when installed and invoke the registered PowerShell hook command on that host.

Inspection itself has a [separate trust boundary](../mcp/src/runtime/git-inspection.js). It resolves Git from standard system installation locations independently of candidate input, executes that absolute path and uses the captured host environment rather than candidate `PATH`, `HOME`, loader settings or `GIT_EXEC_PATH`. Only modeled Git location variables are admitted to the read-only inspection subprocess. An executable sentinel regression proves that proposed `PATH=... git ...` and `PATH=... /absolute/git ...` commands do not execute the candidate-selected program during inspection.

This is a guard for shell-visible Git operations, **not a sandbox against an agent deliberately rewriting its own policy or executing arbitrary code**. It does not interpret Python, JavaScript, sourced script contents, executable files or remote shell sessions, and Git plumbing such as `update-ref` and `symbolic-ref` is outside its policy. Literal `pwd`, `echo` and `printf '%s'` substitutions resolve Bash values without executing the command; `mktemp` resolves to a new directory under its parent (`-p`, `--tmpdir`, a template's directory, the current directory for a bare template, or `TMPDIR`), so `wt=$(mktemp -d) && git worktree add --detach "$wt" HEAD && cd "$wt" && git switch -c fix` passes. PowerShell recognizes literal `Get-Location`/`pwd` subexpressions. `pushd DIR` changes directory like `cd`; `popd` and PowerShell's `Pop-Location` leave the directory unknown.

Git itself can run code the guard does not see: hooks (`core.hooksPath`, `.git/hooks`), `rebase -i` with `GIT_SEQUENCE_EDITOR` or `sequence.editor`, filters and credential helpers. These are outside the boundary, like sourced script contents; only `git config` writes to the sections above are denied. `commit --amend` counts a commit as pushed only when a remote-tracking ref contains it, so a push to a URL or a tag name, which leaves no remote-tracking ref, is not seen.

A here-document, a here-string or a literal `echo`/`printf '%s'` piped into `sh`, `bash`, `zsh`, `dash` or `ksh` without a script operand is inspected as that shell's script; wholly computed input such as `cat script | bash` is a script file, outside the boundary like `bash script`. In PowerShell, `$x = …`, `$null = …` and `$env:X = …` run their right-hand side through the same statement path (including `& git …` and parenthesized groups such as `(git stash).Length`) before assigning an unknown value.

### Unknown values fail closed only on a path to Git

Other computed output is **unknown**. The inspector carries an unknown value forward and fails closed only where it could decide a Git operation ([rule](../mcp/src/runtime/guard-unknowns.js), also documented in the [hook header](../hooks/protected-checkout.cjs)):

- an unknown program whose own text, or the substitution that computed it, names `git` (quotes and escapes removed) or evaluates code (`eval`, `source`, `.`, `iex`, `Invoke-Expression`), such as `$(command -v git) checkout main`;
- an unknown program whose arguments read like Git (`-C`, `-c`, `--git-dir`, `--work-tree`, `--config-env`, or a first operand that is a checked subcommand such as `checkout` or `stash`) is judged as that Git command, so `$(printf 'g%s' it) -C <desk> checkout main` is denied while `"$(npm bin)/tsc" --build` passes;
- an unknown `eval`, `source`/`.`, shell `-c`, `iex` or `Invoke-Expression` script;
- an unknown directory, Git subcommand, revision, branch, refspec or worktree for a Git operation the policy must check, such as `cd "$(pick)" && git checkout main`.

`cd "$(pick)" && git commit`, `echo "$(date)"`, `cd "$wt" && node x.js`, `"$(npm bin)/tsc"` and `jq . f.json | grep x` pass. Text the inspector cannot parse, or that exceeds its nesting or step budget, is denied only when it mentions `git` or evaluates code in the same sense; other unparseable text passes. A Git inspection failure, or running out of the 7 s budget, denies the command that needed it. Native host hook disablement and timeout behavior remain host-owned; see the [Claude hook reference](https://code.claude.com/docs/en/hooks) and [Copilot hook reference](https://docs.github.com/en/copilot/reference/hooks-reference).
