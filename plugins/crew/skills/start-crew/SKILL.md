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

`<Desk plugin folder>` is the folder whose `mcp/scripts/session-boot.js` your `Desk startup:` line runs (the `desk` plugin, two folders above `desk:session-start`'s skill folder). Each command prints one JSON result; tell the person its `message`.

## One shape, two setups

Every Crew workspace has the same shape: the root `AGENTS.md`, `_meta/desks.md` (the roster), `desks/<alias>/` and `desks/_template/`, `_shared/landscape/` for team facts and `_shared/decisions/` for agreed decisions. The setups differ only in where the team's plugin lives:

- **Dual-repo** (preferred for new teams): this repository holds the team's context; a separate tooling repository holds the team plugin. Pass `--tooling-repo <owner/name>`, and once it holds a plugin, `--tooling-path <dir>`, `--tooling-plugin <name>`, `--tooling-ref <branch>` and `--tooling-marketplace <name>`. A tooling repository with no plugin yet is still recorded; `join-crew` points to it and installs nothing.
- **Monorepo**: the plugin lives in this repository's `plugins/<name>/`. Leave out `--tooling-repo`. Every workspace made before `_meta/crew.json` existed is a monorepo and keeps working unchanged.

The workspace records its setup in `_meta/crew.json`; `crew.js status` reports it as `setup`.

## Start

1. Run `status` on the team's local clone. `crew` means it already is a Crew workspace: nothing to set up; teammates join with `crew:join-crew`. `not_crew` means continue.
2. Read the repository's own `README.md` and `AGENTS.md`, and look at its top-level folders.
3. Run `start` without `--apply`. The plan lists every file it adds, says whether it appends a section to `AGENTS.md`, and lists in `outside` the top-level folders that are outside Crew's shape.
4. Add `--founder <alias>=<identity>` only when the first member should join in the same change; otherwise each person joins with `crew:join-crew`.
5. Run again with `--apply`.

Starting deletes, moves and overwrites nothing. Every existing file stays byte-identical, except that the root `AGENTS.md` gains one `## Crew workspace` section at its end (a repository without one gets one). It adds `_meta/crew.json`, `_meta/desks.md`, `desks/_template/`, a README in `_shared/landscape/` and `_shared/decisions/` when those folders are missing, and a front-page `README.md` when there is none. A Crew file that already exists is refused, never overwritten.

`--apply` needs a clean clone on the default branch, in step with origin; the script refuses anything else before writing. The result: `published` means the change is on the default branch, with the pull request it merged in; `pr_open` means it waits in an open pull request (say so, and that it is not in effect yet; the result names the repository's own merge workflow when it found one); `committed` means a local repository with no origin; `failed` names the stage it stopped at and puts the clone back. Do not fall back to editing the files by hand.

## Move placeholder content into the shape

A repository that held team material before Crew (placeholder folders such as `context/`, `guides/` or `team/`) keeps it where it was, and the `## Crew workspace` section lists those folders as "not yet in Crew's shape". Moving it is a migration you do with the team, as its own change after `start`; the script never moves anything, because what is a fact, a decision or one person's view is a judgment.

1. Make an inventory of every file outside the shape, from `git ls-files`.
2. Decide a destination for each file with the team:
   - team-neutral facts, sources, mirrors and guides go to `_shared/landscape/`;
   - only records of what the team actually agreed, with who agreed it and when, go to `_shared/decisions/`; a note or proposal is not a decision;
   - one person's material goes to that person's desk, `desks/<alias>/`, once they have joined;
   - conventions and lessons for every teammate's agents go into the root `AGENTS.md`;
   - the team's plugin goes to the tooling repository (dual-repo) or `plugins/<name>/` (monorepo).
3. Move with `git mv`, so history follows the files. Moves and renames are allowed; deleting is not part of the migration.
4. Account for every file in the change's description: moved (from, to), kept where it is on purpose (and say so in `AGENTS.md`), or listed as undecided for the team. Nothing is silently dropped.
5. Update links that pointed at the old paths, and update the `## Crew workspace` section's "not yet in Crew's shape" line, or remove it when nothing is left outside.
6. Land the change as a shared write: a pull request, with the team's agreement for anything that is not obvious.

## Cross-references

- `crew:shared-desk-conventions`: the layout, both setups and the write protocol.
- `crew:join-crew`: how a teammate joins the workspace this skill sets up, and installs the team's plugin.
