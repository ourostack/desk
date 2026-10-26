# desk:worker — agent files

The desk plugin ships a substrate-default engineering agent named `worker`. The same canonical body lands in two formats so the agent works natively on Claude Code and Copilot CLI.

| File | Harness | Format | What it gives you |
|---|---|---|---|
| `worker.md` | Claude Code | YAML frontmatter + markdown body | A discrete agent selectable via plugin loader / marketplace. Invoke `claude --agent desk:worker`. |
| `worker.agent.md` | Copilot CLI | YAML frontmatter (`target: github-copilot`, `user-invocable: true`) + markdown body | A discrete agent that appears in Copilot CLI's agent picker. Invoke `agency copilot --agent desk:worker` (or `copilot --agent desk:worker`). |

The plugin also ships `observer`, `worker`'s sibling, in the same two formats (`observer.md`, `observer.agent.md`). Named for Lean's process observer, it watches work it did not do, times it and classifies each step from evidence, and never does, fixes or certifies that work. It is never the default agent: invoke `claude --agent desk:observer` or `agency copilot --agent desk:observer`, and see [its release-evaluation skill](../skills/evaluate-release/SKILL.md) and the [evaluation packet](evaluation-packet.md).

## Install + invoke per harness

### Claude Code

The plugin's `.claude-plugin/plugin.json` and `agents/` directory are picked up by the standard plugin loader. Reference the plugin from a marketplace manifest, or install it through whichever tool you use to manage Claude Code plugins. Once installed:

```bash
claude --agent desk:worker
```

### Copilot CLI

The root `plugin.json` names `agents/` as the agent directory. Start a session with the worker:

```bash
agency copilot --agent desk:worker
```

Copilot has no setting that makes a plugin's agent the default, and Agency passes `--agent` to Copilot only when the launch names one. The `activation.copilot.targets["desk:worker"].default` field in `plugin.json` is Desk's own packaging metadata; neither host reads it. So every launcher, including an agent that starts Copilot, should pass `--agent desk:worker`. A session started without it still gets the Desk foundation from the `sessionStart` hook, but not the worker's own instructions.

Desk's `sessionStart` hook sets `askUser: false` in Copilot's settings once when the operator has not chosen a value, so the `ask_user` question form is off from the next session, as `disallowedTools: ["AskUserQuestion"]` does in Claude's worker. The hook does the same for `includeCoAuthoredBy`, and it sets `memory: false` on every start. `--excluded-tools=ask_user` on the launch still works and also covers the first session.

The root package carries generated flattened Superpowers metadata for Copilot-compatible hosts. Desk + Superpowers and the declared companion closure must be loaded from the admitted roots; metadata alone is not runtime proof. The existing overlay keeps its own worker instead of launching the standalone agent above.

The root plugin also registers a Desk-owned `sessionStart` hook. Copilot executes that hook with the installed plugin root, and the hook reads `skills/using-desk/SKILL.md` at runtime to emit the canonical foundation as `additionalContext`; `worker.agent.md` does not carry a copied foundation body.

No bespoke Desk CLI is required for the default worker path; the host plugin profile and bundled MCP metadata carry the setup.

## Structured questions on Claude Code

Desk's Claude `worker.md` and `observer.md` declare `disallowedTools: ["AskUserQuestion"]` while retaining `tools: ["*"]`. This is the host-supported agent tool policy, scoped to those selected agent definitions, not a host-wide permission change. It leaves in-session todos, process-control tools, MCP tools and ordinary chat questions alone. It does not establish inheritance into independently defined overlays, arbitrary subagents, or another host.

Claude plugin `settings.json` supports only `agent` and `subagentStatusLine`; putting `permissions.deny` there would be silently dropped. A launcher that owns a wider session policy can use native `claude --disallowedTools AskUserQuestion` or its owned settings' `permissions.deny` instead. Permission denial is not, by itself, evidence that the tool is hidden from the model: qualify the actual new session's host-reported catalog separately. Do not add a tool-call hook just to reject a form after the model has already spent the call.

