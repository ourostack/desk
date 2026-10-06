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
plugins/superpowers/              # Vendored Superpowers; upstream-sources.lock.json records the upstream commit as evidence
plugins/plain-language/           # Plain Language plugin
plugins/crew/                     # Crew plugin
tests/desk/                       # Desk tests and fixtures, mirroring plugins/desk; kept out of the plugin so installs never download them
evals/                            # Offline evaluation contracts
scripts/                          # Validation and release checks run in CI
```

## Releasing

Hosts pick up changes differently: Agency re-resolves the branch, while Claude Code updates only when a plugin's version string changes. Every change to a plugin's files therefore ships as a new version, named the same in every manifest and in the marketplace entry. CI enforces this with `node scripts/check-release-integrity.cjs`, and `node scripts/check-dependency-channels.cjs` keeps plugin dependencies on the `main` channel instead of exact commits.

Desk releases from `main`. A pull request that changes Desk adds a changelog fragment under [`plugins/desk/changelog.d/`](plugins/desk/changelog.d/README.md) and does not touch Desk's version or the head of its changelog, so parallel pull requests do not conflict. After the merge, the [Desk release workflow](.github/workflows/desk-release.yml) takes the next alpha on every release surface, folds the fragments into `plugins/desk/CHANGELOG.md` and commits the release to `main`. It checks that release commit before pushing it (release integrity, skill, docs, host-manifest, generated-artifact and contract validation, and the release, activation, artifact, docs and script tests), because a push made with the workflow token starts no CI. The job that installs dependencies and runs those checks holds only a read token; a separate job, which runs no npm or repository script, verifies that the checked commit changes only release surfaces and fragments and pushes that exact commit with Git hooks disabled. After a release is pushed, a fourth job comments `Released in Desk <version>` on every pull request the release carries and adds a `released` label; Desk's done-gate refuses to close a task on a pull request whose changes [`.desk/delivery.json`](.desk/delivery.json) says are delivered by a release until that label is there. The other plugins still bump their own version in the pull request that changes them, which is how Claude Code receives them, so a merge delivers them and the policy does not gate them.

## Upstream sources

Vendored Superpowers follows its upstream default branch. A weekly [refresh workflow](.github/workflows/superpowers-upstream.yml) runs `node scripts/check-upstream-sources.cjs --update` to refresh `plugins/superpowers/` and `upstream-sources.lock.json`, then releases the change ([#32](https://github.com/ourostack/desk/pull/32)). The lock records which upstream commit each copy came from, as evidence, not a pin ([RFC section 5](plugins/desk/docs/agentic-engineering-v2-rfc.md#5-work-source-and-continuity)). Without `--update`, the script only compares every vendored public source against the lock and reports whether it is current, changed without selected-payload changes, needs human approval, or is blocked.
