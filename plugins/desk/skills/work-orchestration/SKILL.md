---
name: work-orchestration
description: Align new work before go by batching every decision that needs the human, with recommendations, then bind authorized engineering work to Superpowers. Also when a material new requirement arrives mid-task. Also the default way to run any work, with independent streams in parallel, downstream fast-follow and early milestones.
---

# Work orchestration

> Boot first: if the Desk boot has not run in this session, run the absolute command on the `Desk startup:` line in your context (without it, `node <this skill's base directory>/../../mcp/scripts/session-boot.js`; add `--task "<name>"` when the operator named a task). If it ran with no task named and a task was picked since, run it again with `--task "<handle>" --task-only`: that prints the task's push route and repos. A child agent with a bounded brief follows its brief and skips this.

Invoke `desk:using-superpowers-with-desk`. This Desk adapter selects no second engineering method: Superpowers owns discovery, planning, execution and verification; Desk owns the work state and approved terminal boundary.

Read the existing task, agreement and plan before choosing the matching Superpowers skill. Consume prior approval without reopening it. Use `superpowers:brainstorming` for missing design agreement, `superpowers:writing-plans` when a plan is needed, and `superpowers:executing-plans` or authorized `superpowers:subagent-driven-development` for implementation. Keep plans and progress on Desk. Invoke `superpowers:requesting-code-review` for the normal review transition.

## Align new work before go

Before new work starts, list every decision in it that needs the human's judgment: voice, relationships, irreversible or hard-to-undo choices, and real ambiguity. Naming and filing are not among them: the agent owns them (`start-task`). Resolve each one you can from the request, the code or a sensible default. Put the rest to the human now, not when you reach the fork, and especially any entangled calls, where one answer changes another or changes work done before the fork. Ask them as one batch, each with your recommendation, so execution then runs without blocking on the human. A fork that could not have been foreseen is raised when it appears; one you did not think about beforehand is not unforeseeable.

## Authority and dependencies

Verify repository authority and the approved contribution path before any branch, worktree or source edit in a code repository. In a desk, work on `main` and commit your own paths. Read-only requests remain read-only. Delegation and worktree creation stay within the recorded mandate.

The cross-repository plan owns an explicit DAG; `repos[]` must never define dependency order. Reject cycles and unknown dependencies. A failed predecessor blocks its dependents, not independent ready nodes. In code repositories, use isolated worktrees and explicit working directories for authorized parallel work. Serialize shared/version surfaces or merge normally; never force-push through a coordinated conflict.

Plan delivery milestones as well as task dependencies. The target is the smallest coherent, usable milestone for a real consumer: an end-to-end slice with only the nodes required for that slice on its critical path. Keep unrelated qualification, automation, documentation and platform-breadth work downstream.

When the ready set can produce an independently usable artifact, complete that milestone's review and authorized publish, install and consuming-surface smoke. Qualification can continue afterward and must not block an independently usable slice. Record the remaining criteria and keep the milestone's readiness claim narrow.

Do not optimize for one final reveal. Local branches, completed nodes and review receipts are engineering progress, not delivered value. Replan when a consumer is waiting while unrelated tail work gates a safe usable milestone. If an intermediate artifact cannot be safe or coherent, record the exact coupling that requires atomic delivery.

Only a current, unsatisfied `needs-human-approval` is a hard exception. A producer may use `needs reviewer gate` only when it explicitly permits machine review. Superseded records do not revoke existing go. Mechanical reviews go to the authorized reviewer. A nested worker returns its brief and evidence to the parent rather than self-certifying or waiting for the parent's entire task to finish.

Before any fan-out, the root identifies dependencies, write sets, exclusive resources, the integration fold, the evidence each child must return, and the final synthesis it will own. If those stay implicit, the work is not ready to split.

