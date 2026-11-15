# Agentic Engineering Epoch 3

**Status:** current. It states the principles agreed on 2026-11-10 and the working rules agreed after. Epoch 3 landed in place on Desk's `main`, one small merged change at a time; there is nothing to switch to. The [Epoch 2 RFC](agentic-engineering-v2-rfc.md) stays as history and still describes the machinery it built. Where the two disagree, this document says where Desk is going and the changelog says what runs today.

Ari's quotes below are the sources. When a rule is unclear, go back to the quote and decide from intent.

## Why Epoch 3

Epoch 2's principles were mostly right: delegate outcomes, align before go, own execution after go, keep it simple. But each principle was written twice, once as always-on text every agent pays for on every turn and once as machinery to enforce it (guards, doctors, boot checks, pipelines). The result was slow and heavy, and it bound agents' hands. Epoch 3 keeps the principles, states each once, and trusts the agent.

> "the best code is the code you never had to write"; "building our tooling is an exercise in restraint. if we can delete most of our code during exeuction, i consider that a massive win".

## Who it serves

Many people, many teams and many agents. One person's setup is one instance of it. Agents are users too, and their context, confusion and waiting count as much as a human's attention. Human attention is the scarcest thing in the system, so every part is judged by the attention it saves minus the overhead it adds.

> "yes - several people AND many agents"; "also other teams using Crew; not just [one team]".

A team builds its own domain tooling on top of the shared layer and composes it instead of rebuilding it. The shared layer stays small and stable enough to build on, and it never makes a team's tooling harder to write or run.

## The contract

1. **Conversation.** Before an outcome is delegated, the human and agent talk until intent, constraints and a measurable, verifiable **definition of done** are clear. The agent drives it: it surfaces the decisions the work will need and asks "what have we missed?". It doesn't act until released.
2. **Release.** From then on the agent owns execution and decides from intent when it meets the unforeseen.
3. **Two signals.** The agent breaks silence only to say **"ready for you, it's here, I'm continuing"** or **"done"**. Each carries **proof from primary sources**: screenshots of the real thing, not prose and not generated graphics. How it was done is available if asked, never required reading.
4. **Outcomes, not steps.** People delegate outcomes and needn't know how things get built.

Needing the human mid-task is a failure of the conversation, and the lesson goes there.

> "ideally, 2 never ever happens, because all judgement and intend should have been shaken out during the conversation"; "i do need to be given visual proof (screenshots of primary sources, not generated graphics etc)"; "folks should not know or care about *how* things get built".

## The two boundaries

Agents never do anything **irreversibly destructive**, and never **contact another human without approval**. Epoch 3 adds no other boundary. A repository's own permissions and contribution rules are facts of the environment, not Epoch 3 rules. Destroy only what you created: never delete, reset or stop a machine, container, profile, branch, worktree or file you didn't create in the task.

> "those are really the only two boundaries, ever ever".

Tools follow from this. A tool never refuses a command an agent chose to run; it puts guidance in its replies and errors and makes the right path the easy one. Every error says what probably happened, how to look further, the one call that files a bug with the evidence, and how to keep working meanwhile. No error costs an agent its confidence.

> "no handcuffs!!!"; "the absolute last thing the tool should do is kill the agent's confidence".

## Context, not overhead

- **Context** is what the task needs: history, intent, the relevant files. Give it generously.
- **Overhead** is everything paid whatever the task: always-on rules, tool schemas, injected policies, guards, rituals and restrictions. Each piece justifies its cost, measured, or goes.
- **The always-on part is tiny.** It says only what an agent can't discover alone: what system this is, where this RFC lives, the contract and the two boundaries.
- **Every byte of context is observable.** Nothing is injected behind the agent's or the human's back.
- **Progressive disclosure.** A skill costs its name and description until it is used.
- **Prefer a CLI and a README read on demand to a tool server.** Add a tool only when an eval shows the ordinary path is worse.
- **Build on shared agent-experience tooling, not bespoke tooling.** When it lacks something, contribute it there.
- **Learnings flow back to the source** that owns the behavior: fix the test, doc or tool, and add no rule that something already says.

