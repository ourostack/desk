# Alpha host packaging contracts

These rows describe the current source packaging and its validation entrypoints, not end-to-end alpha runtime admission. The legacy schema's `supported-*` dispositions refer to packaging contracts. Full selected-source consumption, task behavior, background inheritance, Windows native CLI and composed consumer qualification require their own fresh evidence.

The earlier [host evidence](../../../desk/tasks/2026-06-14-1335-doing-desk-dependency-activation/host-capability-evidence.md) remains unchanged and historical. It does not become Superpowers runtime evidence when a source path or version changes. Claude background inheritance remains unsupported. Generic stdio remains MCP-only.

| host_id | surface | disposition | source_paths | evidence_command_or_doc | unsupported_primitives | fallback_behavior |
| --- | --- | --- | --- | --- | --- | --- |
| claude | Claude foreground plugin source package | supported-native-or-flattened | plugins/desk/.claude-plugin/plugin.json; plugins/desk/.mcp.claude-codex.json; plugins/desk/agents/worker.md; plugins/desk/agents/observer.md; plugins/superpowers/.claude-plugin/plugin.json; plugins/plain-language/.claude-plugin/plugin.json | node --test tests/desk/mcp/__tests__/activation/claude_packaging.test.js; node --test tests/desk/mcp/__tests__/activation/superpowers_host_consumers.test.js; alpha runtime qualification required | agent-view-dispatch; background-session-inheritance | launch foreground with `claude --agent desk:worker`; ship flattened bundle when transitive dependencies are unavailable |
| copilot-root | Root Copilot source package and selected provider adapter | supported-flattened | plugins/desk/plugin.json; plugins/desk/agents/worker.agent.md; plugins/desk/agents/observer.agent.md; plugins/desk/hooks/copilot-hooks.json; plugins/desk/hooks/copilot-session-start.cjs; plugins/desk/.mcp.copilot.json; plugins/superpowers/plugin.json; plugins/superpowers/hooks/copilot-hooks.json; plugins/plain-language/plugin.json; plugins/desk/activation/copilot-root.flattened-bundle.json | npm --prefix plugins/desk/mcp run activation:copilot-bundle:generate; node --test tests/desk/mcp/__tests__/activation/copilot_packaging.test.js; alpha runtime qualification required | transitive-dependency-resolution | load the generated flattened Desk, Superpowers and Plain Language bundle metadata |
| ouroboros-autonomous-agent | Ouroboros/autonomous-agent source bundle wiring | supported-flattened | plugins/desk/README.md; plugins/desk/activation/README.md; plugins/desk/.mcp.claude-codex.json; plugins/desk/plugin.json; plugins/superpowers/plugin.json; plugins/plain-language/plugin.json | node --test tests/desk/mcp/__tests__/activation/ouroboros_stdio_packaging.test.js; plugins/desk/README.md#under-ouroboros; plugins/desk/activation/README.md#ouroboros-autonomous-agent; alpha runtime qualification required | host-native-plugin-install | bundle Desk + Superpowers + Plain Language into the agent bundle and bind $DESK to ~/AgentBundles/<agent>.ouro/desk/; alpha source packaging is not native runtime qualification |
| generic-stdio | Generic stdio MCP launch only | degraded-mcp-only | plugins/desk/.mcp.claude-codex.json; plugins/desk/mcp/README.md; plugins/desk/activation/README.md | node --test tests/desk/mcp/__tests__/activation/ouroboros_stdio_packaging.test.js; plugins/desk/mcp/README.md#generic-stdio-mcp-launch; plugins/desk/activation/README.md#generic-stdio | agent-defaults; plugin-dependency-resolution | start MCP with explicit --root or DESK and no worker activation |

## Structured-question policy qualification

October 15, 2026; Claude Code 2.1.300. Source policy declares only `AskUserQuestion` in each Desk Claude agent's `disallowedTools`, retaining `tools: ["*"]`. Source regression tests and native `claude plugin validate plugins/desk` pass; those checks do not establish a running consumer's tool catalog.

The isolated native probe used the actual Desk plugin with `--plugin-dir`, `--agent desk:worker`, empty settings sources, and no MCP servers. It exited before emitting an initialization catalog. A single diagnostic retry enabled only the owned fixture's local settings scope, disabled session persistence, and captured the host's debug log. That retry also exited 1. Its loader evidence, in order:

- `Loaded inline plugin from path: desk`
- `Dependency "superpowers" is not installed`
- `Total plugin agents loaded: 0`
- `--agent 'desk:worker' not found`

The namespace matches the manifest. The fixture omitted Desk's declared dependency closure: Superpowers and Plain Language were not supplied. The settings-scope hypothesis did not resolve the failure. This was **fixture composition failure**, not an unsupported native activation verdict. Those incomplete runs established neither tool absence nor ordinary-chat behavior.

### Complete-closure native result

A separately authorized single corrected probe at 17:45 UTC loaded all three actual worktree roots through repeated `--plugin-dir` arguments, selected `--agent desk:worker`, and used a 60-second timeout. Source HEAD was `56dd397cc3403cf64bfa3fd0f8c0175670bfd2ff`. No agent reconstruction, dependency removal, CLI `--disallowedTools` override, or authentication change was used. Other relevant native flags were `--print --verbose --output-format stream-json --dangerously-skip-permissions --setting-sources local --strict-mcp-config --mcp-config '{"mcpServers":{}}' --max-turns 1 --no-session-persistence`. The isolated profile had no MCP servers, so this does not qualify MCP preservation.

The native debug log reports each root loaded, then `Loaded 3 directory-loaded plugins`, `Found 6 plugins (6 enabled, 0 disabled)` (including the host's three built-in plugins), and `Total plugin agents loaded: 2`. The native initialization event identifies Desk from the qualified `main`-channel source, Superpowers from the selected upstream source, and Plain Language 0.2.6 from the actual source paths, and includes `desk:worker` and `desk:observer` in the agent catalog.

The host's initialization `tools` catalog contains 22 tools:

```text
Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit,
EnterWorktree, ExitWorktree, ListAgents, NotebookEdit, Read, ReportFindings,
ScheduleWakeup, SendMessage, Skill, TaskStop, ToolSearch, WebFetch,
WebSearch, Workflow, Write
```

`AskUserQuestion` is absent and the process-control tool `TaskStop` is present. `TodoWrite` is also absent; this profile supplies no evidence for its preservation or why the host omitted it. This is actual native startup-catalog evidence for the selected Desk worker, not a model's self-report, a denied tool call, or a fixture-generated catalog.

The requested ordinary-chat question was `Which file should I inspect?`. The host did not execute a model response: it emitted `Not logged in · Please run /login`, `is_error: true`, and exited 1. There were zero tool-use events and no files written in the owned workspace. **Startup tool absence is observed; ordinary-chat question/decision behavior remains unqualified because authentication failed.** No browser or sign-in flow was attempted. The exact native PID/process group, 93130, was verified absent after exit.

Copilot CLI 1.0.97 exposes native `--excluded-tools`; installed `agency copilot --help` exposes it through the documented `[EXTRA_ARGS]` forwarding surface. Desk's production activation surfaces do not own that external argv construction. Its bundle `launch` object contains agent and MCP paths only. The evaluation-only `copilotFlags()` builder is not ordinary consumer activation. Desk's `sessionStart` hook instead sets Copilot's `askUser: false` setting once when it is unset; see [Copilot CLI agent files](../docs/agent-files.md#copilot-cli).
