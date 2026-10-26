---
name: repo-handling
description: Find or set up local clones of a task's repos across machines with different folder layouts, and the rules for reading other people's repos. Use when a task needs a repo locally.
---

# Repo handling

> Boot first: if the Desk boot has not run in this session, run the absolute command on the `Desk startup:` line in your context (without it, `node <this skill's base directory>/../../mcp/scripts/session-boot.js`; add `--task "<name>"` when the operator named a task). If it ran with no task named and a task was picked since, run it again with `--task "<handle>" --task-only`: that prints the task's push route and repos. A child agent with a bounded brief follows its brief and skips this.

Machines lay code out differently (`~/code/` on a Mac, `Q:\src\` on Windows, `/repos/` on a Linux box), and a task card written on one must still resume on another. Use this skill when a card's `local_path` is empty or does not resolve here, when the operator asks where a repo is, or on a fresh machine. Overlays may ship a richer discovery skill (another tracker, cross-org routing); this one stays generic.

## Other people's repositories and clones

A clone you only read, or a repository someone else owns, is not yours to rearrange:

- **Find existing clones by remote URL** (`git config remote.origin.url`), not by directory name, before reaching for a remote reader and before any clone. Operators often keep several clones of one repository under different names.
- **Reading is read-only.** A clone the task does not own is never mutated: no fetch, pull, checkout, switch, stash, reset or branch. Read it with `git show` on refs it already has, through the hosting service's source API, or from your own clone or worktree. The single exception: the operator's explicit instruction to update that specific clone authorizes that update, because authority follows the verb (`using-desk` "Authority"). Its HEAD is someone's working context, often mid-task; `git-hygiene` states the same rule.
- **Changes go through the established contribution path** (a branch or fork and a pull request), never by editing someone else's checkout in place.
- **A repo with no local clone (`mode: remote`, or no `local_path`) stays uncloned unless the next step needs its code.** Read it through the hosting service until then. When the code is needed, clone into the code location (`defaults.clone_root` in `.machine-local.yml`, default `~/code/`), never `/tmp` or another shared temp folder, and record the clone on the card through `task_update` (`local_path`, `mode: local`). The authorization rule just below still applies to a repo the task does not own.
- **Never create, move or delete a clone without explicit authorization.** If the source is not cloned anywhere, ask first and propose a scratch location outside the operator's project folders.
- When the operator explains how their machine is laid out, record it (`.machine-local.yml` below, or their rules in the desk) so the next session inherits it.

The resolution flow below applies to the task's own repositories; its clone step still needs the operator's choice ("When nothing resolves").

## Resolution order

For each repo entry, stop at the first that resolves to a Git repository whose origin matches the expected repository (`git -C <path> remote get-url origin`; a path that holds a different repository is a miss):

1. **`$DESK/.machine-local.yml`**, the per-machine override.
2. **The card's `local_path`**, with `~` expanded.
3. **Auto-discovery:** `$PWD/<repo>`, then `$PWD/../<repo>` and `$PWD/../../<repo>` (a sibling of the repo you started in), then `~/code`, `~/repos`, `~/src`, `~/dev` and `~` itself.
4. **Ask the operator** (below).

When step 2 or 3 finds a path other than the card's, propose recording it in `.machine-local.yml` so the next session here skips discovery.

## Machine-local override

`$DESK/.machine-local.yml` is ignored by Git (add it to `$DESK/.gitignore` if missing) because each machine keeps its own. It is opt-in: create it when the operator hits a path that differs between machines.

```yaml
repos:
  OrderService: /Users/<alias>/work/OrderService
  OrderUI: ~/dev/OrderUI
  OrderAdminPortal-Fork: ~/projects/OrderAdminPortal-Fork  # alias for OrderAdminPortal repo
defaults:
  clone_root: ~/code   # where new clones go on this machine (default: ~/code)
```

**A committed `local_path` is always in tilde form.** An absolute path on a card (`C:\src\...`, `/Users/<alias>/...`) is a bug that breaks every other machine. Move it to this machine's `.machine-local.yml` and set the card back to `~/code/<repo-name>` with `task_update` (the whole corrected `repos` list in `frontmatter`, plus a `note`); `task_update` commits the card, and the desk's pre-commit hook refuses a hand commit of one. Say in one line that you did it. When discovery finds an operator-specific path, record it in `.machine-local.yml` rather than on the card; when it finds a portable one, record it on the card with `mode: local`.

## When nothing resolves

Ask in one sentence whether the operator has it cloned somewhere (give the path) or wants you to clone it. A path they give is checked for the expected origin, recorded on the card with `mode: local`, and offered for `.machine-local.yml` when it is not in `~/code/`. To clone, take the URL from the card's `url` (boot's missing-clone instruction gives the exact `git clone <url> <path>`), the hosting service or the operator, and save an operator-supplied URL on the card. Clone into `defaults.clone_root` (default `~/code/`), record the path through `task_update`, and warn that a large repository takes a while.

For a repository tens of gigabytes in size, warn before cloning and consider working remotely; record known large repositories in `$DESK/_meta/large-repos.md` (repo, approximate size, recommendation) so the next session warns without measuring again.

## Open pull requests across `repos[]`

Look up open PRs in every repo a task lists, not just the one whose PR is already known (for GitHub, `gh pr list --repo <org>/<repo> --author @me --state open --json number,title,url,isDraft`); session start does this for active tasks. Keep the list for the session; write a PR onto the card only when it is confirmed as the task's PR.

## Repo knowledge

When an active task lists a repo, read every `.md` file in `<plugin>/repo-knowledge/<repo-name>/` if that folder exists (for example `code-standards.md`, `pipeline-notes.md`), and say nothing when it does not. Folders are keyed by repo name; on the first real collision across organizations, prefix the organization (`acme-OrderService`). Put only what is specific to that repo and would otherwise be re-learned each session (build gotchas, pipeline IDs, review rules), written without host-specific tool names; cross-cutting rules belong in a skill.

## Before implementation

Bring the task's own checkout up to date and check for uncommitted changes through `git-hygiene` ("Code repos") before the first edit; never overwrite uncommitted work silently.
