<!-- ourostack:brand:start -->
<p align="center">
  <a href="https://github.com/ourostack"><img src="https://raw.githubusercontent.com/ourostack/.github/main/brand/headers/desk.webp" alt="Ouro curled beside a tidy wooden desk with papers, a card tray and a lamp, on a dawn meadow, with teammates' desks on the hills behind" width="100%"></a>
</p>
<!-- ourostack:brand:end -->

# Desk

Your coding agent keeps its tracks, tasks and lessons in a Git repository you own, your desk, so tomorrow's session picks up where today's stopped, on any machine, in Claude Code or Copilot CLI. An MCP server lets the agent read, search and update the desk, and skills keep each task's state current as the work moves.

[ouroboros.bot/desk](https://ouroboros.bot/desk/) · [The factory](https://ourostack.github.io/factory/) · [More from Ouro](https://github.com/ourostack)

**To set up, give your agent the link to [SETUP.md](SETUP.md) and say "set this up".**

This repository is the home of **[Agentic Engineering V2](AGENTIC-ENGINEERING-V2.md)**. Its `main` branch is the release channel, and installed copies update from it.

**Or install it yourself.** Claude Code:

```sh
claude plugin marketplace add ourostack/desk && claude plugin install desk@ourostack
```

Copilot CLI, through the Agency launcher (then start Copilot with `agency copilot`):

```sh
agency plugin install github:ourostack/desk:plugins/desk@main --engine copilot
```

Desk brings Superpowers and Plain Language with it.

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
plugins/desk/                     # Desk plugin, MCP server, activation and browser
plugins/superpowers/              # Vendored Superpowers and its upstream lock
plugins/plain-language/           # Plain Language plugin
plugins/crew/                     # Crew plugin
tests/desk/                       # Desk tests, kept out of the installed plugin
evals/                            # Offline evaluation contracts
scripts/                          # Validation and release checks run in CI
tools/unused-code/                # knip config for the Unused code check
```

## Unused code

All code has a purpose, so CI fails a pull request that leaves unused code behind. Run `cd tools/unused-code && npm ci && npm run knip` to find unused files, exports, dependencies and duplicate exports before you push; [`tools/unused-code/knip.jsonc`](tools/unused-code/knip.jsonc) lists the entry points and gives the reason for every exception, and the CI job is named "Unused code".

## Releasing

Hosts pick up changes differently: Agency re-resolves the branch, while Claude Code updates only when a plugin's version string changes. Every change to a plugin's files therefore ships as a new version, named the same in every manifest and in the marketplace entry. CI enforces this with `node scripts/check-release-integrity.cjs`, and `node scripts/check-dependency-channels.cjs` keeps plugin dependencies on the `main` channel instead of exact commits.

Desk releases from `main`. A pull request that changes Desk adds a changelog fragment under [`plugins/desk/changelog.d/`](plugins/desk/changelog.d/README.md) and does not touch Desk's version or the head of its changelog, so parallel pull requests do not conflict. After the merge, the [Desk release workflow](.github/workflows/desk-release.yml) takes the next version on every release surface, folds the fragments into `plugins/desk/CHANGELOG.md` and commits the release to `main`. It checks that release commit before pushing it (release integrity, skill, docs, host-manifest, generated-artifact and contract validation, and the release, activation, artifact, docs and script tests), because a push made with the workflow token starts no CI. The job that installs dependencies and runs those checks holds only a read token; a separate job, which runs no npm or repository script, verifies that the checked commit changes only release surfaces and fragments and pushes that exact commit with Git hooks disabled. After a release is pushed, a fourth job comments `Released in Desk <version>` on every pull request the release carries and adds a `released` label; Desk's done-gate refuses to close a task on a pull request whose changes [`.desk/delivery.json`](.desk/delivery.json) says are delivered by a release until that label is there. The other plugins still bump their own version in the pull request that changes them, which is how Claude Code receives them, so a merge delivers them and the policy does not gate them.

## Upstream sources

Vendored Superpowers follows its upstream default branch. The [refresh workflow](.github/workflows/superpowers-upstream.yml) runs `node scripts/refresh-superpowers.cjs` to copy the selected upstream files byte for byte into `plugins/superpowers/`, update `upstream-sources.lock.json` and release a new Superpowers version, then [`scripts/superpowers-upstream-pr.cjs`](scripts/superpowers-upstream-pr.cjs) opens the `superpowers-upstream` pull request with upstream's release notes, runs CI on it, merges it when every check passes and dispatches the Desk release. When upstream crosses a major version, the refresh moves Desk's Superpowers compatibility floor with it, labels the pull request `superpowers-major` and files a `superpowers-major` issue to adopt what is new. A run is green only when the refresh reached `main` and the release was dispatched, or upstream had nothing new; anything else fails the run and files or updates one `upstream-refresh` issue that quotes each failed job's errors. Monday's run always reruns CI; the daily runs on other days rerun it only when upstream moved past the open refresh, and otherwise fail at once while that refresh is still not on `main`. The lock records which upstream commit each copy came from, as evidence, not a pin ([RFC section 5](plugins/desk/docs/agentic-engineering-v2-rfc.md#5-work-source-and-continuity)). `node scripts/check-upstream-sources.cjs` compares every vendored public source against the lock and reports whether it is current, changed without selected-payload changes, needs human approval, or is blocked.