Primary host references: [Copilot CLI flags and agent fields](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), [Claude agent tool policy](https://code.claude.com/docs/en/sub-agents#available-tools), and [Claude plugin settings](https://code.claude.com/docs/en/plugins-reference#settings). Installed help checked on October 15, 2026: Copilot CLI 1.0.97 and Claude Code 2.1.300. These contracts describe activation inputs, not consumer runtime qualification.

The October 15 complete-closure native probe loaded all three actual source roots and emitted a host startup catalog without `AskUserQuestion`, retaining `TaskStop`. It did not expose `TodoWrite`, and MCP servers were disabled for isolation, so those surfaces are not runtime-qualified by this probe. The host then exited with `Not logged in · Please run /login`: ordinary-chat question/decision behavior remains unqualified, and no sign-in flow was attempted. Earlier probes that omitted the dependency roots failed before producing a catalog; see the [native qualification record](../activation/host-capability-evidence.md#complete-closure-native-result).

## What if I want a context-specific overlay?

The `worker` agent here is the substrate-default — generic, applicable to any engineering context. If you want corporate-engineering, autonomous-agent, or personal-coding flavored extensions (org-specific auth, work-item trackers, tooling conventions), author a sibling plugin that:

1. Depends on `desk` (so all the substrate skills + MCP are inherited)
2. Ships its own `agents/<name>.md` and foundation with extended skills and tooling
3. Optionally adds its own context-specific skills

The substrate stays generic so it can serve any overlay; overlays carry the parts that depend on whose desk it is.

The first-class dependency ladder is:

```text
desk substrate -> desk:worker -> ms-desk:worker -> area overlay
```

`desk:worker` is the standalone target. Downstream overlays inherit it rather than copying its skills, MCP or body. Select the authorized overlay chain with Desk and Superpowers and preserve one Desk MCP server. Source packaging and actual host inheritance require separate evidence.

`desk_status` with `{ detail: true }` reports the active selected activation and chain when the host passes activation context.

### Live readiness diagnostics

`desk_status` answers compactly unless called with `{ detail: true }`: `state` (the boot script's own words: `ready`, `degraded`, `admitting`, `setup_required`) says whether Desk works, `degraded` and `fix` say why and what to do, and `search` is the index word below. In the full payload, `readiness.state` is one word for agents: `ready`, `converging`, `degraded`, `unavailable` or `not_checked`. It describes the search index's readiness controller only; the top-level `state` (admission) decides whether Desk's tools work, so a `ready` admission with a `degraded` readiness means tools work and search falls back to direct reads. `readiness.meaning` says so in a sentence. The controller's own state name (`READY`, `LEXICAL_READY`, `RECOVERING`, and so on) is `readiness.detail.controller_state`.
`readiness.detail.convergence` contains only the latest convergence
snapshot: `status` (`not_checked`, `pending`, `succeeded`, or `failed`),
`semantic` coverage, and a failure `diagnostic` when present. A disconnected
controller reports `unavailable` with a diagnostic, not a stale ready state.
Diagnostic text fields are capped at 2,048 characters. Controller tokens and
owner metadata are not included in the tool response.

Background startup exposes the server before convergence. Initial query
embedding availability is `not_checked`; once the controller finishes,
`query_embedding.available` and its diagnostic reflect the active query probe.
A failed probe leaves the controller `LEXICAL_READY` (`readiness.detail.controller_state`), reports availability
`false`, and adds `query_embedding_unavailable` to `degraded_modes`. Complete
semantic coverage with a successful probe produces `READY`. Required mode
finishes convergence before exposing the server. A convergence exception adds
`convergence_failed`; an unreachable controller adds `readiness_unavailable`.

`startup_fallback.mode: not_checked` still means no legacy startup `ensureIndex`
record exists; it does not mean background convergence is pending.
`startup_fallback.degraded` also reflects observed query or convergence failures.
Status reads do not start convergence, probe embeddings, or satisfy readiness
barriers. Readiness progresses even when no one calls `desk_status`.

## `$DESK` binding

The agent body uses a `$DESK` placeholder for the workspace directory. The consumer agent's preamble declares the binding — substitute textually when interpreting skill instructions or running shell commands. Defaults are:

- Standalone install: `$DESK = ~/desk/`
- Autonomous-agent overlay: `$DESK = ~/AgentBundles/<agent>.ouro/desk/`
- Personal-coding overlay: whatever the operator declares
- Corporate-engineering overlay: whatever the org's convention is

One canonical body. Many rooms.
