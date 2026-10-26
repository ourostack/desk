# Evaluating Agentic Engineering V2

This packet lets you evaluate V2 yourself, on the agent host you use, as it stands on its channel the day you run it. You set up a throwaway desk, run seven scenarios against it, compare what happens with the observable outcomes written here, and file what you find. An agent called `observer` works alongside you: it records each step with evidence, times each scenario and classifies each problem, and it never fixes anything.

## Who this is for

A human evaluator trying V2 from the outside, on Claude Code or on a managed launcher with a company overlay, with the `observer` agent alongside. You need no knowledge of how V2 is built. You bring judgment: whether each outcome is what you would want from a colleague, and whether V2 should replace what you use today. That release call is yours; `observer` never makes it ([evaluate-release](../skills/evaluate-release/SKILL.md#report)).

## What V2 is

Agentic Engineering V2 is a way of working in which humans hand agents whole engineering outcomes and agents carry them to an accepted result: planned together, executed autonomously, verified at the level of the claim, remembered across sessions and measured ([the RFC](agentic-engineering-v2-rfc.md)). It is three plugins on the host you already use: Desk keeps durable work state, authority and the working relationship in your desk, a Git repository; Superpowers supplies the engineering method; Plain Language governs how agents write for people ([RFC §3](agentic-engineering-v2-rfc.md#3-layers-and-ownership)). It is an opt-in, measurable and replaceable alpha that installs from the `main` branch of `ourostack/desk`, and the RFC is the contract you are evaluating it against ([RFC §1](agentic-engineering-v2-rfc.md#1-why-v2-exists), [RFC §9](agentic-engineering-v2-rfc.md#9-status)).

Read the RFC with an agent rather than alone: start a session and ask it to walk you through it ([RFC, how to read it](agentic-engineering-v2-rfc.md)).

## How the evaluation works

**Browser superseded, October 25, 2026.** Desk's browser is now `fresh` or `mine` through `browser_context` (see the [RFC, section 3.1](agentic-engineering-v2-rfc.md#31-effortless-browser-contract)). The extension, real-profile declaration, broker and managed-profile steps below are historical and no longer apply.

**Packet refresh: October 12, 2026.** This is a procedure for a new evaluation, not a completed evaluation report. The real-browser mode moved to stock Playwright MCP and the stock Playwright Extension in [#376](https://github.com/ourostack/desk/pull/376), and its current installed behavior is described by the real-profile contract. Check the [carried release workflow](https://github.com/ourostack/desk/actions/workflows/desk-release.yml) and installed source during setup. CI results and earlier acceptance receipts are not a fresh-machine run of this packet. Every scenario below starts **unrun** for your host; only your observer's recorded outcomes can change that state ([evaluate-release](../skills/evaluate-release/SKILL.md#record-every-step)).

- **You test the channel as it stands.** Install from the channel this packet names, `main` of `ourostack/desk`, never from a commit. Evaluators use the channel as it is when they run and record the commit they saw as evidence, never as something to hold the evaluation to ([RFC §5](agentic-engineering-v2-rfc.md#5-work-source-and-continuity)). Record it at the start with `git ls-remote https://github.com/ourostack/desk refs/heads/main`.
- **One host per run.** Run the whole packet on one host, then again on the other if you use both.
- **Everything under test is throwaway.** A new host profile, a new desk, and Desk's own state and cache, all made for this evaluation inside one folder, so the sessions under test see what a new user sees and never use or change anything you already have. A new profile is not empty once you sign in: the host can load what your account carries, such as connectors and synced plugins, so setup records which plugins loaded and the preflight checks which Desk tool answers. A preflight check proves the session under test uses the throwaway desk before any scenario runs.
- **`observer` watches; you and your agent do the work.** `observer` uses its release-evaluation skill, [`desk:evaluate-release`](../skills/evaluate-release/SKILL.md): it records each step's outcome with evidence, classifies each problem as a defect, a confusion or a gap, and reports without fixing anything. It never evaluates work it did and never certifies its own work ([observer's identity](../agents/observer.md)).
- **Time is measured, not estimated.** Tell `observer` when you start and finish each scenario; it records the elapsed time from the clock or from host log timestamps, and records `unavailable` when it could not measure ([evaluate-release](../skills/evaluate-release/SKILL.md#time-each-scenario)).
- **Human authority stays human.** Delegating engineering checks does not delegate credentials, consent to publish facts, approval to speak from your account, acceptance of the outcome or promotion. With no human present, the driver records those gates as `blocked`, never bypasses them ([evaluate-release](../skills/evaluate-release/SKILL.md#hands-off), [RFC §2](agentic-engineering-v2-rfc.md#2-working-together-the-human-and-the-agent)).

## Set up from nothing

Do these steps in order: make the throwaway desk, set up one host, pass the preflight, then start `observer`.

Before allocating profiles, record free space on the chosen working directory's filesystem. Choose a byte budget and free-space reserve for this run; if setup would exceed either, record setup as `blocked` rather than allocate it. Use a new project-local evaluation folder, not the system temporary directory. Keep the backup and raw host evidence private: they may contain credentials or transcripts, and must never be attached to an issue or committed ([evidence safety](../skills/evaluate-release/SKILL.md#hands-off), [cleanup ownership](../skills/git-hygiene/SKILL.md#exact-owned-cleanup)).

**Every command block below fails closed.** Each block that writes runs in a subshell that starts with `set -eu` and stops unless `$EVAL` is set and, where a desk is touched, `git rev-parse --show-toplevel` is exactly `$EVAL/desk`. Everything they write stays inside `$EVAL`. In any new terminal, run `. <the printed $EVAL path>/env.sh` first; setup writes that file with every variable the evaluation needs.

### Make the throwaway desk

In a new terminal, create a throwaway folder holding a desk with a local remote, a scratch repository for the engineering work, a backup of the parts of your real Claude config directory that setup could change (the directory is `$CLAUDE_CONFIG_DIR` if your shell sets it, otherwise `~/.claude`), the folders where Desk keeps its state and cache for this evaluation, and a binding that points Desk at the throwaway desk:

```sh
export EVAL="$(cd "$(mktemp -d "$PWD/.v2-evaluation.XXXXXX")" && pwd -P)/v2-eval"
(
  set -eu
  umask 077
  [ -n "$EVAL" ] && [ ! -e "$EVAL" ] || { echo "EVAL must name a new folder; stopping." >&2; exit 1; }
  mkdir -p "$EVAL/desk/_meta" "$EVAL/desk/_archive" "$EVAL/scratch" "$EVAL/state" "$EVAL/cache"
  REAL_CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  mkdir -p "$EVAL/claude-backup/plugins"
  for part in CLAUDE.md settings.json plugins/installed_plugins.json plugins/known_marketplaces.json agents skills hooks; do
    if [ -e "$REAL_CLAUDE_DIR/$part" ]; then cp -RL "$REAL_CLAUDE_DIR/$part" "$EVAL/claude-backup/$part" || echo "$part" >> "$EVAL/claude-backup-incomplete.txt"; fi
  done
  if [ -d "$REAL_CLAUDE_DIR/projects" ]; then
    find -L "$REAL_CLAUDE_DIR/projects" -mindepth 2 -maxdepth 2 -type d -name memory | while IFS= read -r memory; do
      project="$(basename "$(dirname "$memory")")"
      mkdir -p "$EVAL/claude-backup/projects/$project"
      cp -RL "$memory" "$EVAL/claude-backup/projects/$project/memory" || echo "projects/$project/memory" >> "$EVAL/claude-backup-incomplete.txt"
    done
  fi
  ps -axo pid=,lstart=,comm= | awk '$NF ~ /(^|\/)claude$/' > "$EVAL/claude-sessions-before.txt" || true
  git -C "$EVAL/desk" init -q -b main
  [ "$(git -C "$EVAL/desk" rev-parse --show-toplevel)" = "$EVAL/desk" ] || { echo "Not the throwaway desk; stopping." >&2; exit 1; }
  touch "$EVAL/desk/_meta/.gitkeep" "$EVAL/desk/_archive/.gitkeep"
  printf '.state/\n' > "$EVAL/desk/.gitignore"
  printf '# Throwaway evaluation desk\n' > "$EVAL/desk/README.md"
  git -C "$EVAL/desk" add -A
  git -C "$EVAL/desk" commit -q -m "Start a throwaway evaluation desk"
  git init -q --bare "$EVAL/desk-remote.git"
  git -C "$EVAL/desk" remote add origin "$EVAL/desk-remote.git"
  git -C "$EVAL/desk" push -q -u origin main
  git -C "$EVAL/scratch" init -q -b main
  git -C "$EVAL/scratch" commit -q --allow-empty -m "Start a scratch repository"
  printf '{"schema_version":1,"desk":{"root":"%s","state_branch":"main"}}\n' "$EVAL/desk" > "$EVAL/desk.activation.json"
  {
    printf "export EVAL='%s'\n" "$EVAL"
    printf "export REAL_CLAUDE_DIR='%s'\n" "$REAL_CLAUDE_DIR"
    printf "export DESK_ACTIVATION_CONFIG='%s'\n" "$EVAL/desk.activation.json"
    printf "export DESK='%s'\n" "$EVAL/desk"
    printf "export XDG_STATE_HOME='%s'\n" "$EVAL/state"
    printf "export XDG_CACHE_HOME='%s'\n" "$EVAL/cache"
    printf "export CLAUDE_CONFIG_DIR='%s'\n" "$EVAL/claude-config"
    printf "export COPILOT_HOME='%s'\n" "$EVAL/copilot-home"
  } > "$EVAL/env.sh"
)
. "$EVAL/env.sh" && echo "$EVAL"
```

Why each piece is there:

- The desk has the shape Desk recognizes, `_meta/` plus `_archive/` ([desk shape](../mcp/src/util/paths.js)). The local remote lets Desk's state-branch repair in scenario 5 see the desk as pushed ([the state branch](../mcp/README.md#the-state-branch)).
- `DESK_ACTIVATION_CONFIG` binds the throwaway desk on every host that honors it, and its `state_branch` keeps it on `main`. `DESK` names the same desk, so a binding that ever misses falls back to the throwaway desk rather than to a desk in your home folder ([root resolution order](../mcp/src/util/paths.js)).
- `XDG_STATE_HOME` and `XDG_CACHE_HOME` give these sessions their own Desk state and cache: factory consent, session markers, outbox and readiness state all live under the state folder ([factory outbox](../mcp/src/factory/outbox.js), [start records](../mcp/src/runtime/last-start.js)), so the evaluation never reads or changes yours, and scenario 6 sees the one-time consent question for real.
- `CLAUDE_CONFIG_DIR` and `COPILOT_HOME` give each host a fresh profile inside `$EVAL`.
- `$EVAL/claude-backup` is a copy of the parts of your real Claude config directory that setup could change, taken before anything else runs: `CLAUDE.md`, `settings.json`, the two plugin registry files, and what you wrote under `agents/`, `skills/`, `hooks/` and `projects/*/memory/`. It leaves out transcripts, caches and credentials, which can run to gigabytes and change by the minute on a profile in use. The copy follows symbolic links, so a part that a dotfile manager links in is backed up by content. A part that could not be copied whole, for example because it holds a broken link, is listed in `$EVAL/claude-backup-incomplete.txt`; differences under it at the end may come from the copy. `$EVAL/claude-sessions-before.txt` lists the Claude Code processes already running, so a change at the end can be attributed. The list finds a process only when its command name is `claude`: an empty list does not prove no session was running. `env.sh` records the real directory as `REAL_CLAUDE_DIR`: the `CLAUDE_CONFIG_DIR` your shell had before setup, otherwise `~/.claude`.

Start every session under test from `$EVAL/scratch`: a host project that is itself a desk would bind that desk instead ([root resolution order](../mcp/src/util/paths.js)). Keep the printed `$EVAL` path; `observer` needs it. If you want pull requests in the engineering scenarios, use a throwaway GitHub repository of your own instead of `$EVAL/scratch`.

### Claude Code

**Warning:** this packet requires the Desk release that contains the `SETUP.md` config-directory fix, in which every step of `SETUP.md` follows `CLAUDE_CONFIG_DIR`. Check with `claude plugin list`, or read the Desk [changelog](../CHANGELOG.md) for that fix. Before that release, [`SETUP.md`](../../../SETUP.md#claude-code) steps 2, 3 and 4 edit your real `~/.claude` even in a throwaway profile, and step 4 can move content out of `~/.claude/agents/`, `skills/`, `hooks/` and `projects/*/memory/`. The setup block above backs up every part of your real Claude config directory (`$REAL_CLAUDE_DIR`) that those steps can change to `$EVAL/claude-backup` whatever version you get. Answer step 4's question with "move or remove nothing". Any edit to your real `~/.claude` is a finding.

1. In the terminal where you made the throwaway desk (its variables, including `CLAUDE_CONFIG_DIR`, are set), `cd "$EVAL/scratch"` and start `claude`. Sign in; the sign-in is yours, and `observer` records it as a human step ([evaluate-release](../skills/evaluate-release/SKILL.md#hands-off)). Signing in can bring your account's connectors and synced plugins into this new profile. Leave them as they are and record what `claude plugin list` shows; the preflight checks that none of them answers for Desk.
2. Give the agent the one link, https://github.com/ourostack/desk/blob/main/SETUP.md, and say "set this up".
3. If setup asks which desk to use, answer: "Use the desk at `$EVAL/desk` (give the full path). Bind no other desk and create no remote." If it asks about moving existing content, answer "move or remove nothing".
4. When setup asks for a new session, exit `claude` and run the pre-session check under [Preflight](#preflight-the-session-uses-the-throwaway-desk) before you start it.

**Good looks like** ([SETUP.md, steps 2, 4 and 6](../../../SETUP.md#2-install-the-plugins)):

- `claude plugin list` shows `desk@ourostack`, `superpowers@ourostack` and `plain-language@ourostack` enabled, with a Desk release that contains the `SETUP.md` config-directory fix (check its entry in the Desk [changelog](../CHANGELOG.md));
- the new session runs as `desk:worker` and the Desk foundation appears at startup;
- `desk:session-start` runs and offers work to resume or start;
- `$CLAUDE_CONFIG_DIR/CLAUDE.md` is only the thin pointer to the desk ([SETUP.md, step 4](../../../SETUP.md#4-make-claudeclaudemd-a-thin-pointer)), and the backed-up parts of your real Claude config directory (`$REAL_CLAUDE_DIR`) match `$EVAL/claude-backup` (the check is under [Clean up](#clean-up)).

### A managed launcher with a company overlay

1. In the terminal where you made the throwaway desk, `COPILOT_HOME` already points at `$EVAL/copilot-home` for the Copilot CLI, which keeps its sessions there ([evaluate-release](../skills/evaluate-release/SKILL.md#record-every-step)). Isolate the launcher's own configuration too, and add each export to `$EVAL/env.sh`: point the variable that names its configuration into `$EVAL`, install into a launcher profile made for this run and select only that profile, so the run neither reads nor writes a launcher config file in your home folder. On Agency, `AGENCY_GLOBAL_CONFIG_PATH` is that variable and names a directory, not a file; `--profile-only <name>` selects the one profile, and `AGENCY_LOG_DIR` moves its logs. A launcher's shared download cache of plugins usually cannot be moved, and sharing it is acceptable: it holds copies of the channels, never your desk or a session's state. A shared cache can serve an older copy, so record the Desk version the first session reports; if it is behind the channel, refresh that cache entry the launcher's own way and record the finding.
2. Do the crew install: install the company overlay's top-most plugin through the launcher, from the overlay's `v2-alpha` channel. Until promotion, an overlay's default branch and its getting-started guide still install V1, so name the `v2-alpha` branch in the install command and follow that branch's guide. Its dependencies bring Desk, Superpowers and Plain Language from their channels ([RFC §7](agentic-engineering-v2-rfc.md#7-getting-v2-and-staying-current)). If your launcher refreshes only the plugin you name, install the Desk plugins explicitly with the same refresh policy.
3. Point the overlay at the throwaway desk, never at your team's real shared workspace. The overlay's crew onboarding (`crew:join-crew`) normally clones your team's workspace and binds your writes to it ([crew](../../crew/README.md)); for this evaluation, bind `$EVAL/desk` instead. If the overlay binds its workspace through its own setting, flag or activation config, set that to `$EVAL/desk`: a root or activation config the launcher passes outranks `DESK_ACTIVATION_CONFIG`, but a project folder the host opened that is itself a desk outranks the launcher's activation config unless the launcher passes `--root` ([root resolution order](../mcp/src/util/paths.js)); step 4 starts the session from `$EVAL/scratch`, which is not a desk. If the overlay only binds a crew workspace, make its throwaway clone inside `$EVAL` from a remote you created there, and use that path in the preflight instead of `$EVAL/desk`.
4. `cd "$EVAL/scratch"` and start a session with the overlay's worker agent.

**Browser isolation is a separate gate.** `COPILOT_HOME`, `CLAUDE_CONFIG_DIR` and a throwaway desk do not isolate a plugin's `desk.browser` declaration: it makes `desk-web` drive an existing signed-in account profile through stock Playwright MCP and the Playwright Extension (real-profile contract, profile selection). Inspect the installed chain before starting a session that loads it. If it selects a real profile, record this cold setup as `blocked` until an authorized, separately owned evaluation profile and its provider binding are available. Do not copy credentials, change the channel's declaration, install an extension into a shared profile, or restart the human's browser to make a throwaway run pass.

**Good looks like** ([RFC §7](agentic-engineering-v2-rfc.md#7-getting-v2-and-staying-current), [RFC §9](agentic-engineering-v2-rfc.md#9-status)):

- the launcher's own plugin listing, or the installed plugin folders under `$COPILOT_HOME` or the launcher's cache, show each plugin installed from its channel branch (`main` of `ourostack/desk` for Desk, Superpowers and Plain Language, as Desk's [launcher manifest](../agency.json) declares; the overlay's own channel for the overlay) and never from a commit;
- at startup, each layer's foundation appears exactly once: Superpowers, Plain Language, Desk and the overlay's own;
- the agent body carries identity only, with no restated rules.

### Preflight: the session uses the throwaway desk

Before any scenario, prove that Desk binds the throwaway desk. Nothing else happens until this passes.

**On Claude Code, check before the first session starts.** After setup, and before you start the first session with Desk loaded, run this read-only check in the terminal under test. It asks the installed Desk plugin which desk it would bind, exactly as its startup hook does ([resolve-desk-root](../mcp/scripts/resolve-desk-root.js)):

```sh
( set -eu
  . "${EVAL:?Run . <the printed EVAL path>/env.sh first}/env.sh"
  cd "$EVAL/scratch"
  node "$(ls -d "$CLAUDE_CONFIG_DIR"/plugins/cache/ourostack/desk/*/ | tail -n 1)mcp/scripts/resolve-desk-root.js"
)
```

Then start the session with a read-only first prompt: "Call the installed Desk plugin's `desk_status` and show me only the desk root, where it came from and the full name of the tool that answered. Do nothing else."

**On a managed launcher,** the launcher's own arguments decide the binding, so there is no pre-session check. Make the read-only `desk_status` prompt above your first prompt.

**Good looks like** ([desk_status](../mcp/src/tools/status.js)):

- on Claude Code, the check prints `"root"` exactly `$EVAL/desk` with `"source":"activation-config"`, and `desk_status` in the session agrees;
- the tool that answered belongs to the installed plugin (on Claude Code its name starts with `mcp__plugin_desk_desk__`; on the Copilot CLI it is `desk-desk_status`). A Desk tool that comes from a connector on your account (on Claude Code its name starts with `mcp__claude_ai_`) reads your real hosted desk, not the throwaway one: if that one answered, or the agent used it at all, stop as below;
- on a managed launcher, `desk_status` names exactly the throwaway desk or throwaway workspace clone you made inside `$EVAL`, whatever source it reports.

**If it names any other desk, stop the evaluation.** Run no scenario against that desk. Record a defect with the output as evidence, and file it ([evaluate-release](../skills/evaluate-release/SKILL.md#start-cold-on-the-named-host)).

**What this cannot prevent:** Desk's startup hook runs its boot checks when a session starts, before your first prompt, and can launch detached workspace-tidy work for the desk it resolves ([boot checks](../hooks/lib/boot-checks.cjs)). The current tidy requires fresh ownership and consumer evidence before removal; a listing is not deletion authority ([workspace tidy](workspace-tidy.md)). On Claude Code, the pre-session check rules out a wrong binding before that happens. On a launcher, the in-session `desk_status` detects a wrong binding after startup rather than preventing it. Before starting on a launcher, prove four things point into `$EVAL`: the launcher's configuration, the host home (`COPILOT_HOME`), the desk or workspace binding, and Desk's state and cache (`XDG_STATE_HOME`, `XDG_CACHE_HOME`). If you cannot prove all four, record setup as `blocked`; do not try it against your real workspace. The launcher's shared download cache and logs are not on that list.

### Start `observer`

Run `observer` in its own terminal, from its own working folder and its own profile, never from `$EVAL` or the profile under test, and do not source `$EVAL/env.sh` there ([evaluate-release](../skills/evaluate-release/SKILL.md#start-cold-on-the-named-host)):

1. Make an evidence folder outside `$EVAL`, for example `mkdir -p ~/v2-evaluation`, and `cd` into it. It is the one folder this evaluation writes outside `$EVAL`, because it must outlive clean-up; nothing under test writes to it.
2. Start `observer` with your normal profile if V2 is installed there: `claude --agent desk:observer` on Claude Code, or select the `observer` agent the way you select `worker` on your launcher (for example `agency copilot --agent desk:observer`) ([agent files](agent-files.md)).
3. If V2 is not installed in your normal profile, give `observer` a throwaway setup of its own, separate from the one under test: in observer's terminal, run the "Make the throwaway desk" block again (it makes a second folder with its own `env.sh`), set it up from `SETUP.md` exactly as above, and pass the same preflight against that second desk before you start `observer` there. Note both printed paths; the second one is observer's, not the one under test.
4. Tell it: "Evaluate this release with me on <host>, using `desk:evaluate-release` and the evaluation packet. The throwaway folder under test is <`$EVAL`>, the profile under test is <`$CLAUDE_CONFIG_DIR` or `$COPILOT_HOME` from `$EVAL/env.sh`>, and the evidence folder is <this folder>."

`observer` records the starting state, the commit you observed and the plugin versions before scenario 1, and keeps its record in the evidence folder ([evaluate-release](../skills/evaluate-release/SKILL.md#start-cold-on-the-named-host)). If you start it after setup, it reconstructs setup from the host's session log.

## The scenarios

Run them in order, all against the throwaway desk, from sessions started in `$EVAL/scratch`. For each scenario, tell `observer` when you start and when you finish. A step that says "in another terminal" means a new terminal where you first run `. <the printed EVAL path>/env.sh`.

Run scenarios 1 to 3 in an interactive session, and every later step that reaches a human gate, such as the consent question in scenario 6. A host's non-interactive prompt mode (`-p`) can tell the agent that no user is present, and an agent told that has nobody to align with or to ask, so those steps would measure nothing. An agent dry run drives a real terminal for them instead ([evaluate-release](../skills/evaluate-release/SKILL.md#observe-a-dry-run)).

Scenarios marked **(lands by the evaluation)** exercise features that reach the channel before you run the evaluation. Their outcomes come from V2's design and are confirmed against the channel when each feature lands. If one has not landed when you run it, `observer` records a gap with the channel state as evidence ([evaluate-release](../skills/evaluate-release/SKILL.md#classify-every-problem)).

For each host, keep an evidence index with one row per setup gate and scenario: source channel and installed versions, expected outcome, observed outcome, primary evidence, measured duration and `pass`, `fail`, `blocked` or `unavailable`. Start all seven scenario rows as **unrun**, distinct from an observed failure. Record historical receipts separately: a previous browser acceptance run, fixture test or other host's result never fills a row in this cold run ([evaluate-release](../skills/evaluate-release/SKILL.md#record-every-step)). Track fresh setup, foundation composition, recovery, desk organization, factory delivery and the kaizen check separately; a pass on one does not close the others.

### 1. Start new work: alignment, then ownership

**Do:** in a `worker` session, describe a real outcome in the scratch repository, and why, the way you would to a colleague. Pick one with at least one genuine choice in it (for example, a small command-line tool where the output format is up to you), so the full alignment conversation happens. Don't list steps.

**Good looks like** ([using-desk](../skills/using-desk/SKILL.md#alignment-then-ownership), [RFC §2](agentic-engineering-v2-rfc.md#2-working-together-the-human-and-the-agent)):

- before any change, the agent states its assumptions, asks everything it will need from you in one batch with its recommendations, proposes a definition of done and waits for an explicit go;
- a task card appears in the throwaway desk before the agent aligns (creating it is not a change to your repository, and it is not the go), filed under a track whose scope fits or a new track, with a name built from the outcome rather than your words ([using-desk](../skills/using-desk/SKILL.md#durable-context-and-attribution));
- the agent works to done without handing you steps it could do itself, and comes back only for a real decision, missing authority, or the result;
- the result arrives with its evidence: what was verified, and a link to each artifact ([RFC §6](agentic-engineering-v2-rfc.md#6-verification-visual-proof-and-review)).

### 2. Hand over a whole outcome and step away

**Do:** give a larger outcome that takes real time, such as a feature with tests in the scratch repository. After go, say you're stepping away for a while, then leave the session alone.

**Good looks like** ([interaction-style](../skills/interaction-style/SKILL.md#frontload-what-you-need-from-the-human), [RFC §2](agentic-engineering-v2-rfc.md#2-working-together-the-human-and-the-agent)):

- when you say you're leaving, the agent lists in one message everything it will need from you for the whole outcome (access, settings only you can change, decisions, reviews), so you can hand it all over and go;
- while you're away it keeps working; it doesn't stop to ask whether to continue;
- when you return, you find the result with its evidence, or a genuine blocker stated with exactly what it needs from you;
- the task card shows current progress, so a new session could pick up where this one left off.

`observer` records how long you were away and anything that waited on you ([evaluate-release](../skills/evaluate-release/SKILL.md#time-each-scenario)).

### 3. Change a requirement mid-run

**Do:** start a new outcome of the size of scenario 2. After go, while the agent is working on it, add a material requirement, such as a new acceptance condition.

**Good looks like** ([using-desk](../skills/using-desk/SKILL.md#requirements-that-arrive-during-execution), [RFC §5](agentic-engineering-v2-rfc.md#5-work-source-and-continuity)):

- the same task carries the change: no new task, no side quest, no restart from scratch;
- the agent names which earlier evidence the change invalidates and keeps unaffected work moving;
- the changed part goes back through tests and review before the agent calls the work done;
- the agent does not hand control back just because the plan changed.

### 4. A desk that needs tidying (lands by the evaluation)

**Do:** end the session and confirm that its owned tidy processes have stopped. Right before this scenario, make the throwaway desk messy and clear only its completed tidy record, so the one-time tidy's check fires ([the one-time tidy](../migrations/02-tidy-desk.md)). Do not delete claims or holds to force admission: if any remain, record the gate as `blocked` until their exact owner is reconciled ([cleanup ownership](../skills/git-hygiene/SKILL.md#exact-owned-cleanup)). The block stops if the desk has no `git config user.name`; set one there first. It deletes nothing: it moves the tidy record aside inside `$EVAL`. The block writes no task card, because Desk's commit hook refuses a task card committed by hand ([the card guard](../mcp/src/desk/card-commit-guard.js)); the mess is made of files an ordinary commit accepts.

```sh
( set -eu
  . "${EVAL:?Run . <the printed EVAL path>/env.sh first}/env.sh"
  [ "$(git -C "$EVAL/desk" rev-parse --show-toplevel)" = "$EVAL/desk" ] || { echo "Not the throwaway desk; stopping." >&2; exit 1; }
  [ -z "$(git -C "$EVAL/desk" status --porcelain)" ] || { echo "The desk has uncommitted changes; stopping." >&2; exit 1; }
  me="$(git -C "$EVAL/desk" config user.name | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
  [ -n "$me" ] || { echo "Set git user.name in the throwaway desk first; stopping." >&2; exit 1; }
  [ ! -e "$EVAL/desk/$me" ] || { echo "The desk already has a $me folder; stopping." >&2; exit 1; }
  [ ! -e "$EVAL/desk/hi-can-you-fix-the-login" ] || { echo "The desk already has a hi-can-you-fix-the-login folder; stopping." >&2; exit 1; }
  if [ -e "$EVAL/desk/_meta/organization.json" ]; then
    mv "$EVAL/desk/_meta/organization.json" "$(mktemp "$EVAL/tidy-record-before-scenario-4.XXXXXX")"
  fi
  mkdir -p "$EVAL/desk/$me" "$EVAL/desk/hi-can-you-fix-the-login"
  printf -- '---\ntitle: %s\n---\n\n# %s\n' "$me" "$me" > "$EVAL/desk/$me/track.md"
  printf -- '---\ntitle: Fix the login\n---\n\n# Fix the login\n' > "$EVAL/desk/hi-can-you-fix-the-login/track.md"
  printf 'status notes\n' > "$EVAL/desk/status-notes.md"
  git -C "$EVAL/desk" add -A
  git -C "$EVAL/desk" commit -q -m "Make a mess for the tidy scenario"
  git -C "$EVAL/desk" push -q origin main
  echo "mess committed and pushed"
)
```

This adds a loose file at the desk root, a track named after you and a track named from a prompt, neither with a scope line, all committed and pushed. If the block stops because the desk has uncommitted changes, start a session, ask the agent to commit and push its desk changes, end it and run the block again.

Then start a new session from `$EVAL/scratch` and say only "hi". Do not mention the desk or the tidy: the startup check has to find the mess by itself.

**Good looks like** ([the doctor's organization checks](../mcp/src/desk/organization.js), [interaction-style](../skills/interaction-style/SKILL.md#2-organization-tidy-and-announce)):

- the session's startup tidy check finds the mess, and startup tells the agent a tidy is pending and how to run it; the agent runs it before it answers your prompt, and you do not ask for it. If you ask the agent afterwards what it found, or to call `desk_doctor` before it tidies, the findings include `loose_file`, `track_missing_scope`, `track_empty`, `track_person_name` and `name_prompt_like`;
- in its first reply the agent tidies without asking how you'd like it done, and announces it in one line in the spirit of "I'm going to tidy up my desk a bit: ... Say if you mind.";
- every move goes through Git, so it can be undone, and nothing is deleted;
- afterwards `desk_doctor` reports no organization findings, and `_meta/organization.json` records `tidy_version: 1`.

### 5. A Desk tool fault that heals in the session

The throwaway desk's binding asks Desk to keep it on its `main` branch. Desk switches a checkout back on its own only during a session's first admission, and only when that is provably safe; later in a session, a checkout that has left the branch makes writes read-only with a fix the agent can apply in the same session ([the state branch](../mcp/README.md#the-state-branch), [`repairStateBranch`](../mcp/src/runtime/state-branch.js)).

**Do:**

1. End the session. Check that the desk is clean and pushed, then detach its HEAD. The block stops, and says why, if the desk has uncommitted changes; in that case, start a session, ask the agent to commit and push its desk changes, end it and run the block again:

    ```sh
    ( set -eu
      . "${EVAL:?Run . <the printed EVAL path>/env.sh first}/env.sh"
      [ "$(git -C "$EVAL/desk" rev-parse --show-toplevel)" = "$EVAL/desk" ] || { echo "Not the throwaway desk; stopping." >&2; exit 1; }
      [ -z "$(git -C "$EVAL/desk" status --porcelain)" ] || { echo "The desk has uncommitted changes; stopping." >&2; exit 1; }
      git -C "$EVAL/desk" push -q origin main
      git -C "$EVAL/desk" switch -q --detach
      echo "clean, pushed and detached"
    )
    ```

2. Start a new session from `$EVAL/scratch` and ask the agent to call `desk_status`.
3. While that session is open but not writing, detach the desk again in another terminal. First confirm that no agent, tool call or detached task is writing to this throwaway checkout; if you cannot, record the step as `blocked` ([checkout ownership](../skills/git-hygiene/SKILL.md#exact-owned-cleanup)):

    ```sh
    ( set -eu
      . "${EVAL:?Run . <the printed EVAL path>/env.sh first}/env.sh"
      [ "$(git -C "$EVAL/desk" rev-parse --show-toplevel)" = "$EVAL/desk" ] || { echo "Not the throwaway desk; stopping." >&2; exit 1; }
      [ -z "$(git -C "$EVAL/desk" status --porcelain)" ] || { echo "The desk has uncommitted changes; stopping." >&2; exit 1; }
      git -C "$EVAL/desk" switch -q --detach
    )
    ```

4. Back in the session, ask the agent to add a short progress note to one of its tasks.

**Good looks like:**

- after step 2, the session starts normally and `desk_status` reports the repair in one line, `repaired: detached HEAD → main (was <commit>)`; the desk is back on `main`;
- after step 4, `desk_status` reports a degraded, read-only state (`state_branch_detached`) with a fix that names `desk_doctor {"repair":"switch_state_branch"}`, and the agent tells you in one line what happened;
- the agent applies that repair in the session, or asks you once with its recommendation, since you moved the checkout yourself;
- after the repair, `desk_status` reports `ready` in the same session, with no restart, and the progress note is written ([Desk MCP, handshake first, then admission](../mcp/README.md#handshake-first-then-admission)).

### 6. A finished task reaches the factory (lands by the evaluation)

This scenario depends on the factory store and transport for the trust boundary under test ([RFC §4](agentic-engineering-v2-rfc.md#4-the-factory-measuring-and-designing-the-work)). A personal run uses `ourostack/factory`; a company-overlay run uses its configured work store, never the public one. If the store or transport is not live when you run it, `observer` records a gap. With no human consent to contribution, record upload-dependent steps as `blocked`, not a transport failure.

**Do:** start a fresh small outcome, let the agent finish it, and accept the result, so the agent marks its task done. If Desk asks whether to contribute factory data, answer as you would for real. Start a new session later.

**Good looks like** ([RFC §4](agentic-engineering-v2-rfc.md#4-the-factory-measuring-and-designing-the-work), [local capture](factory-local-capture.md), [the report path](../mcp/src/factory/pipeline/build.js)):

- marking the task done does not wait for any upload;
- contribution is opt-in and asked once;
- a pull request with the job's facts arrives in the selected store, passes the store's validation and merges;
- the store's `reports` branch has the job's report at `jobs/<job>.md`, and it answers four questions: what happened, what mattered, what was waste, what could not be seen;
- the task card carries no report link. Without consent to contribute, a move to `done` writes neither `factory_report` nor `factory_report_unavailable`, and the `task_update` result carries neither ([local capture](factory-local-capture.md#consent-status-and-the-report-link)). With consent, only a desk known to be private links its report, and the throwaway desk's remote is not on GitHub, so the card records `factory_report_unavailable: desk_not_private` and the `task_update` result carries the same field. To check the rule yourself, with or without consent, run `node mcp/scripts/factory.js job-link --store ourostack/factory --desk-remote "$(git -C "$EVAL/desk" remote get-url origin)" --desk "$EVAL/desk" --track <track> --slug <task>` from the installed Desk plugin folder (on Claude Code, under `$CLAUDE_CONFIG_DIR/plugins/cache/ourostack/desk/`) ([factory CLI](../mcp/scripts/factory.js)); `job-link` does not read consent, so it prints `{ "link": null, "reason": "desk_not_private" }` either way. Pass `--desk` so a card that was renamed or moved after it was created resolves to the same job as the card;
- public facts carry no identity, transcript text or times of day. Their permitted task-relative offsets and finish-day fields depend on whether the desk remote is public, private or unknown; check the publishing transform rather than treating every date as a leak ([publishing transform](../mcp/src/factory/publish.js), [RFC privacy contract](agentic-engineering-v2-rfc.md#4-the-factory-measuring-and-designing-the-work)).

### 7. A kaizen card's check (lands by the evaluation)

This scenario depends on the kaizen loop in the selected factory store. Earlier packet wording referred to the V2 design's section 6, "Kaizen", as not yet public; that restriction is historical. The [RFC's public factory contract](agentic-engineering-v2-rfc.md#4-the-factory-measuring-and-designing-the-work) now describes kaizen and andon. An automatic comparison, a statistical verdict and closure without confirmation are different outcomes. The [current curator](../skills/curator/SKILL.md#the-improvement-card-routine) hands shipped cards to the loop and forbids agents from closing them just because data is thin. The loop's [closure conditions](factory-local-capture.md#how-a-card-closes) distinguish store verdicts, source recovery and `closed_unverified` after repeated thin-data checks; none is permission for a manual statistical verdict. If no automatic check is observable, `observer` records a gap; no statistical verdict is not itself a failure.

**Do:** open the selected store's issues labeled `kaizen` and read a card with a shipped countermeasure and an automatic check. For a personal run, use `ourostack/factory`; keep work-store evidence private.

**Good looks like** ([RFC's factory contract](agentic-engineering-v2-rfc.md#4-the-factory-measuring-and-designing-the-work), [the kaizen check](factory-local-capture.md)):

- the card names the recurring waste it targets and the jobs that showed it, the pull request that shipped the countermeasure, the version it shipped in, and the measure expected to move and in which direction;
- the store's build has commented a comparison of that measure between jobs before and after that version, with its uncertainty;
- the result distinguishes a confirmed or not-confirmed statistical verdict from “not enough independent jobs yet” or “no clear change so far”; any `closed_unverified` result carries its documented loop condition and is not presented as statistical confirmation.

## Browser check

The earlier extension and real-profile delivery plan is withdrawn; the files it named are gone. Check the browser as the [RFC, section 3.1](agentic-engineering-v2-rfc.md#31-effortless-browser-contract) describes it: `browser_context` opens a `fresh` browser and a `mine` browser, each loads a page without taking focus from the evaluator's own windows, `mine` shows a site the evaluator is signed in to as signed in, and closing each one deletes its temp folder.

## Record what you find

- **`observer` keeps the record** in the evidence folder, outside the throwaway desk. For every step it records the action, the expected outcome, what happened, the evidence and `pass`, `fail`, `blocked` or `unavailable`, and each scenario's elapsed time, measured, not estimated ([evaluate-release](../skills/evaluate-release/SKILL.md#record-every-step)).
- **Every problem gets one class:** a defect (V2 doesn't do what it says), a confusion (it works as designed, but something misled you) or a gap (something needed or promised doesn't exist yet) ([evaluate-release](../skills/evaluate-release/SKILL.md#classify-every-problem)).
- **File one issue per finding** in `ourostack/desk`, labeled `evaluation`. For a run on a managed launcher with a company overlay, file it in the work equivalent, that overlay's own tracker, because public issues carry no work context ([content routing](../skills/content-routing/SKILL.md)). `observer` drafts each issue: host, scenario and step, class, expected and observed, evidence links, elapsed time and the commit you observed. You approve the exact text before it is filed from your account ([operator voice](../skills/operator-voice-comments/SKILL.md)).
- **Public issues stay public-safe:** no secrets, no private names, private evidence by pointer only, and durations rather than times of day.
- **At the end,** `observer` gives you its report for the host: each scenario's outcome against "good looks like", its elapsed time, every finding, and what it could not observe ([evaluate-release](../skills/evaluate-release/SKILL.md#report)). The release call is yours.

## Clean up

First end the sessions under test and any separate observer fixture sessions. Reconcile each exact owned process, browser lease, checkout and profile before deleting its files; a matching folder suffix or a clean Git status is not proof that no writer remains. Stop only exact owned process generations, never by process name. Preserve compact logs, screenshots, failure receipts and the per-host report outside the disposable roots; do not retain whole inactive profiles as evidence ([cleanup ownership](../skills/git-hygiene/SKILL.md#exact-owned-cleanup), [observer cleanup](../skills/evaluate-release/SKILL.md#clean-up)).

Compare the backed-up parts of your real Claude config directory with `$EVAL/claude-backup` while that private backup still exists. This read-only block prints every difference, then the Claude Code processes that were running at setup and the ones running now:

```sh
( set -u
  . "${EVAL:?Run . <the printed EVAL path>/env.sh first}/env.sh"
  cd "$EVAL/claude-backup" || exit 1
  for part in CLAUDE.md settings.json plugins/installed_plugins.json plugins/known_marketplaces.json agents skills hooks; do
    if [ -e "$part" ] || [ -e "$REAL_CLAUDE_DIR/$part" ]; then diff -rq "$part" "$REAL_CLAUDE_DIR/$part"; fi
  done
  { [ ! -d projects ] || find projects -mindepth 2 -maxdepth 2 -type d -name memory
    [ ! -d "$REAL_CLAUDE_DIR/projects" ] || (cd "$REAL_CLAUDE_DIR" && find -L projects -mindepth 2 -maxdepth 2 -type d -name memory)
  } | sort -u | while IFS= read -r part; do diff -rq "$part" "$REAL_CLAUDE_DIR/$part"; done
  echo "Claude Code processes at setup:"; cat "$EVAL/claude-sessions-before.txt"
  echo "Claude Code processes now:"; ps -axo pid=,lstart=,comm= | awk '$NF ~ /(^|\/)claude$/'
)
```

No output above the two process lists means nothing changed. A `No such file or directory` line means that part exists on one side only: it was created or removed. Every difference is a finding. Record its cause with it: the evaluation, when the change matches a `SETUP.md` step or happened with no other session running; another session, when a Claude Code process in either list was using your real profile and the change is the kind a session makes by itself, such as a plugin update; or unknown, with both lists attached. If your real directory did not exist at setup, verify it was not created.

After all owned writers and consumers are confirmed absent, this block removes only the environment file, which the setup block created, not profiles or evidence:

```sh
( set -eu
  . "${EVAL:?Run . <the printed EVAL path>/env.sh first}/env.sh"
  case "$EVAL" in */v2-eval) ;; *) echo "EVAL does not look like the throwaway folder; stopping." >&2; exit 1 ;; esac
  [ "$(git -C "$EVAL/desk" rev-parse --show-toplevel)" = "$EVAL/desk" ] || { echo "Not the throwaway desk; stopping." >&2; exit 1; }
  rm -f "$EVAL/env.sh"
)
```

Close the terminals that sourced `env.sh`. Remove only the exact evaluation roots whose ownership and absence of consumers you verified, including the backup once its comparison is complete; record each removed path, reclaimed space and an absence readback. If a resource is still needed or its ownership cannot be established, retain that exact resource with a named owner and cleanup trigger in the private report, and keep cleanup open. Keep the evidence folder. `observer` accounts for what it started separately ([observer cleanup](../skills/evaluate-release/SKILL.md#clean-up)).
