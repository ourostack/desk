# Evaluating Agentic Engineering V2

This packet lets you evaluate V2 yourself, on the agent host you use, as it stands on its channel the day you run it. You run seven scenarios, compare what happens with the observable outcomes written here, and file what you find. An agent called `observer` works alongside you: it records each step with evidence, times each scenario and classifies each problem, and it never fixes anything.

## Who this is for

A human evaluator trying V2 from the outside, on Claude Code or on a managed launcher with a company overlay, with the `observer` agent alongside. You need no knowledge of how V2 is built. You bring judgment: whether each outcome is what you would want from a colleague, and whether V2 should replace what you use today. That release call is yours; `observer` never makes it ([evaluate-release](../skills/evaluate-release/SKILL.md#report)).

## What V2 is

Agentic Engineering V2 is a way of working in which humans hand agents whole engineering outcomes and agents carry them to an accepted result: planned together, executed autonomously, verified at the level of the claim, remembered across sessions and measured ([the RFC](agentic-engineering-v2-rfc.md)). It is three plugins on the host you already use: Desk keeps durable work state, authority and the working relationship in your desk, a Git repository; Superpowers supplies the engineering method; Plain Language governs how agents write for people ([RFC §3](agentic-engineering-v2-rfc.md#3-layers-and-ownership)). It is an opt-in, measurable and replaceable alpha that installs from the `main` branch of `ourostack/desk`, and the RFC is the contract you are evaluating it against ([RFC §1](agentic-engineering-v2-rfc.md#1-why-v2-exists), [RFC §9](agentic-engineering-v2-rfc.md#9-status)).

Read the RFC with an agent rather than alone: start a session and ask it to walk you through it ([RFC, how to read it](agentic-engineering-v2-rfc.md)).

## How the evaluation works

- **You test the channel as it stands.** Install from the channel this packet names, `main` of `ourostack/desk`, never from a commit. Evaluators use the channel as it is when they run and record the commit they saw as evidence, never as something to hold the evaluation to ([RFC §5](agentic-engineering-v2-rfc.md#5-work-source-and-continuity)). Record it at the start with `git ls-remote https://github.com/ourostack/desk refs/heads/main`.
- **One host per run.** Run the whole packet on one host, then again on the other if you use both.
- **Start from nothing.** Use a throwaway profile or a fresh machine, so the evaluation sees what a new user sees and your own setup stays untouched.
- **`observer` watches; you and your agent do the work.** `observer` uses its release-evaluation skill, [`desk:evaluate-release`](../skills/evaluate-release/SKILL.md): it records each step's outcome with evidence, classifies each problem as a defect, a confusion or a gap, and reports without fixing anything. It never evaluates work it did and never certifies its own work ([observer's identity](../agents/observer.md)).
- **Time is measured, not estimated.** Tell `observer` when you start and finish each scenario; it records the elapsed time from the clock or from host log timestamps, and records `unavailable` when it could not measure ([evaluate-release](../skills/evaluate-release/SKILL.md#time-each-scenario)).

## Set up from nothing

Set up the host under test first, then start `observer`.

### Claude Code

**Before you start:** protect your real profile. Start the host under test with an empty configuration folder, for example `export CLAUDE_CONFIG_DIR="$(mktemp -d)"` in a new terminal, and back up your own `~/.claude/settings.json` and `~/.claude/CLAUDE.md`. [SETUP.md](../../../SETUP.md#claude-code) names `~/.claude` paths in steps 3 and 4 and says the binding path follows `CLAUDE_CONFIG_DIR` in step 5; if your agent edits your real `~/.claude` during setup, that is a finding.

1. In that terminal, start `claude` and sign in. The sign-in is yours; `observer` records it as a human step.
2. Give the agent the one link, https://github.com/ourostack/desk/blob/main/SETUP.md, and say "set this up". Answer only where it asks.
3. Start a new session in the same terminal when setup asks you to.

**Good looks like** ([SETUP.md, steps 2 and 6](../../../SETUP.md#2-install-the-plugins)):

- `claude plugin list` shows `desk@ourostack`, `superpowers@ourostack` and `plain-language@ourostack` enabled;
- the new session runs as `desk:worker` and the Desk foundation appears at startup;
- `desk_status` reports the bound desk root and where the binding came from;
- `desk:session-start` runs and offers work to resume or start;
- the configuration folder's `CLAUDE.md` is only the thin pointer to the desk.

### A managed launcher with a company overlay

**Before you start:** use a fresh launcher profile if your launcher offers one, or a fresh machine or user account.

1. Install the top-most plugin you use (the company overlay) through the launcher, as the overlay's own getting-started guide says. Its dependencies bring Desk, Superpowers and Plain Language from their channels ([RFC §7](agentic-engineering-v2-rfc.md#7-getting-v2-and-staying-current)).
2. If your launcher refreshes only the plugin you name, install the Desk plugins explicitly with the same refresh policy ([RFC §7](agentic-engineering-v2-rfc.md#7-getting-v2-and-staying-current)).
3. Start a session with the overlay's worker agent.

**Good looks like** ([RFC §9](agentic-engineering-v2-rfc.md#9-status)):

- at startup, each layer's foundation appears exactly once: Superpowers, Plain Language, Desk and the overlay's own;
- the agent body carries identity only, with no restated rules;
- `desk_status` reports the desk the overlay binds and where the binding came from.

### Start `observer`

- **If V2 is already installed in your normal profile,** start `observer` there before setup, so it watches setup too: `claude --agent desk:observer` on Claude Code, or select the `observer` agent the way you select `worker` on your launcher (for example `copilot --agent observer`) ([agent files](agent-files.md)).
- **Otherwise,** set up first, then start `observer` from the fresh profile in a second terminal and ask it to record setup from the host's session log.

Then tell it: "Evaluate this release with me on <host>, using `desk:evaluate-release` and the evaluation packet." It records the starting state, the commit you observed and the plugin versions before scenario 1.

## The scenarios

Run them in order; later scenarios reuse earlier work. Use a scratch repository you don't mind changing for the engineering work. For each scenario, tell `observer` when you start and when you finish.

Scenarios marked **(lands by the evaluation)** exercise features that reach the channel before you run the evaluation. Their outcomes come from V2's design and are confirmed against the channel when each feature lands. If one has not landed when you run it, `observer` records a gap with the channel state as evidence.

### 1. Start new work: alignment, then ownership

**Do:** in a `worker` session, describe a small real outcome you want in the scratch repository, and why, the way you would to a colleague. Don't list steps.

**Good looks like** ([using-desk](../skills/using-desk/SKILL.md#alignment-then-ownership), [RFC §2](agentic-engineering-v2-rfc.md#2-working-together-the-human-and-the-agent)):

- before any change, the agent states its assumptions, asks everything it will need from you in one batch with its recommendations, proposes a definition of done and waits for an explicit go; a clear, small request gets one confirming sentence rather than a meeting;
- after go, a task card appears in your desk, filed under a track whose scope fits or a new track, with a name built from the outcome rather than your words ([using-desk](../skills/using-desk/SKILL.md#durable-context-and-attribution));
- the agent works to done without handing you steps it could do itself, and comes back only for a real decision, missing authority, or the result;
- the result arrives with its evidence: what was verified, and a link to each artifact ([RFC §6](agentic-engineering-v2-rfc.md#6-verification-visual-proof-and-review)).

### 2. Hand over a whole outcome and step away

**Do:** give a larger outcome that takes real time, such as a feature with tests and a pull request in the scratch repository. After go, say you're stepping away for a while, then leave the session alone.

**Good looks like** ([interaction-style](../skills/interaction-style/SKILL.md#frontload-what-you-need-from-the-human), [RFC §2](agentic-engineering-v2-rfc.md#2-working-together-the-human-and-the-agent)):

- when you say you're leaving, the agent lists in one message everything it will need from you for the whole outcome (access, settings only you can change, decisions, reviews), so you can hand it all over and go;
- while you're away it keeps working; it doesn't stop to ask whether to continue;
- when you return, you find the result with its evidence, or a genuine blocker stated with exactly what it needs from you;
- the task card shows current progress, so a new session could pick up where this one left off.

`observer` records how long you were away and anything that waited on you.

### 3. Change a requirement mid-run

**Do:** while the work from scenario 2 (or a new outcome) is running, add a material requirement, such as a new acceptance condition.

**Good looks like** ([using-desk](../skills/using-desk/SKILL.md#requirements-that-arrive-during-execution), [RFC §5](agentic-engineering-v2-rfc.md#5-work-source-and-continuity)):

- the same task carries the change: no new task, no side quest, no restart from scratch;
- the agent names which earlier evidence the change invalidates and keeps unaffected work moving;
- the changed part goes back through tests and review before the agent calls the work done;
- the agent does not hand control back just because the plan changed.

### 4. A desk that needs tidying (lands by the evaluation)

**Do:** end the session. In the throwaway desk, add a loose file at the desk root (for example `status-notes.md`) and a track folder whose `track.md` has no `scope:` line, and commit both. Start a new session.

**Good looks like** ([the one-time tidy](../migrations/02-tidy-desk.md), [interaction-style](../skills/interaction-style/SKILL.md#2-organization-tidy-and-announce)):

- `desk_doctor` reports the findings (`loose_file`, `track_missing_scope`);
- the agent tidies without asking how you'd like it done, and announces it in one line in the spirit of "I'm going to tidy up my desk a bit: ... Say if you mind.";
- every move goes through Git, so it can be undone, and nothing is deleted;
- afterwards `desk_doctor` reports no organization findings for your desk.

### 5. A Desk tool fault that heals in the session

**Do:** end the session. Rename the throwaway desk folder (for example add `.away` to its name), so the bound path no longer exists. Start a new session and ask the agent what's on your desk.

**Good looks like** ([Desk MCP, handshake first, then admission](../mcp/README.md#handshake-first-then-admission), [the root check](../mcp/src/runtime/desk-session.js#L820-L828)):

- the session starts normally: the host shows no failed tool server, and the Desk tools are listed;
- `desk_status` answers with a degraded state (`root_unavailable`) and a fix, and the agent tells you in one line what is wrong;
- the agent restores the desk at its bound path within the session, or asks you once, with a recommendation, if restoring needs your decision;
- after the fix, `desk_status` reports `ready` in the same session, with no restart.

Restore the folder name yourself afterwards if the agent did not.

### 6. A finished task reaches the factory (lands by the evaluation)

**Do:** accept the outcome from scenario 1, so the agent marks its task done. If Desk asks whether to contribute factory data, answer as you would for real. Start a new session later.

**Good looks like** ([RFC §4](agentic-engineering-v2-rfc.md#4-the-factory-measuring-and-designing-the-work), [local capture](factory-local-capture.md)):

- marking the task done does not wait for any upload;
- contribution is opt-in and asked once;
- a pull request with the job's facts arrives in your boundary's factory store, passes the store's validation and merges;
- the job's report answers four questions (what happened, what mattered, what was waste, what could not be seen) and the task card links to it;
- the published facts file carries no names and no dates or times of day, only durations.

### 7. A kaizen card's check (lands by the evaluation)

**Do:** open the factory store's issues labeled `kaizen` and read the card that has completed its loop.

**Good looks like** ([RFC §4, the loop closes](agentic-engineering-v2-rfc.md#4-the-factory-measuring-and-designing-the-work)):

- the card names the recurring waste it targets and the jobs that showed it, the pull request that shipped the countermeasure, the version it shipped in, and the measure expected to move and in which direction;
- the store's build has commented a comparison of that measure between jobs before and after that version, with its uncertainty;
- a verdict label appears only once the data clearly shows a change, or clearly shows none; until then the card shows the running comparison.

## Record what you find

- **`observer` keeps the record.** For every step it records the action, the expected outcome, what happened, the evidence and `pass`, `fail`, `blocked` or `unavailable`, and each scenario's elapsed time, measured, not estimated ([evaluate-release](../skills/evaluate-release/SKILL.md#record-every-step)).
- **Every problem gets one class:** a defect (V2 doesn't do what it says), a confusion (it works as designed, but something misled you) or a gap (something needed or promised doesn't exist yet) ([evaluate-release](../skills/evaluate-release/SKILL.md#classify-every-problem)).
- **File one issue per finding** in `ourostack/desk`, labeled `evaluation`. For a run on a managed launcher with a company overlay, file it in the work equivalent, that overlay's own tracker, because public issues carry no work context ([content routing](../skills/content-routing/SKILL.md)). `observer` drafts each issue: host, scenario and step, class, expected and observed, evidence links, elapsed time and the commit you observed. You approve the exact text before it is filed from your account ([operator voice](../skills/operator-voice-comments/SKILL.md)).
- **Public issues stay public-safe:** no secrets, no private names, private evidence by pointer only, and durations rather than times of day.
- **At the end,** `observer` gives you its report for the host: each scenario's outcome against "good looks like", its elapsed time, every finding, and what it could not observe. The release call is yours.

## Clean up

Remove the throwaway profile folder, and any desk repository that setup created for it if you don't want to keep it. `observer` removes what it started and lists it in its report ([evaluate-release](../skills/evaluate-release/SKILL.md#clean-up)).