Every child brief carries one line `Desk-Task: <track>/<slug>` naming the task the child's work serves, or `Desk-Task: none` when it serves none: the factory credits a child's work to a task only through that line or the task the parent held when it spawned the child. No hook adds or checks the line on any host: the line in the brief is the whole mechanism, so copy it into every brief. A child that dispatches its own child copies the line from its own brief.

Every brief carries this visual-proof sentence, whatever the work is called ("investigate", "look into", "review", "spike"), because the child follows its brief and the rule keys on what the work touches, not on a label: "Capture visual proof as you go: whenever the work touches something a person sees (a screen, a setting before and after, an agent's reply, a refusal, an error, a result), save bounded screenshots, never secrets or private content, into your own folder `evidence/<brief name>/` beside your brief file, named after the brief file without its extension (or, when the brief is not a file, `evidence/<a short name for your assignment>/` in the task's desk folder), so children whose briefs share a folder never overwrite each other's files, and return an Evidence list beside Resources that names each file and what it shows, or says why nothing was visible. A brief's silence never waives this." Every child return contract asks for that **Evidence** list beside **Resources**. When integrating a return, check Evidence as you check Resources, and send back work that touched a visible surface but came back without visuals.

Include `task-lifecycle`'s **Resources** inventory in every child return contract, including reviewers: every created worktree and local/remote branch, exact repository/path/ref, current state, owner and verified disposition, or `none created`. Record ownership and disposition at creation, not from branch-name patterns at cleanup time. At each task, iteration or delegated-assignment boundary, its owner closes out through `git-hygiene`; the Superpowers controller removes completed task worktrees through `using-superpowers-with-desk`'s mapped controller duty before releasing their reservations. A return or root exit alone does not prove that delegated, remote, MCP or command writers are absent.

Every brief that lets a child make scratch (a temporary copy, a fixture folder, a download) carries this sentence, because the child reads its brief and not this skill: "Write down the exact path of everything you create when you create it. Delete only those paths, each by that exact path written out in full in the delete command, never through a shell variable or a command substitution; leave anything else in place and list it in your return." Never brief a child to "delete it after" or to "clean up the temp folder" without it: a shell forgets its variables between commands, and a child that finds its folder again by a pattern or by taking the newest match deletes someone else's. Claude Code also stops for approval on a deletion whose path is a variable, even with permission checks bypassed, and the work then waits on a human who may be away; a child that made its folder with `mktemp` prints the path and uses the printed value. This is `git-hygiene`'s exact-owned cleanup applied to scratch.

Each repository retains its own branch and merge cycle. The isolation and shared-surface rules above apply at that repository boundary.

If material resequencing becomes necessary, record the observed waste pattern, the recommendation, and the consequence of not resequencing before changing the plan.

Desk owns task and iteration state and archive transitions. The agreed endpoint determines whether verification ends at an intentional alpha/PR-only branch or includes authorized merge, release/install, consuming-surface smoke and cleanup. Superpowers finish options cannot silently change that endpoint.

Invoke `superpowers:requesting-code-review` once at the diff boundary with the candidate branch and the relevant evidence, and record the head it reviewed as evidence. Record every finding disposition, keep one Superpowers implementation owner, run one bounded correction wave, and request affected re-review rather than opening a second implementation loop or repeating review after every edit.

## Ready-set scheduling and continuous peer review

This section consumes the cross-repository plan's Markdown DAG, whose table contract is the card's `## Steps` table (`Step | Depends on | Repo | State | Evidence`, defined in `task-card-format`), its node states and the T01 adapter's mapped context; it produces ordered dispatch/acceptance events linked to native call IDs, resource ownership and commit-review receipts. It defines no task schema or frontmatter, no universal graph parser, service or database, and it never touches a Superpowers payload.