> "slop is what happens when your agent did not have enough context"; "all overhead must be totally justified"; "things that bind agents hands, regardless of intention? more often than not, that is expensive and unnecessary overhead".

## State and flow

- **State is plain files in Git.** Desks hold tracks and tasks as Markdown that agents read and edit with ordinary tools. Sessions are disposable; the files are the memory.
- **Desks and workspaces keep everything on `main`.** Worktrees and pull requests exist for parallelism and synchronization.
- **Product repositories keep their own gates.** If a repository lets you merge, merge.
- **Trunk-based, in the smallest unit that lands.** An outcome is many small increments on `main`, never one big branch and never a milestone. Merge on green. A red `main` is the first job of whoever finds it: fix it or revert. Never close a pull request because of a clock or one failed check: find the cause, re-run a known flaky test once and say so, then merge. From pull request open to live takes minutes, and speed comes from redesigning the pipeline, never from skipping a check.
- **No undo machinery and no deadlines.** Ship incremental, verifiable, well-tested value instead. Thirty minutes is a goal for a change, never a rule and never a reason to discard work.
- **Work in your own worktree,** started from the latest `main`, and clean it up when the change merges. Never `git stash`: stashes are shared by every worktree of a repository.
- **Homes come from meaning.** A track is an ongoing area and a task is one outcome. People and agents choose where things live, and the tools don't enforce it.
- **Plan with the capable model, execute with the cheap one,** and always name the model explicitly.

> "i've had enough of this nonsense, building giant milestones and not shipping incremental value ... always ship incremental value!!!!!"; "makign it possible to do that will be giant overhead"; "these 'by morning' deadlines end up just causing more confusion"; "30min itself arbitrary"; "if a repo lets you push right to main / merge without additional signoff, do it!"; "we give people+agents the tools, they decide where the right home is"; "boss agents stay as the more capable models, but use cheaper models for exeuction".

## Always-on agents

Persistent agents are a buddy system: each keeps the other alive, because whatever one runs on can fail. They coordinate and give high-level visibility. Conversations with humans happen in working sessions.

> "buddy system / accountability partners".

## Epochs and versions

An **epoch** is a generation of the platform. "v" is only for package versions, such as Desk 3.2.103.

| Epoch | Defining design | Desk versions | Dates |
|---|---|---|---|
| **1** | The Desk 1.0 setup; no separate RFC | 0.1.0 to 1.8.0 | 2026-05-22 to 2026-08-24 |
| **2** | The [Epoch 2 RFC](agentic-engineering-v2-rfc.md) | 2.0.0 to 3.2.85, including the 3.2.0 alpha previews and stable 3.2.0 (2026-10-26) | 2026-08-25 to 2026-11-11 |
| **3** | This document | 3.2.86 and every release after (3.2.167 on 2026-11-15) | 2026-11-11 onward |

Desk's major version didn't change at the Epoch 2 to 3 boundary, because Epoch 3 landed in place on `main`. The boundary is a git fact: the commit that published the Epoch 3 principles (`12cee98b`, #724) is an ancestor of Desk 3.2.86 and not of 3.2.85. Desk 3.2.0 to 3.2.85 are Epoch 2, and 3.0.0 to 3.1.2 are part of Epoch 2's lineage. Ouroboros alpha releases from alpha.1090 onward belong to Epoch 3.

## Adoption and measurement

There is no switch-back. Live work is the proof: real tasks run on Desk's `main`, and the people and agents doing them are its customers, so their failures are the shared tooling's backlog. Everyday tasks also have offline evals: a realistic prompt, a throwaway copy of the repository and a mechanical check of the result, recording time to "ready", time to "done", tokens and tool calls. A change that touches a measured task is judged on them.

## Later

Observing how executions ran (lean, the factory) and tracking work across them both matter, once everything above works.
