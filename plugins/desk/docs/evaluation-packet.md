# Evaluating Agentic Engineering V2

This packet lets you evaluate V2 yourself, on the agent host you use, as it stands on its channel the day you run it. You set up a throwaway desk, run seven scenarios against it, compare what happens with the observable outcomes written here, and file what you find. An agent called `observer` works alongside you: it records each step with evidence, times each scenario and classifies each problem, and it never fixes anything.

## Who this is for

A human evaluator trying V2 from the outside, on Claude Code or on a managed launcher with a company overlay, with the `observer` agent alongside. You need no knowledge of how V2 is built. You bring judgment: whether each outcome is what you would want from a colleague, and whether V2 should replace what you use today. That release call is yours; `observer` never makes it ([evaluate-release](../skills/evaluate-release/SKILL.md#report)).

## What V2 is

Agentic Engineering V2 is a way of working in which humans hand agents whole engineering outcomes and agents carry them to an accepted result: planned together, executed autonomously, verified at the level of the claim, remembered across sessions and measured ([the RFC](agentic-engineering-v2-rfc.md)). It is three plugins on the host you already use: Desk keeps durable work state, authority and the working relationship in your desk, a Git repository; Superpowers supplies the engineering method; Plain Language governs how agents write for people ([RFC §3](agentic-engineering-v2-rfc.md#3-layers-and-ownership)). It is an opt-in, measurable and replaceable alpha that installs from the `main` branch of `ourostack/desk`, and the RFC is the contract you are evaluating it against ([RFC §1](agentic-engineering-v2-rfc.md#1-why-v2-exists), [RFC §9](agentic-engineering-v2-rfc.md#9-status)).

Read the RFC with an agent rather than alone: start a session and ask it to walk you through it ([RFC, how to read it](agentic-engineering-v2-rfc.md)).

## How the evaluation works

- **You test the channel as it stands.** Install from the channel this packet names, `main` of `ourostack/desk`, never from a commit. Evaluators use the channel as it is when they run and record the commit they saw as evidence, never as something to hold the evaluation to ([RFC §5](agentic-engineering-v2-rfc.md#5-work-source-and-continuity)). Record it at the start with `git ls-remote https://github.com/ourostack/desk refs/heads/main`.
- **One host per run.** Run the whole packet on one host, then again on the other if you use both.
- **Everything under test is throwaway.** A new host profile and a new desk made for this evaluation, so it sees what a new user sees and nothing you already have can be read, changed or moved. A preflight check proves the session under test uses the throwaway desk before any scenario runs.
- **`observer` watches; you and your agent do the work.** `observer` uses its release-evaluation skill, [`desk:evaluate-release`](../skills/evaluate-release/SKILL.md): it records each step's outcome with evidence, classifies each problem as a defect, a confusion or a gap, and reports without fixing anything. It never evaluates work it did and never certifies its own work ([observer's identity](../agents/observer.md)).
- **Time is measured, not estimated.** Tell `observer` when you start and finish each scenario; it records the elapsed time from the clock or from host log timestamps, and records `unavailable` when it could not measure ([evaluate-release](../skills/evaluate-release/SKILL.md#time-each-scenario)).

## Set up from nothing

Do these steps in order: make the throwaway desk, set up one host, pass the preflight, then start `observer`. Every host session under test starts from a terminal where the throwaway desk's variables are set.

### Make the throwaway desk

In a new terminal, create a throwaway folder, a desk inside it with a local remote, a scratch repository for the engineering work, and a binding that points Desk at the throwaway desk:

```sh
export EVAL="$(mktemp -d)/v2-eval"
mkdir -p "$EVAL/desk/_meta" "$EVAL/desk/_archive" "$EVAL/scratch"
touch "$EVAL/desk/_meta/.gitkeep" "$EVAL/desk/_archive/.gitkeep"
printf '.state/\n' > "$EVAL/desk/.gitignore"
printf '# Throwaway evaluation desk\n' > "$EVAL/desk/README.md"
git -C "$EVAL/desk" init -q -b main
git -C "$EVAL/desk" add -A
git -C "$EVAL/desk" commit -q -m "Start a throwaway evaluation desk"
git init -q --bare "$EVAL/desk-remote.git"
git -C "$EVAL/desk" remote add origin "$EVAL/desk-remote.git"
git -C "$EVAL/desk" push -q -u origin main
git -C "$EVAL/scratch" init -q -b main
git -C "$EVAL/scratch" commit -q --allow-empty -m "Start a scratch repository"
printf '{"schema_version":1,"desk":{"root":"%s","state_branch":"main"}}\n' "$EVAL/desk" > "$EVAL/desk.activation.json"
export DESK_ACTIVATION_CONFIG="$EVAL/desk.activation.json" DESK="$EVAL/desk"
echo "$EVAL"
```

The desk has the shape Desk recognizes, `_meta/` plus `_archive/` ([desk shape](../mcp/src/util/paths.js)). `DESK_ACTIVATION_CONFIG` binds it on every host, and the binding's `state_branch` keeps it on `main` ([the state branch](../mcp/README.md#the-state-branch)). `DESK` names the same desk, so a binding that ever misses falls back to the throwaway desk rather than to a desk in your home folder ([root resolution order](../mcp/src/util/paths.js)). Start every session under test from `$EVAL/scratch`: a host project that is itself a desk would bind that desk instead.

Keep the printed `$EVAL` path; `observer` needs it. If you want pull requests in the engineering scenarios, use a throwaway GitHub repository of your own instead of `$EVAL/scratch`.

### Claude Code

**Warning:** this packet requires Desk 3.2.0-alpha.54 or later, the release in which every step of `SETUP.md` follows `CLAUDE_CONFIG_DIR`. Before that release, [`SETUP.md`](../../../SETUP.md#claude-code) steps 2, 3 and 4 edit your real `~/.claude` even in a throwaway profile, and step 4 can move content out of `~/.claude/agents/`, `skills/`, `hooks/` and `projects/*/memory/`. If you evaluate an earlier version, first back up your whole `~/.claude` folder (for example `cp -R ~/.claude ~/claude-backup-v2-eval`), and answer step 4's question with "move or remove nothing". Any edit to your real `~/.claude` is a finding.

1. In the terminal where you made the throwaway desk: `export CLAUDE_CONFIG_DIR="$EVAL/claude-config"`, then `cd "$EVAL/scratch"` and start `claude`. Sign in; the sign-in is yours, and `observer` records it as a human step ([evaluate-release](../skills/evaluate-release/SKILL.md#hands-off)).
2. Give the agent the one link, https://github.com/ourostack/desk/blob/main/SETUP.md, and say "set this up".
3. If setup asks which desk to use, answer: "Use the desk at `$EVAL/desk` (give the full path). Bind no other desk and create no remote." If it asks about moving existing content, answer "move or remove nothing".
4. Start a new session from `$EVAL/scratch` when setup asks you to.

**Good looks like** ([SETUP.md, steps 2, 4 and 6](../../../SETUP.md#2-install-the-plugins)):

- `claude plugin list` shows `desk@ourostack`, `superpowers@ourostack` and `plain-language@ourostack` enabled, with Desk at 3.2.0-alpha.54 or later;
- the new session runs as `desk:worker` and the Desk foundation appears at startup;
- `desk:session-start` runs and offers work to resume or start;
- `$CLAUDE_CONFIG_DIR/CLAUDE.md` is only the thin pointer to the desk ([SETUP.md, step 4](../../../SETUP.md#4-make-claudeclaudemd-a-thin-pointer)), and your real `~/.claude` is unchanged.

### A managed launcher with a company overlay

1. In the terminal where you made the throwaway desk, give the host a fresh home: `export COPILOT_HOME="$EVAL/copilot-home"` for the Copilot CLI ([evaluate-release](../skills/evaluate-release/SKILL.md#record-every-step) reads session logs there). If your launcher keeps its own home or cache folder under an environment variable, point that into `$EVAL` too.
2. Do the crew install: install the company overlay's top-most plugin through the launcher, as the overlay's getting-started guide says. Its dependencies bring Desk, Superpowers and Plain Language from their channels ([RFC §7](agentic-engineering-v2-rfc.md#7-getting-v2-and-staying-current)). If your launcher refreshes only the plugin you name, install the Desk plugins explicitly with the same refresh policy.
3. Do not join your team's real shared workspace for this evaluation. The overlay's crew onboarding (`crew:join-crew`) clones that workspace and binds your writes to it ([crew](../../crew/README.md)); every scenario here runs against the throwaway desk instead.
4. `cd "$EVAL/scratch"` and start a session with the overlay's worker agent.

**Good looks like** ([RFC §7](agentic-engineering-v2-rfc.md#7-getting-v2-and-staying-current), [RFC §9](agentic-engineering-v2-rfc.md#9-status)):

- the launcher's plugin listing, or its install log, shows each plugin installed from its channel branch (`main` of `ourostack/desk` for Desk, Superpowers and Plain Language; the overlay's own channel for the overlay) and never from a commit;
- at startup, each layer's foundation appears exactly once: Superpowers, Plain Language, Desk and the overlay's own;
- the agent body carries identity only, with no restated rules;
- `desk_status` reports the declared plugin chain ([Desk README](../README.md#invocation--the-default-worker-agent)).

### Preflight: the session uses the throwaway desk

Before any scenario, in the session under test, ask the agent to call `desk_status` and show you the desk root and where it came from.

**Good looks like** ([desk_status](../mcp/src/tools/status.js)): the root is exactly `$EVAL/desk` (on macOS the same path may start with `/private`), and it resolved from `activation-config`.

**If it names any other desk, stop the evaluation.** Run no scenario against that desk. Record a defect with the `desk_status` output as evidence, and file it ([evaluate-release](../skills/evaluate-release/SKILL.md#start-cold-on-the-named-host)). A throwaway profile that binds a desk you already had is exactly what this preflight exists to catch.

### Start `observer`

Run `observer` in its own terminal, from its own working folder and its own profile, never from `$EVAL` or the profile under test ([evaluate-release](../skills/evaluate-release/SKILL.md#start-cold-on-the-named-host)):

1. Make an evidence folder outside `$EVAL`, for example `mkdir -p ~/v2-evaluation`, and `cd` into it.
2. Start `observer` with a profile that is not under test: your normal profile if V2 is installed there, otherwise a second fresh profile set up the same way. Use `claude --agent desk:observer` on Claude Code, or select the `observer` agent the way you select `worker` on your launcher (for example `copilot --agent observer`) ([agent files](agent-files.md)).
3. Tell it: "Evaluate this release with me on <host>, using `desk:evaluate-release` and the evaluation packet. The throwaway folder is <`$EVAL`>, the profile under test is <`$CLAUDE_CONFIG_DIR` or `$COPILOT_HOME`>, and the evidence folder is <this folder>."

`observer` records the starting state, the commit you observed and the plugin versions before scenario 1, and keeps its record in the evidence folder ([evaluate-release](../skills/evaluate-release/SKILL.md#start-cold-on-the-named-host)). If you start it after setup, it reconstructs setup from the host's session log.

## The scenarios

Run them in order, all against the throwaway desk, from sessions started in `$EVAL/scratch`. For each scenario, tell `observer` when you start and when you finish.

Scenarios marked **(lands by the evaluation)** exercise features that reach the channel before you run the evaluation. Their outcomes come from V2's design and are confirmed against the channel when each feature lands. If one has not landed when you run it, `observer` records a gap with the channel state as evidence ([evaluate-release](../skills/evaluate-release/SKILL.md#classify-every-problem)).

### 1. Start new work: alignment, then ownership

**Do:** in a `worker` session, describe a real outcome in the scratch repository, and why, the way you would to a colleague. Pick one with at least one genuine choice in it (for example, a small command-line tool where the output format is up to you), so the full alignment conversation happens. Don't list steps.

**Good looks like** ([using-desk](../skills/using-desk/SKILL.md#alignment-then-ownership), [RFC §2](agentic-engineering-v2-rfc.md#2-working-together-the-human-and-the-agent)):

- before any change, the agent states its assumptions, asks everything it will need from you in one batch with its recommendations, proposes a definition of done and waits for an explicit go;
- after go, a task card appears in the throwaway desk, filed under a track whose scope fits or a new track, with a name built from the outcome rather than your words ([using-desk](../skills/using-desk/SKILL.md#durable-context-and-attribution));
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

**Do:** end the session. Right before this scenario, make the throwaway desk messy and clear its tidy record, so the one-time tidy's check fires ([the one-time tidy](../migrations/02-tidy-desk.md)). If `git config user.name` prints nothing in the desk, set it there first.

```sh
cd "$EVAL/desk"
git rm -q --ignore-unmatch _meta/organization.json && rm -f _meta/organization.json
me="$(git config user.name | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
mkdir -p "$me/hi-can-you-fix-the-login"
printf '# %s\n' "$me" > "$me/track.md"
printf -- '---\ntitle: Fix the login\nstatus: queued\n---\n' > "$me/hi-can-you-fix-the-login/task.md"
printf 'status notes\n' > status-notes.md
git add -A && git commit -q -m "Make a mess for the tidy scenario" && git push -q
cd "$EVAL/scratch"
```

This adds a loose file at the desk root, a track named after you with no scope line, and a task named from a prompt. Start a new session.

**Good looks like** ([the doctor's organization checks](../mcp/src/desk/organization.js), [interaction-style](../skills/interaction-style/SKILL.md#2-organization-tidy-and-announce)):

- `desk_doctor` reports the findings, including `loose_file`, `track_missing_scope`, `track_person_name` and `name_prompt_like`;
- the agent tidies without asking how you'd like it done, and announces it in one line in the spirit of "I'm going to tidy up my desk a bit: ... Say if you mind.";
- every move goes through Git, so it can be undone, and nothing is deleted;
- afterwards `desk_doctor` reports no organization findings, and `_meta/organization.json` records `tidy_version: 1`.

### 5. A Desk tool fault that heals in the session

The throwaway desk's binding asks Desk to keep it on its `main` branch. Desk switches a checkout back on its own only during a session's first admission, and only when that is provably safe; later in a session, a checkout that has left the branch makes writes read-only with a fix the agent can apply in the same session ([the state branch](../mcp/README.md#the-state-branch), [`repairStateBranch`](../mcp/src/runtime/state-branch.js)).

**Do:**

1. End the session. Run `git -C "$EVAL/desk" switch --detach` (the desk is clean and pushed, so this is safe). Start a new session and ask the agent to call `desk_status`.
2. In the same session, run `git -C "$EVAL/desk" switch --detach` again from your terminal. Then ask the agent to add a short progress note to one of its tasks.

**Good looks like:**

- after step 1, the session starts normally and `desk_status` reports the repair in one line, `repaired: detached HEAD → main (was <commit>)`; the desk is back on `main`;
- after step 2, `desk_status` reports a degraded, read-only state (`state_branch_detached`) with a fix that names `desk_doctor {"repair":"switch_state_branch"}`, and the agent tells you in one line what happened;
- the agent applies that repair in the session, or asks you once with its recommendation, since you moved the checkout yourself;
- after the repair, `desk_status` reports `ready` in the same session, with no restart, and the progress note is written ([Desk MCP, handshake first, then admission](../mcp/README.md#handshake-first-then-admission)).

### 6. A finished task reaches the factory (lands by the evaluation)

This scenario depends on the public factory store `ourostack/factory` and on the transport that sends finished jobs to it. If either is not live when you run it, `observer` records a gap.

**Do:** start a fresh small outcome, let the agent finish it, and accept the result, so the agent marks its task done. If Desk asks whether to contribute factory data, answer as you would for real. Start a new session later.

**Good looks like** ([RFC §4](agentic-engineering-v2-rfc.md#4-the-factory-measuring-and-designing-the-work), [local capture](factory-local-capture.md), [the report path](../mcp/src/factory/pipeline/build.js)):

- marking the task done does not wait for any upload;
- contribution is opt-in and asked once;
- a pull request with the job's facts arrives in `ourostack/factory`, passes the store's validation and merges;
- the store's `reports` branch has the job's report at `jobs/<job>.md`, and it answers four questions: what happened, what mattered, what was waste, what could not be seen;
- the task card links to that report; to check the link yourself, run `node mcp/scripts/factory.js job-link --store ourostack/factory --desk-remote "$(git -C "$EVAL/desk" remote get-url origin)" --track <track> --slug <task>` from the installed Desk plugin folder (on Claude Code, under `$CLAUDE_CONFIG_DIR/plugins/cache/ourostack/desk/`) ([factory CLI](../mcp/scripts/factory.js));
- the published facts file carries no names and no dates or times of day, only durations.

### 7. A kaizen card's check (lands by the evaluation)

This scenario depends on the kaizen loop in the factory store `ourostack/factory`. Its outcomes come from the V2 design's section 6, "Kaizen", which is not yet public; the RFC does not describe kaizen cards. If no card has completed its loop when you run it, `observer` records a gap.

**Do:** open the issues in `ourostack/factory` labeled `kaizen` and read a card that has completed its loop.

**Good looks like** (V2 design, section 6, "Kaizen"):

- the card names the recurring waste it targets and the jobs that showed it, the pull request that shipped the countermeasure, the version it shipped in, and the measure expected to move and in which direction;
- the store's build has commented a comparison of that measure between jobs before and after that version, with its uncertainty;
- a verdict label appears only once the data clearly shows a change, or clearly shows none; until then the card shows the running comparison.

## Record what you find

- **`observer` keeps the record** in the evidence folder, outside the throwaway desk. For every step it records the action, the expected outcome, what happened, the evidence and `pass`, `fail`, `blocked` or `unavailable`, and each scenario's elapsed time, measured, not estimated ([evaluate-release](../skills/evaluate-release/SKILL.md#record-every-step)).
- **Every problem gets one class:** a defect (V2 doesn't do what it says), a confusion (it works as designed, but something misled you) or a gap (something needed or promised doesn't exist yet) ([evaluate-release](../skills/evaluate-release/SKILL.md#classify-every-problem)).
- **File one issue per finding** in `ourostack/desk`, labeled `evaluation`. For a run on a managed launcher with a company overlay, file it in the work equivalent, that overlay's own tracker, because public issues carry no work context ([content routing](../skills/content-routing/SKILL.md)). `observer` drafts each issue: host, scenario and step, class, expected and observed, evidence links, elapsed time and the commit you observed. You approve the exact text before it is filed from your account ([operator voice](../skills/operator-voice-comments/SKILL.md)).
- **Public issues stay public-safe:** no secrets, no private names, private evidence by pointer only, and durations rather than times of day.
- **At the end,** `observer` gives you its report for the host: each scenario's outcome against "good looks like", its elapsed time, every finding, and what it could not observe ([evaluate-release](../skills/evaluate-release/SKILL.md#report)). The release call is yours.

## Clean up

Remove the throwaway folder (`rm -rf "$EVAL"`), which holds the throwaway desk, its local remote, the scratch repository and the profile under test, then close the terminal that has its variables set. Keep the evidence folder. `observer` removes what it started and lists it in its report ([evaluate-release](../skills/evaluate-release/SKILL.md#clean-up)).