```text
1. Read the plan and progress; reject unknown dependencies and dependency cycles before dispatch.
2. Ready = pending nodes with all dependencies accepted.
3. Walk ready nodes in stable table order; reserve complete writes/resources before launching.
4. Dispatch every non-conflicting ready node through pristine Superpowers skills in its own worktree.
5. Missing conflict data or unavailable parallel execution serializes the same ready set.
6. A result is accepted only after spec/targeted proof and native Superpowers review disposition.
7. On failure, block only descendants; release verified resources and recompute immediately.
8. A candidate-changing repair invalidates affected descendants and re-enters at the same owner.
```

Ready is exactly step 2's definition: pending nodes with all dependencies accepted; an unknown dependency or a dependency cycle is rejected before any dispatch, never silently skipped. Walk that ready set in stable table order — the DAG's own row order, never an inferred priority — and reserve each ready node's complete write set and exclusive resources before it launches, so overlapping write sets or contended exclusive resources between two ready nodes hold one of them back rather than let both proceed; missing conflict data serializes the same ready set instead of guessing at safety, and so does an environment where parallel execution is unavailable. This relaxation of unconditional cross-node serialization is Desk's own approved concurrency policy, not an upstream source change: the pristine Superpowers skills underneath are unmodified either way.

Dispatch every non-conflicting ready node through pristine Superpowers skills, in its own worktree for a code repository: `superpowers:using-git-worktrees` gives each dispatched node its own isolated worktree so no two ready nodes share a writer; `superpowers:dispatching-parallel-agents` fans genuinely independent, non-conflicting nodes out; `superpowers:subagent-driven-development` and `superpowers:executing-plans` carry out one dispatched node's own implement/fix loop; `superpowers:verification-before-completion` runs before any acceptance. One coherent task's implement/fix loop stays sequential; independent non-conflicting nodes may run concurrently in stable table order.

A candidate is accepted only after spec/targeted proof and a completed finding disposition from `superpowers:requesting-code-review` against the candidate branch, with the head it reviewed recorded as evidence. The same Superpowers implementation owner handles one bounded correction wave and the affected re-review; never open a second fix loop beside that owner's loop.

On failure, failure blocks only descendants: independent ready nodes already dispatched keep running, the failed node's reserved resources are released, and the ready set is recomputed immediately rather than held open. A candidate-changing repair invalidates its affected descendants' prior acceptance and re-enters at the same Superpowers implementation owner, not a new one.

Final behavioral scheduling proof — that dispatch, serialization and acceptance actually execute this way at runtime — belongs to a later task; this section ships the source contract and the real caller/provider witnesses only.

## Parallelize and fast-follow

This is the default for all work, not only multi-step plans. `superpowers:dispatching-parallel-agents` covers fanning independent problems out to agents; Desk adds:

- **Run independent streams at the same time.** Never hold a stream for one it doesn't depend on.
- **Fast-follow downstream.** When an upstream artifact changes, update what depends on it right away, not in a final sweep.
- **Keep the root for coordination.** When delegation is authorized, a subagent tool is available and the human has not chosen inline execution, hand work whose scope warrants a separate context to bounded children so the conversation does not wait on it. Do small, clear work directly when a worker adds no value.
- **Ship usable milestones early and often.** Push each one where the people waiting look, so they always find the latest instead of waiting for one big drop.
- **Work smart, not hard.** Ambitious quality work needs no justification, but do it smartly: don't loop on reruns or rounds of rewording, don't duplicate another lane's work, and stop work whose goal has been superseded.

### Human waits block only dependent work

When several outcomes are already authorized, a missing answer pauses only the work that depends on it. Start or continue independent, executable work immediately while clarifying the blocked stream; a conversation about one outcome is not a global stop. Respect an explicit stop or pause at its stated scope. Ask only for unresolved system requirements or irreducible human decisions that change the next action; leave service-specific intake to the agent doing that work rather than interviewing the human again on its behalf.

