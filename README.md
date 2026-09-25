# Desk

Desk gives long-running engineering agents durable work state and authority. Tracks, tasks, friction notes and lessons live in the operator's desk, a Git repository, so work survives sessions, machines and harnesses. An MCP server provides desk CRUD and search, and lifecycle skills keep task state current as work moves.

**To set up, give your agent the link to [SETUP.md](SETUP.md) and say "set this up".**

This repository is the home of **[Agentic Engineering V2](AGENTIC-ENGINEERING-V2.md)**, an opt-in alpha. Its `main` branch is the release channel.

## Plugins

The `ourostack` marketplace in this repository ships four plugins:

| Plugin | ID | What it does |
|---|---|---|
| [Desk](plugins/desk/README.md) | `desk@ourostack` | Durable desk state, authority and approved delivery boundaries, with the `desk:worker` agent and the Desk MCP server. |
| Superpowers | `superpowers@ourostack` | Superpowers, the engineering method, vendored from upstream. Installing Desk pulls it in. |
| Plain Language | `plain-language@ourostack` | The prose policy for human-readable agent output. Installing Desk pulls it in. |
| [Crew](plugins/crew/README.md) | `crew@ourostack` | The multi-person shared-workspace layer on top of Desk. |

Agency and other hosts that resolve plugins from Git use the coordinates `github:ourostack/desk:plugins/<name>@main`.

## Repository layout

```
.claude-plugin/marketplace.json   # Claude Code marketplace (ourostack)
.agents/plugins/marketplace.json  # Codex marketplace
plugins/desk/                     # Desk plugin, MCP server, activation and browser context broker
plugins/superpowers/              # Vendored Superpowers, hash-locked in upstream-sources.lock.json
plugins/plain-language/           # Plain Language plugin
plugins/crew/                     # Crew plugin
evals/                            # Offline evaluation contracts
scripts/                          # Validation and release checks run in CI
```

## Releasing

Hosts pick up changes differently: Agency re-resolves the branch, while Claude Code updates only when a plugin's version string changes. Every change to a plugin's files therefore bumps its version in every manifest and in the marketplace entry. CI enforces this with `node scripts/check-release-integrity.cjs`, and `node scripts/check-dependency-channels.cjs` keeps plugin dependencies on the `main` channel instead of exact commits.

## Upstream sources

`node scripts/check-upstream-sources.cjs` compares every vendored public source against `upstream-sources.lock.json` and reports whether it is current, changed without selected-payload changes, needs human approval, or is blocked. It never updates the lock or the vendored files.
