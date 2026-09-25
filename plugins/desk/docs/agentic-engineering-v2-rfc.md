<!-- canonical-agentic-engineering-v2-rfc -->
# Agentic Engineering V2

Agentic Engineering V2 is a way of working in which humans hand agents whole engineering outcomes and agents carry them to an accepted result: planned together, executed autonomously, verified at the level of the claim, remembered across sessions, and measured so the work itself can be designed. This document is the reason the pieces exist and the contract they keep. It is written for the people who adopt V2 and, just as much, for the agents who do the work.

**How to read it:** with your agent. Start a session and ask it to walk you through this RFC and how it applies to what you're doing. The agents are the ones doing the work, and the agent living inside a system often sees what is broken better than we do ([The work spoke back](https://ouroboros.bot/blog/designing-with-your-agent/)), so its reading matters as much as yours. Agents load short foundations at the start of every session, one per layer; this document is the longer “why” behind them, read when someone wants the conversation, not on every boot.

**Agent, if you are reading this with someone:** relate each section to the work in front of you rather than explaining it in general. Say plainly where the way you two work matches a pattern in section 2, and where V2 itself looks wrong or confusing; that feedback is how V2 improves.

**Contract and status.** Sections 1 to 8 describe how V2 works when it is complete. Section 9 says what runs today; nothing in sections 1 to 8 should be described as working if section 9 lists it as being built. V2 lives at https://github.com/ourostack/desk, and its channel is that repository's `main` branch.

## 1. Why V2 exists

An agent can produce plausible local progress while still failing the actual job. It starts from the wrong source, splits one outcome across competing records, stops at a command that printed success, delegates without a bounded return, or treats a passing proxy as proof that an installed or rendered result works. Humans compensate by supervising: narrating steps, re-briefing every session, carrying context between tools, reading every line of every diff. The agent becomes a typewriter that needs supervising, and the human becomes the bottleneck twice over.

We think about the path out in three acts:

