---
name: start-crew
description: Use when asked to set up or start a crew or team workspace, or when status says the repository is not a Crew workspace yet. Not for joining an existing one (`crew:join-crew`).
---

# Start a Crew workspace

One step, run by the crew script: a plan first, then `--apply`. The script writes, commits and publishes; you choose the inputs. Layout and write rules are in `crew:shared-desk-conventions`.

```bash
node <Desk plugin folder>/mcp/scripts/crew.js status --repo <clone>
node <Desk plugin folder>/mcp/scripts/crew.js start --repo <clone> [options]
```

`<Desk plugin folder>` is the plugin folder your `Desk startup:` line names. Each command prints one JSON result; tell the person its `message`. The script signs in to GitHub itself, as the signed-in gh account that can push to the repository.

## Two setups

Every workspace has one shape (see `crew:shared-desk-conventions`). The setups differ only in where the team's plugin lives:

- **Dual-repo** (preferred for new teams): a separate tooling repository holds the plugin. Pass `--tooling-repo <owner/name>`, and once it holds a plugin, `--tooling-path <dir>`, `--tooling-plugin <name>` and `--tooling-ref <branch>`. Pass `--tooling-marketplace <name>` only when that repository has a `.claude-plugin/marketplace.json`, with the `name` it declares; without one, Claude Code teammates get no install command. A tooling repository with no plugin yet is still recorded.
- **Monorepo**: the plugin lives in `plugins/<name>/` here. Leave out `--tooling-repo`; with several plugins, name the team's with `--tooling-path plugins/<name> --tooling-plugin <name>`.

The tooling repository is made by hand beforehand: someone with the rights creates it (private is fine, readable by the whole team) and adds the plugin (`<dir>/plugin.json` for Copilot through Agency, `<dir>/.claude-plugin/plugin.json` for Claude Code) and, for Claude Code installs, a `.claude-plugin/marketplace.json` at its root. `start` checks all of it before writing and says what is missing.

## What the repository must allow

- **Direct pushes to the default branch by members.** Each member's desk is pushed straight to it on joining, so a rule requiring pull requests there stops every join (`GH006`, "Protected branch update failed"). Keep it open to members, or exempt them.
- **Members merging Crew's pull requests.** The script merges its own `crew/` pull requests at once, by whichever merge method the repository allows. A required review or check leaves each shared write waiting as `pr_open`.

## Start

1. Run `status` on the team's clone. `crew` means there is nothing to set up (teammates use `crew:join-crew`); `not_crew` means continue, with the tooling repository existing first if dual-repo.
2. Read the repository's own `README.md` and `AGENTS.md` and its top-level folders.
3. Run `start` without `--apply`. The plan lists every file it adds, whether it appends to `AGENTS.md`, and, under `outside`, the top-level folders outside Crew's shape.
4. Add `--founder <alias>=<identity>` only when the first member should join in the same change.
5. Run again with `--apply`; it needs a clean clone on the default branch, level with origin.

Starting deletes, moves and overwrites nothing. Existing files stay byte-identical except that the root `AGENTS.md` gains a `## Crew workspace` section at its end. It adds `_meta/crew.json`, `_meta/desks.md`, `desks/_template/`, a README in `_shared/landscape/` and `_shared/decisions/` when missing, and a front-page `README.md` when there is none. An existing Crew file is refused, never overwritten. Don't fall back to writing the files by hand.

Results: `published` (on the default branch; teammates join with `crew:join-crew`; with `confirmed: false`, run `git pull` and `status` yourself once the network is back) · `pr_open` (waiting on the branch's rules; the same `start --apply` later reuses that pull request) · `committed` (no origin: add the team's GitHub repository as origin and run it again) · `refused` (nothing written; fix what the message names, including an origin created with a first commit: recreate it empty) · `failed` (it stopped at `stage` and left the clone as it was; fix the cause yourself, often `account`, and rerun; after a `verify` failure do not rerun, run `status` and report what the workspace holds) · `already_crew` (nothing to do).

## Move placeholder content into the shape

Team material that predates Crew (`context/`, `guides/`, `team/`) stays where it is; the `## Crew workspace` section lists it as "not yet in Crew's shape". Moving it is a separate change you make with the team, because what is a fact, a decision or one person's view is a judgment.

1. If the repository's own `AGENTS.md`, README or contributing guide says not to move or rewrite existing material, get the team's agreement and change that rule in the same change.
2. Inventory the files from `git ls-files` and decide each destination with the team: team-neutral facts and mirrors of outside sources to `_shared/landscape/`; how-tos and conventions to the root `AGENTS.md` (or a document it links to, kept on purpose); only records of what the team agreed, with who and when, to `_shared/decisions/`; one person's material to their desk once they have joined; the team's plugin to the tooling repository or `plugins/<name>/`.
3. Move with `git mv` so history follows. Account for every file in the change's description (moved, kept on purpose, or undecided), update links and the "not yet in Crew's shape" line, and land it as a shared write.
