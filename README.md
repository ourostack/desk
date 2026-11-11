<!-- ourostack:brand:start -->
<p align="center">
  <a href="https://github.com/ourostack"><img src="https://raw.githubusercontent.com/ourostack/.github/main/brand/headers/desk.webp" alt="Ouro curled beside a tidy wooden desk with papers, a card tray and a lamp, on a dawn meadow, with teammates' desks on the hills behind" width="100%"></a>
</p>
<!-- ourostack:brand:end -->

# Desk

**Your coding agent's work survives the session.**

- Tracks, tasks and lessons live in a Git repository you own, your desk, so tomorrow's session picks up where today's stopped, on any machine.
- Works in Claude Code and GitHub Copilot CLI. An MCP server lets the agent read, search and update the desk.

[ouroboros.bot/desk](https://ouroboros.bot/desk/) · [The factory](https://ourostack.github.io/factory/) · [More from Ouro](https://github.com/ourostack)

**Status:** alpha. `main` is the release channel, and installed copies update from it.

**To set up, give your agent the link to [SETUP.md](SETUP.md) and say "set this up".**

**Or install it yourself.** Claude Code:

```sh
claude plugin marketplace add ourostack/desk && claude plugin install desk@ourostack
```

Copilot CLI, through [Agency](https://aka.ms/agency) (Microsoft-internal; then start Copilot with `agency copilot`):

```sh
agency plugin install github:ourostack/desk:plugins/desk@main --engine copilot --cache-policy auto --cache-ttl 0
```

Desk brings Superpowers (an engineering method) and Plain Language (a prose policy) with it.

A desk looks like this:

```text
my-desk/
  ouro-ui/                 # a track: one area of work
    track.md
    menu-fix/              # a task: one outcome
      task.md              # state, next step, links to evidence
      evidence/
  _meta/friction.md        # what got in the way, so it gets fixed
```

Desk is the product; **[Agentic Engineering V2](AGENTIC-ENGINEERING-V2.md)** is the way of working it carries, and this repository is its home.

## Plugins

The `ourostack` marketplace in this repository ships four plugins:

- **[Desk](plugins/desk/README.md)** (`desk@ourostack`): durable desk state, authority and approved delivery boundaries, with the `desk:worker` agent and the Desk MCP server.
- **Superpowers** (`superpowers@ourostack`): the engineering method, vendored from upstream. Installing Desk pulls it in.
- **Plain Language** (`plain-language@ourostack`): the prose policy for human-readable agent output. Installing Desk pulls it in.
- **[Crew](plugins/crew/README.md)** (`crew@ourostack`): the multi-person shared-workspace layer on top of Desk.

Agency and other hosts that resolve plugins from Git use these coordinates:

```text
github:ourostack/desk:plugins/<name>@main
```

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

## Publish workspace saves through pull requests

A workspace can require Desk save/sync to publish through a branch, a pull request, and CI instead of pushing its upstream branch. Add this policy at the repository root through the repository's normal contribution path:

```json
{
  "schema_version": 1,
  "mode": "pull-request",
  "required_checks": ["your-workspace-policy-check"]
}
```

Save it as `.desk/publication.json`, using the actual check names that must succeed on every publication. They are a floor, not the whole gate. The policy must reach the upstream before it takes effect. Desk reads that fetched version, not an outgoing edit or a dirty working copy, even when your desk is a repository subdirectory.

With the policy enabled, Desk pushes the exact captured or replayed commit only to `desk/publish/<commit>`, creates or reuses its PR, and waits up to five minutes for all named checks, every check the base branch's GitHub rules or protection require, and every other check reported on that commit. All must finish passing; a pending or failing check the policy does not name still blocks the merge. If GitHub's branch rules or protection can't be read, the publication fails with that reason rather than merging, because an administrator's API merge would otherwise bypass them. Desk can wait only for a check it knows about. A check that the branch rules don't require and that hasn't reported yet, such as a commit status a person or a script posts after the push, is invisible until it first reports, so name every such check in `required_checks`. It reads every page of the candidate's GitHub status contexts and check runs, tracking context names and immutable run IDs rather than mutable results URLs. Missing checks never count as green, including a previously observed check that disappears from GitHub's response. Only a successful exact-head GitHub PR merge, fetched and verified against the actual upstream, counts as delivered. A changed, closed, or draft PR is not merged. The GitHub CLI must already have access to the upstream repository; non-GitHub publication needs a provider integration and fails rather than falling back to a direct push.

If publication is blocked, the save stays local or on its contribution branch, not merged into the shared upstream. `desk_status` and the next save note expose the PR receipt, cause, and exact retry command. Fix the named check or prerequisite before retrying. The retry CLI exits nonzero and explains a blocked publication; a busy worker or intentionally skipped run remains a successful no-op. Recovery commands use PowerShell syntax on Windows and POSIX-shell syntax elsewhere, preserving literal path characters. This is a contract of the updated Desk worker, not a substitute for server-side branch protection: older workers, other clients, and API writers require separate enforcement and adoption.

## Releasing

<details>
<summary>For maintainers: how releasing works</summary>

Hosts pick up changes differently: Agency re-resolves the branch, while Claude Code updates only when a plugin's version string changes. Every change to a plugin's files therefore ships as a new version, named the same in every manifest and in the marketplace entry. CI enforces this with `node scripts/check-release-integrity.cjs`, and `node scripts/check-dependency-channels.cjs` keeps plugin dependencies on the `main` channel instead of exact commits.

Desk releases from `main`. A pull request that changes Desk adds a changelog fragment under [`plugins/desk/changelog.d/`](plugins/desk/changelog.d/README.md) and does not touch Desk's version or the head of its changelog, so parallel pull requests do not conflict. After the merge, the [Desk release workflow](.github/workflows/desk-release.yml) takes the next version on every release surface, folds the fragments into `plugins/desk/CHANGELOG.md` and commits the release to `main`. It checks that release commit before pushing it (release integrity, skill, docs, host-manifest, generated-artifact and contract validation, and the release, activation, artifact, docs and script tests), because a push made with the workflow token starts no CI. The job that installs dependencies and runs those checks holds only a read token; a separate job, which runs no npm or repository script, verifies that the checked commit changes only release surfaces and fragments and pushes that exact commit with Git hooks disabled. After a release is pushed, a fourth job comments `Released in Desk <version>` on every pull request the release carries and adds a `released` label; Desk's done-gate refuses to close a task on a pull request whose changes [`.desk/delivery.json`](.desk/delivery.json) says are delivered by a release until that label is there. The other plugins still bump their own version in the pull request that changes them, which is how Claude Code receives them, so a merge delivers them and the policy does not gate them.

</details>

## Upstream sources

<details>
<summary>For maintainers: how upstream sources works</summary>

Vendored Superpowers follows its upstream default branch. The [refresh workflow](.github/workflows/superpowers-upstream.yml) runs `node scripts/refresh-superpowers.cjs` to copy the selected upstream files byte for byte into `plugins/superpowers/`, update `upstream-sources.lock.json` and release a new Superpowers version, then [`scripts/superpowers-upstream-pr.cjs`](scripts/superpowers-upstream-pr.cjs) opens the `superpowers-upstream` pull request with upstream's release notes, runs CI on it, merges it when every check passes and dispatches the Desk release. When upstream crosses a major version, the refresh moves Desk's Superpowers compatibility floor with it, labels the pull request `superpowers-major` and files a `superpowers-major` issue to adopt what is new. A run is green only when the refresh reached `main` and the release was dispatched, or upstream had nothing new; anything else fails the run and files or updates one `upstream-refresh` issue that quotes each failed job's errors. Monday's run always reruns CI; the daily runs on other days rerun it only when upstream moved past the open refresh, and otherwise fail at once while that refresh is still not on `main`. The lock records which upstream commit each copy came from, as evidence, not a pin ([RFC section 5](plugins/desk/docs/agentic-engineering-v2-rfc.md#5-work-source-and-continuity)). `node scripts/check-upstream-sources.cjs` compares every vendored public source against the lock and reports whether it is current, changed without selected-payload changes, needs human approval, or is blocked.

</details>