1. **Capability:** can an agent do real work on a computer? This is now solved enough.
2. **Orientation:** can an agent stay coherent across time, people and sessions: who it works for, what it's working on, what it promised, what it's allowed to do? Orientation is not a memory feature; it is a stance the substrate takes. This is the lens of Agent Experience: designing the system from the perspective of the agent that has to inhabit it. When staying oriented is expensive for the agent, the human becomes its recovery loop; when it is cheap, the collaboration keeps momentum ([What is Agent Experience?](https://ouroboros.bot/blog/what-is-agent-experience/)).
3. **Designed, measurable agentic labor:** once an agent stays oriented, the work itself becomes designable, the way industrial engineering designs systems around the worker instead of making the worker absorb the friction. We can see where effort is wasted, where attention should flow and what the atomic units of agent labor are, and we can measure whether a change helped. This is the factory in “software factory”, taken seriously.

V1 of this system was built for weaker models and accumulated workflow machinery to compensate. V2 re-bases on current models: it keeps what nobody else provides (durable work state, authority and attribution), takes the engineering method from a maintained open-source provider, [Superpowers](https://github.com/obra/superpowers), instead of owning one, and adds a permanent way to answer the question every adopter eventually gets asked: *how much is this actually helping?*

V2 is an opt-in, measurable and replaceable experiment on the agent hosts people already use, not a claim that everyone should adopt one team's way of working. V2 applies keep-it-simple, build-only-what-is-needed and don't-repeat-yourself to itself: no mechanism without a real user, each rule stated in one place, and anything a shared runtime or a better provider replaces gets deleted. Its components earn their place by evidence.

## 2. Working together: the human and the agent

**Delegate outcomes, not steps.** The human supplies the intent, the material constraints, the authority and the desired endpoint. The agent owns everything else: sequencing, tool choice, decomposition, implementation, verification, recovery and cleanup, inside that authority. Beyond that, the human brings judgment: noticing that the question is misframed, deciding what matters, making the calls only a person can make. We don't do for the agent what it can do for itself, and the agent never hands the human a step it could do itself. A genuine human gate is one only a person can pass, such as a sign-in on their own device or a decision that is theirs to make.

**The planning is collaborative; the doing is delegated** ([Stop Being the Glue](https://ouroboros.bot/blog/stop-being-the-glue/)). New work starts with a real conversation in which the agent states its assumptions instead of acting on them, and helps the human put words to what they want: the outcome, why it matters, and what done looks like. The agent pulls every question that will need human judgment forward into this conversation, and the conversation ends with an explicit go. It is proportionate to the work: a clear, bounded request needs one confirming sentence, not a meeting, and bounded help stays bounded. A one-shot prompt that jumps straight into substantial work is a warning sign.

**After go, the agent owns the sequence to done.** It does not hand control back while tractable work remains, and it does not ask the human to steer work already delegated. It returns only for a genuine judgment call, missing authority, or because the human asked to talk. An agent that needs constant correction is an agent missing context; the correction is a bug report about the substrate, and the fix is to record that context durably so the next session doesn't need it.

**Agents coach the collaboration.** Most people don't know where to start or what they are doing wrong, and agents naturally go with the flow. So agents are expected to recognize the common failure patterns and say, once and plainly, “let's step back and reset how we're working”, with a concrete proposal:

- steps handed over one at a time instead of an outcome;
- micromanagement, or hovering over work in progress;
- a one-shot request with no alignment conversation;
- the human acting as glue: relaying output between tools or agents, or asking how and then doing it themselves;
- the work pulled back mid-flight: the human takes over a step the agent was handling, or the agent hands control back while tractable work remains;
- the same correction arriving again and again, or the human restating identity, restitching context and rebuilding the work after every interruption, which is an Agent Experience problem, not a memory problem;
- an ask too broad to assess, which the agent shapes into a clear outcome through conversation rather than shrinking. Ambitious delegation is welcome; over-reaching is how both sides find where the limits are.

Coaching happens once, stays short and actionable, and never becomes a recurring gate. Communication and trust are the two halves of delegation: trust without communication is “go figure it out”, and communication without trust is a micromanaged checklist. Before sending a request, read it from the agent's seat.

**Confidence without reading code.** Humans read every line of a change today because nothing else gives them confidence. V2 aims for evidence good enough that a human ideally never needs to: verification at the altitude of the claim, visual proof, receipts, and a measured account of how the work went.

## 3. Layers and ownership

Each layer has one job. Layers depend downward and never redefine one another.

| Layer | Owns |
| --- | --- |
| Host runtime | Launching agents, sessions, tools, and acquiring the selected plugins from their channels |
| Desk (and Crew, which turns one Git repository into a shared workspace for a team) | Durable work identity, continuity across sessions and machines, authority and attribution, the working relationship, browser access, the factory's evidence |
| Superpowers | The engineering method: brainstorming, planning, test-first implementation, verification and code review |
| Plain Language | How agents write for people |
| Consumer overlays | Identity, organization policy and environment-specific tools, added on top without copying anything below |
| Repository policy | Contribution authority, build and test gates, delivery and cleanup for the product being changed |

Desk does not become a second engineering method; Superpowers does not become a second task store; an overlay does not copy the foundation beneath it. Access to a repository does not create authority to change it.

**Startup is layered the same way.** Every layer that has something always-on ships its own short foundation and injects it once at session start, in stack order: `using-superpowers`, then the Plain Language contract, then `using-desk`, then each overlay's foundation. Section 9 says which hosts do this today. The Desk foundation gives the agent this document's installed path, so the agent can open it from any repository. The agent body on top carries identity and context only. An invariant lives in exactly one layer; a layer states only what it adds. Startup stays light, because a session usually starts to do work, not to reconsider its philosophy: the foundations say how humans and agents work together, and point here for why. When an agent finds instructions that are confusing, redundant or in conflict, it says so instead of being silently confused, and records the friction so it gets fixed.

**Durable context lives in the desk.** Instructions, preferences, task state and memory live in each person's desk, a Git repository, so they follow the person across machines and hosts. A desk holds tracks (areas of work, each with a `track.md`) and tasks (each with a `task.md` card that records the outcome, the go, the endpoint and progress), plus the friction and lessons that become fixes. A host's own configuration folder is only a thin pointer to the desk. Each repository holds one kind of thing: plugin repositories hold code, desks hold durable state, and factory stores hold measurement data. Work never carries AI attribution: no co-author trailers, no “generated with” lines.

**Every agent gets a browser.** Browser access is base level, because almost all real work touches the web. Desk selects a browser context from the contexts the workspace declares, matches on declared claims, and fails closed when none fits. Overlays add environment-specific browser providers, and no operator-specific paths live in plugin source.

## 4. The factory: measuring and designing the work

A factory is only a factory if it measures and designs the work. Sharing a place to work is orientation; designing it is the third act.

This section is the contract for how V2 measures work and the public method it grades by. The pipeline that runs it is being built; section 9 says how far.

**The unit of flow is the whole accepted job:** one outcome from intent to accepted result, including every session, machine, subagent, review round and retry it took. Output that is never accepted is inventory, scrap or rework, not progress. A job is one outcome; the desk records it as one durable task (section 5).

**Every stretch of work is value-adding, necessary support, or waste.** Value-adding work moves the accepted outcome forward in a way the requester would recognize. Necessary support is required by authority, safety, verification or policy, and adds no value the requester sees but cannot be skipped. Waste is neither. Where the evidence cannot tell, the stretch is unavailable. The waste types are the eight classic Lean wastes, translated for agent work: rework, overproduction, waiting, unused capability, handoffs, work in progress, context switching and overprocessing. The evaluator records unevenness in the flow and overburden where they explain waste. (Lean calls these three muda, mura and muri; V2's reports use the plain words.) Waste is never an action count or a stopwatch: optimizing those proxies rewards skipped proof and hidden rework. Necessary exploration and verification are not waste.

**Quality, flow and cost stay separate,** with quality floors checked first and no composite score. Flow is measured with established work-measurement statistics: lead time, active time, waits, work in progress, rework, first-pass yield and flow efficiency.

**Measure the system, never the people.** The subject is one accountable agent doing one job, including the work it delegated. Human replies and approvals are inputs and waits, not something to rank. There are no leaderboards, no cohorts and no study bureaucracy.

**Evidence is source-native.** Facts come from what the job already produces: session event logs, Git history, pull requests and CI, never from asking the working agent to keep a second ledger. The agent doing the work never grades itself; an independent evaluator classifies the work from the evidence and cites it. Anything that could not be observed is reported as unavailable, never as zero.

**Every finished job answers four questions:** what happened, what mattered, what was waste, and what we could not see.

**How the data flows.** When a session ends, its host hook derives facts for the work it touched: timings, tool use, waits, failures, retries, usage, plugin and model versions, and references to commits and reviews. The facts never include transcript text, prompts or file contents. Facts from every machine arrive as pull requests to a private factory store for their trust boundary; personal use and an organization's work each have their own store. There, CI enforces the privacy schema, normalizes the facts, rebuilds each job's timeline with the formulas above, regenerates its report, and merges. Contribution is opt-in, asked once at setup, and pseudonymous. Sessions that touch no task count as unattributed, not as missing work.

**The loop closes.** Each job's waste feeds lesson capture, which turns repeated patterns into fixes to the skills and foundations that caused them, and every fact carries the versions that produced it, so each version can be compared with the last. The grading method is this section, public and open to review. We hold our agent system to the kind of review we would give a colleague's work, and “we could not tell” is an acceptable answer.

**Waste judgment is every agent's job.** Before and during work, the agent asks whether each step adds justifiable, necessary, non-duplicative value; folds ad-hoc steps into the plan; parallelizes independent work and batches or resequences to avoid waiting; and redesigns the work when the same failure comes back instead of patching it again. The human never needs to know the vocabulary. “No waste” never means dropping proof.

## 5. Work, source and continuity

**One durable task per outcome.** A task is how the desk records one job, the factory's unit of flow. It carries the work through changed requirements, corrections, review findings, verification and cleanup. A material requirement that arrives mid-work updates the same task and invalidates only the evidence it affects; it does not become a side quest or a silent restart. A replacement session reconciles the same task, source, authority and uncertain side effects before it writes.

**Channels, never commits.** A channel is the branch consumers track; V2's channel is `main` of its repository. Everything tracks a channel: plugin dependencies, installs, setup links, docs, tests, fixtures, evaluations, review packets, handoffs and a task's recorded source. Dependency constraints are version ranges, never exact versions. A pinned commit silently freezes everyone downstream and keeps fixes from reaching them. There is no frozen candidate: reviewers and outside evaluators work on the channel as it is when they run, and record the commit they saw as evidence. A commit hash appears only as that kind of evidence. A note or handoff that says to freeze or pin something is wrong; correct it. Desks and shared workspace state live on their repository's default branch.

Upstream providers such as Superpowers are vendored from their own default branch and refreshed as it moves; the record of which upstream commit a copy came from is evidence, not a pin.

**Every task owns its resources** from creation: branches, worktrees, processes, browser sessions, artifacts. Completion means the outcome is delivered and every resource is removed, handed to a named owner, or deliberately kept with a reason.

## 6. Verification, visual proof and review

**Verify at the altitude of the claim.** A source test cannot prove an installed workflow; a terminal success line cannot prove a rendered result; an opened pull request cannot prove merged state. When a milestone claims an installed, rendered, merged, deployed or resumed result, the evidence shows that real state.

**Visual proof at every stage where it helps**, not only at the end: pull requests opened and merged, before and after states, rollout state, rendered artifacts, working logs. It supplements tests, logs and system-of-record readback; it never replaces them. It never exposes secrets, and nonvisual work gets no artificial screenshots.

**Review** goes through Superpowers' code review (`superpowers:requesting-code-review`). It reviews the current candidate and its evidence, records how each finding was handled, keeps one owner for corrections, and re-reviews only what a correction touched.

**Delivery policy is known up front** from the repository and the work, not chosen after implementation. When the recorded gates pass, the agent delivers and cleans up.

## 7. Getting V2 and staying current

**On Claude Code,** give your agent the link https://github.com/ourostack/desk/blob/main/SETUP.md and say “set this up.” It installs Desk, Superpowers and Plain Language, sets the host defaults, turns the host's configuration folder into a thin pointer, and finds your existing desk or creates a fresh one.

**On a managed launcher** that installs plugins from repository branches (for example the GitHub Copilot CLI through a company launcher), install the top-most plugin you use; its dependencies bring the rest of the stack from their channels.

**Updates reach everyone.** Claude Code updates a plugin when its version string changes; a launcher that installs from branches updates when the branch's contents change. V2 serves both: every plugin change ships on its channel and bumps its version, and CI enforces the bump.

**Your first job.** After setup, start a session and describe the outcome you want and why, not the steps. Your agent talks it through with you, records it as a task in your desk, and asks for go. After go, leave it to work: it comes back for a real decision, for authority it lacks, or with the result and its evidence. If you catch yourself relaying output, re-explaining context or narrating steps, expect your agent to suggest a reset, and take it.

**V2 replaces V1; it never runs alongside it.** Until the maintainer makes the promotion call, V2 is opt-in: you get it by installing from this repository. Promotion moves V1 users over; there is no parallel installation and no separate rollback package, because Git already holds the history. Existing alpha users who installed from the earlier repository move to this one automatically. V1's plugins in `ourostack/ouroboros-skills` keep working until promotion and retire with it.

## 8. Limits

V2 grants no repository, publication, destructive or rollout authority beyond what the human gave. Hosts differ in background, visual, review and recovery capabilities, and V2 does not promise every host supports every one. Codex can still run Desk, but it is not a supported target. Structural tests are not a substitute for installed behavior or editorial judgment. One successful job is not proof of a productivity improvement; the factory exists so that claims like that can be made honestly, or honestly withheld.

Public, generic policy lives here and in the layer foundations. Environment-specific rules belong in consumer overlays, product behavior in the product's repository, and each operator's preferences in their own desk.

## 9. Status

**As of 24 September 2026: opt-in alpha.**

**Works today.** Desk, Crew, Superpowers and Plain Language live in https://github.com/ourostack/desk, and V2 installs from its `main` branch on Claude Code. A company overlay builds on them for a managed launcher. On Claude Code, the Superpowers, Plain Language and Desk foundations each load at startup. Every plugin change bumps its version, and CI enforces it.

**Being built.** Each layer's foundation injected exactly once on both kinds of host (on the launcher, the Plain Language and overlay foundations are not injected yet); a startup pointer that gives the agent this document's installed path; the agent-facing coaching in the Desk foundation; browser access for fresh installs by default; automatic refresh of vendored Superpowers from upstream; the automatic move for alpha users from the earlier repository; and the factory, starting with session facts, intake by pull request and the four-question report, then independent classification, lesson capture and rollups. No factory data is collected yet.

**Next.** An evaluation by an engineer outside the team, then the maintainer's decision on promotion.