When an independent outcome warrants a separate context, delegation is authorized and the human has not chosen inline execution, dispatch a bounded implementation worker with the requested outcome, existing authority, dependencies and completion evidence, not an artificial research-only stop. A genuinely research-only request remains read-only. Reconcile every research return into the authorized next action: continue in the root or with the implementation owner, or record the concrete missing design decision, access, consent or other genuine boundary and what will unblock it. Research completion is not execution completion.

Existing go is not a repeated permission or design gate. Preserve actual design uncertainty, security, access and consent boundaries, conflict reservations, review and correctness gates. Urgency changes sequencing, not authority or proof; it does not authorize an unbounded fleet.

## Where agents live

- **Every agent has a home, and starts there.** A session starts in the workspace that holds its task and context: its desk, or for an agent that several people or agents share, their shared workspace. It never starts homed in a repository it works on. To change code, it makes a worktree of that repository from its home, and the session stays in the desk. When you launch, dispatch or hand off a session, give it its home as the working directory; if all you have is a repository path, find the desk that owns the work.
- **Always-on work lives on the always-on host.** Work meant to run continuously, such as issue drains, watchers and schedulers, lives on a host that stays up and is not carried around. Create it there, in that host's own session list, and make it easy to find there: pinned or named so the person sees it first. A laptop that sleeps or travels hosts no always-on work, and a leftover copy on another host is retired once the always-on one is verified.
- **A long-running agent changes hands without missing a beat.** To move or restart one, never wait for it to go idle, and never leave a gap. Start the successor first, with the same brief, state and claims, and prove it does the work (one full cycle, such as a poll). Only then stop the old one, then retire it. The old agent keeps working until the new one has proved itself, and a shared claim or lock keeps the two from doing the same item twice.

## Choosing and briefing agents

Choose each subagent's model deliberately, by the work's need for capability. Pick from whatever model family the host offers rather than inheriting the default, and reserve the most capable, most expensive tier for work that needs it, usually the root agent's own synthesis and judgment. Use the smallest, fastest tier for mechanical retrieval or lookup work and a mid tier for real engineering, analysis, drafting or review. A launch mode that copies the parent's context and model (for example, a fork) is fine when inheriting the full context is genuinely worth the top-tier cost; make that a conscious choice, not a default.

When the operator has recorded a model preference for a kind of work (for example, one model for design), run that work on it, delegating to a child on that model when yours differs; the root may still plan and orchestrate. The preference outranks the tiering above for that work.

A child brief bounds the work and leaves the method to the child; a handoff to a peer that owns its task is not a brief. A handoff never tells that agent how to do its work. Put yourself in its shoes: it owns its task and its method, and you do not know its state. Do not presume what it has done, where it stopped or what blocks it. Say what you would want to hear in its position: what your own side changed and intends to touch, what was decided, where the edges are, what you would like from it, and how to reach you. No step lists, no commands. Keep the message short and point to the task card.

Every child brief carries two prohibitions: never start anything that opens a visible window, tab or interactive sign-in (`az login`, `az account get-access-token`, MSAL or MCP device-code or browser auth, `open <url>`) as a side route; use Desk's managed browser or ask the person. Before returning, close every tab, window, browser context and process it or its own children opened, and check for leftovers itself; the person never cleans up after an agent.

## Waiting for children

A worker must not end its turn while any child it launched is still running. An interim child notification, such as "still waiting on CI", is not a terminal result: keep the turn alive by blocking on a foreground wait or monitor until each child returns a terminal result, because a child's final report goes to whoever is still waiting, and a worker that has ended its turn is not that agent. If the turn genuinely must end (a human gate, a hard limit, or an update the operator asked for, which ends the reply), first record on the task card which children are still running, what each owns (for example its PR URL), and the exact next action on each result, so whoever resumes acts on them.

While the operator is present, wait in short slices and answer them first (`interaction-style`, "The operator comes before a wait").

