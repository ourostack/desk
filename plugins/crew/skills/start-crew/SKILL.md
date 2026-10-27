---
name: start-crew
description: Turn a new or existing team repository into a Crew shared workspace, as a dual-repo workspace (team context here, the team plugin in a separate tooling repository; preferred for new teams) or a monorepo (the plugin in this repository's plugins/ folder). Adds Crew's layout without deleting or moving anything, then guides moving placeholder content into it. Use when someone asks to set up, start or create a crew or team workspace, or when crew:join-crew or crew.js status says "This repository is not a Crew workspace yet". Not for joining a workspace that already exists (crew:join-crew).
---

# Start a Crew workspace

One deterministic step, run by the crew script: a plan first, then `--apply`. The script does the writing, the commit and the shared write; you choose the inputs. Read `crew:shared-desk-conventions` first.

```bash
node <Desk plugin folder>/mcp/scripts/crew.js status --repo <clone>
node <Desk plugin folder>/mcp/scripts/crew.js start --repo <clone> [options]
```

`<Desk plugin folder>` is the folder whose `mcp/scripts/session-boot.js` your `Desk startup:` line runs (the `desk` plugin, two folders above `desk:session-start`'s skill folder). Each command prints one JSON result; tell the person its `message`. The script signs in to GitHub itself, as the signed-in gh account that can push to the repository, so there is no account to switch first.

## One shape, two setups

Every Crew workspace has the same shape: the root `AGENTS.md`, `_meta/desks.md` (the roster), `desks/<alias>/` and `desks/_template/`, `_shared/landscape/` for team facts and `_shared/decisions/` for agreed decisions. The setups differ only in where the team's plugin lives:

- **Dual-repo** (preferred for new teams): this repository holds the team's context; a separate tooling repository holds the team plugin. Pass `--tooling-repo <owner/name>`, and once it holds a plugin, `--tooling-path <dir>`, `--tooling-plugin <name>` and `--tooling-ref <branch>`. Pass `--tooling-marketplace <name>` only when the tooling repository has a `.claude-plugin/marketplace.json`, with the `name` it declares; without one, teammates on Claude Code get no install command. A tooling repository with no plugin yet is still recorded; `join-crew` points to it and installs nothing.
- **Monorepo**: the plugin lives in this repository's `plugins/<name>/`. Leave out `--tooling-repo`. When `plugins/` holds more than one plugin, name the team's with `--tooling-path plugins/<name> --tooling-plugin <name>`; the script refuses to guess. Every workspace made before `_meta/crew.json` existed is a monorepo and keeps working unchanged.

The tooling repository and its files are made by hand, before `start`: the script checks them and never creates them. A team member with the rights creates the repository on GitHub (private is fine, with read access for the whole team), adds the plugin (`<dir>/plugin.json` for Copilot through Agency, and `<dir>/.claude-plugin/plugin.json` for Claude Code), and, for Claude Code installs, a `.claude-plugin/marketplace.json` at the repository's root whose `name` is the marketplace and whose `plugins` list the plugin. `start` refuses, before writing anything, when the repository does not exist or cannot be seen, or lacks what the flags declare, and says what to add.

The workspace records its setup in `_meta/crew.json`; `crew.js status` reports it as `setup`.

## What the repository must allow

- **Direct pushes to the default branch by members.** Each member's own desk is pushed straight to the default branch when they join, so branch protection or a ruleset that requires pull requests for the default branch stops every join (GitHub's `GH006` "Protected branch update failed"). Keep the default branch open to pushes from members, or exempt them; Crew's shared files still change only through pull requests.
- **Members merging Crew's pull requests.** The script merges its own `crew/` pull requests at once, with whichever merge method the repository allows (squash first, then a merge commit, then rebase). A required review or required check leaves each shared write waiting as `pr_open` until someone merges it.

## Start

1. Run `status` on the team's local clone. `crew` means it already is a Crew workspace: nothing to set up; teammates join with `crew:join-crew`. `not_crew` means continue. For a dual-repo workspace, make sure the tooling repository exists first (see above).
2. Read the repository's own `README.md` and `AGENTS.md`, and look at its top-level folders.
3. Run `start` without `--apply`. The plan lists every file it adds, says whether it appends a section to `AGENTS.md`, and lists in `outside` the top-level folders that are outside Crew's shape.
4. Add `--founder <alias>=<identity>` only when the first member should join in the same change; otherwise each person joins with `crew:join-crew`.
5. Run again with `--apply`.

Starting deletes, moves and overwrites nothing. Every existing file stays byte-identical, except that the root `AGENTS.md` gains one `## Crew workspace` section at its end (a repository without one gets one). It adds `_meta/crew.json`, `_meta/desks.md`, `desks/_template/`, a README in `_shared/landscape/` and `_shared/decisions/` when those folders are missing, and a front-page `README.md` when there is none. A Crew file that already exists is refused, never overwritten.

`--apply` needs a clean clone on the default branch, in step with origin; the script refuses anything else before writing. It lands the change through a pull request it merges itself, so it does not depend on a team's own merge workflow. What each result means, and what to do next:

- `published`: the change is on the default branch, with the pull request it merged in; the script read the default branch back and found it there. Tell teammates to join with `crew:join-crew`. With `confirmed: false`, GitHub merged it but this clone could not fetch it afterwards (`reason` has Git's words, for you, not the person). Once the network is back, run `git pull` in the clone and `status` yourself, then tell the person in plain words that the workspace is set up, or what `status` shows instead.
- `pr_open`: the change waits in an open pull request and is not in effect yet; `reason` is GitHub's (`BLOCKED`: the branch's rules need a review, a check or someone allowed to merge). Tell the person the message's plain reason. Running the same `start --apply` again later, signed in as the same account, reuses that pull request and tries to merge it again; it never opens a second one. It first rebuilds the pull request from this run's own files and settings, so a rerun with corrected options merges the corrected start and anything pushed onto the branch meanwhile is replaced. Anyone else's `crew/start-` pull request is left alone and never merged.
- `committed`: a local repository with no origin. Add the team's GitHub repository as origin and run `start --apply` again; it pushes the commit.
- `refused`: nothing was written. Fix what the message names (a dirty clone, a file Crew would overwrite, a missing tooling repository) and run it again. A local start whose origin GitHub created with a README or other first commit is refused too: recreate the GitHub repository empty and run `start --apply` again, or clone the GitHub repository and start in that clone.
- `failed`: it stopped at the named `stage`, and the clone is back as it was, including an empty repository whose first push was refused: nothing that looks like a workspace is left behind. Fix the cause (often `account`: sign in to gh as an account that can push) and run it again. `verify` is different: GitHub reported the pull request merged, but the default branch, read back, does not hold what the start wrote (`reason` lists what is missing). Do not run `start` again: run `status` yourself and tell the person in plain words what the workspace holds now; if it says `crew`, the workspace is set up.
- `already_crew`: nothing to do; teammates join with `crew:join-crew`. A clone holding a start that never reached an empty GitHub repository gets a plan or a push instead, and a clone whose first push GitHub took although the answer was lost is brought up to date.

Do not fall back to editing the files by hand.

## Move placeholder content into the shape

A repository that held team material before Crew (placeholder folders such as `context/`, `guides/` or `team/`) keeps it where it was, and the `## Crew workspace` section lists those folders as "not yet in Crew's shape". Moving it is a migration you do with the team, as its own change after `start`; the script never moves anything, because what is a fact, a decision or one person's view is a judgment.

1. Check the repository's own rules first: an `AGENTS.md`, README or contributing guide that says not to move, reformat or rewrite existing material forbids this migration until the team agrees to it. Get that agreement, and change the rule in the same change as the moves, so the files never say both "do not move this" and "this was moved".
2. Make an inventory of every file outside the shape, from `git ls-files`.
3. Decide a destination for each file with the team:
   - team-neutral facts, sources and mirrors of outside material go to `_shared/landscape/`;
   - how-tos and guides for the team (how to contribute, how a process works) are conventions, not facts: they go into the root `AGENTS.md`, or, when long, stay a document the root `AGENTS.md` links to, kept where it is on purpose;
   - only records of what the team actually agreed, with who agreed it and when, go to `_shared/decisions/`; a note or proposal is not a decision;
   - one person's material goes to that person's desk, `desks/<alias>/`, once they have joined;
   - conventions and lessons for every teammate's agents go into the root `AGENTS.md`;
   - the team's plugin goes to the tooling repository (dual-repo) or `plugins/<name>/` (monorepo).
4. Move with `git mv`, so history follows the files. Moves and renames are allowed; deleting is not part of the migration.
5. Account for every file in the change's description: moved (from, to), kept where it is on purpose (and say so in `AGENTS.md`), or listed as undecided for the team. Nothing is silently dropped.
6. Update links that pointed at the old paths, and update the `## Crew workspace` section's "not yet in Crew's shape" line, or remove it when nothing is left outside.
7. Land the change as a shared write: a pull request, with the team's agreement for anything that is not obvious.

## Cross-references

- `crew:shared-desk-conventions`: the layout, both setups and the write protocol.
- `crew:join-crew`: how a teammate joins the workspace this skill sets up, and installs the team's plugin.