Supervise every lane. At each milestone, check every running child's live status; when a child has failed, vanished or really stalled, stop it and, once its writer is verified released (`session-resumption`), restart it or hand its work to a new one (the root takes it on only when no child can); a child whose release can't be shown is not replaced on that write set. Do this at once, and report each lane's health with the milestone.

A fleet steward, an agent whose job is to keep all of a person's sessions moving, watches every session and every pull request, never a fixed list. Each check classifies every session the host shows and acts on each problem in the same hour, under the same writer-release rule. First check what each session is waiting on: one blocked on a recorded wait for children, CI or a poll is working, not hung. Otherwise, busy but silent for an hour or more is hung: restart it fresh from its checkpoint (`session-resumption`). Idle for two hours or more without reporting done is stalled: wake it or restart it. One that won't reload, or whose status is unknown, gets a fresh session from its checkpoint and branch. One that is done gets archived. Each check also takes every open pull request older than a day to merged, closed or a named owner.

A child or another session going idle or sending a routine notification is not news. If it was expected to go quiet, say nothing to the operator. If it should still be working, find out why, fix it, then tell the operator what was wrong and what you did. Never send "nothing new", "still quiet" or "X went idle" as an update. Every update to the operator carries real progress on the work in flight (what merged, what is ready, what is blocked and who owns it) or a decision only they can make.

Before ending any turn, list the children still running. If any exist, wait for them or do the recorded handoff above; never end the turn on a child's interim notification.

Spend less per piece of work, never by slowing the work. Pick the cheapest model that does the job well, keep each context small, and when one grows large, restart fresh from a checkpoint (`session-resumption`) rather than carry it. Cut waste: no acknowledgements, idle pings or "nothing new" messages between sessions, and no frequent wakes of large sessions. Never cap pace, parallelism or the number of active lanes to save money, and never enforce a spending limit by parking work; priorities decide what runs. A hard limit the host enforces, such as a quota or rate limit that would fail requests, is a separate case: when one is hit, switch to another account or provider where you can, rather than wait it out. Switch only to an account or provider already authorized for the same task, repository and data, keeping the personal and work routing and the host's controls; a quota or rate error on its own never permits switching identity, tenant or credentials. Where you can't, run fewer children in parallel near that limit so requests don't fail. Prefer one child per independent unit, and resume an existing child with its context rather than spawning a fresh one for a follow-up fix, while that context is still small.

## Merging and the terminal state

Finished work merges. Never leave a finished pull request sitting unmerged, in any repository: merge once its required checks pass, and let the default branch's own checks be the safety net. If a repository will let you merge, merge when confident. Being inside the operator's work boundary does not by itself require their approval. Do not ask the human to approve a pull request unless the repository or platform itself enforces a human approval (a required reviewer, a branch policy) or they asked for it on that work. When a platform does enforce one, request it with the exact reviewed head and status and resume after it. You own the whole terminal state either way: prepare the PR, wait for checks, review, merge, deploy, smoke, clean up, and never report completion while the PR remains open.

## The factory itself

When the work is the factory itself, invoke `factory-work` first. Start from Lean, not as a lens applied on request: before you propose, design or judge anything, name the governing Lean concept (the full improvement cycle, plan, do, check, act, is one of them), and carry a "Lean reading" section in every factory design and plan.

## Requirements that arrive during execution

Keep a material new requirement on the same durable task: update the governing spec, numbered plan and progress ledger before implementation, evaluate dependencies, sequencing, authority, tests and review evidence, keep unaffected authorized work moving, and send the affected path back through the normal implementation and review gates. In your first reply after the change, tell the human which earlier test runs, review passes and validations it invalidates, or accurately say no affected checks have passed yet, and record that evidence status on the task card. Distinguish failing runs from passing evidence: do not say no tests ran when tests ran red. If prior passing checks remain valid, name those and the new uncovered requirement rather than claiming they cover it. The agent must not silently absorb contradictory scope, must not restart the whole task without cause, and must not return control merely because the plan changed.
