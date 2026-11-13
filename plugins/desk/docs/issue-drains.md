# Issue drains

A drain is an agent session that works one repository's issues. Desk owns the part that notices work: a deterministic poll that spends no model turns. It records which issues are new or changed and prints the wakes to deliver. It never delivers one. Whatever runs it (an always-on agent runtime, a launchd job, cron) delivers each wake to the named session. [How to work a drain](../skills/draining-issues/SKILL.md) is the skill; the code is [drains.js](../mcp/src/runtime/drains.js) and its [command line](../mcp/scripts/drains.js).

```sh
node <desk>/plugins/desk/mcp/scripts/drains.js poll      # record changes, print wakes
node <desk>/plugins/desk/mcp/scripts/drains.js ack ...   # report a wake's delivery (each wake carries the exact command)
node <desk>/plugins/desk/mcp/scripts/drains.js status    # one health line per drain, no poll
```

## A runner that needs no checkout

Every `drains.js` command (`poll`, `status`; `ack` skips it) first refreshes `drains/run.mjs` in the state folder below. It is a copy of [drains-launcher.mjs](../mcp/scripts/drains-launcher.mjs), so the file at that stable path always matches the Desk that wrote it, and a new machine gets it from its first `drains.js status`. The command's JSON names the installed path and its SHA-256 under `launcher`. A runner calls `node <state>/ouroboros-skills/desk/drains/run.mjs poll` instead of a path inside a Desk checkout.

The launcher finds the newest `ourostack/desk` `plugins/desk@release` entry in Agency's plugin cache (`~/.local/agency/plugins/cache/cache_index.json`, then `entries/<dir_name>/mcp/scripts/drains.js`) and runs it with the same arguments. If that cannot be resolved, it runs the last path that worked (`last-good-script`) and logs one line to stderr and `resolve.log`; with no last good path it exits 1.

## Config and state

Both live in Desk's state folder, `$XDG_STATE_HOME/ouroboros-skills/desk/drains/` (else `~/.local/state/…`), on the machine that runs the poll. The config names real repositories and sessions, so it is never committed. `--config` and `--state` point the command elsewhere.

`config.json`:

```json
{ "drains": [
  { "repo": "owner/name", "session": "<session id>", "account": "<gh login>", "ignoredBodyTrailers": ["Active-at"], "ignoredLabels": ["agent:drain"] }
] }
```

Only `repo` and `session` are required. `session` is opaque to Desk: the runner decides what it means. `account` picks the `gh` login whose token the poll uses; without it the active account is used. An invalid entry fails the command with the reason; it is never dropped, because a dropped drain would stop watching its repository.

`state.json` holds, per repository, the revision last recorded for each issue, the events not yet delivered, and the last poll, wake and error. A first poll on a repository only records what is open. A closed issue's record is kept for 30 days, so one that returns unchanged is not new. A repository dropped from the config loses its state.

## What wakes a drain

An issue is news when something other than the drain changed it since the revision last recorded: a new issue, a title or body edit, a comment, a reopen, or a label change. These are not news:

- the drain's own status comment, matched by the `<!-- ouro-drain-status -->` marker and the polling account, including its edits;
- labels starting with `drain:`, and any label in the drain's `ignoredLabels`;
- body lines that start with a key in `ignoredBodyTrailers` (`Active-at: …`), so a lane's scheduled beat does not wake the drain;
- closes and assignments.

## Delivering a wake

`poll` prints one JSON value:

```json
{ "at": "…", "status": ["issue drain owner/name -> 58fbd57e: polled just now, 7 open, 0 waiting, last wake 12m ago (1 issue)"],
  "errors": [{ "repo": "owner/name", "error": "GitHub answered HTTP 502" }],
  "wakes": [{ "id": "…", "repo": "owner/name", "session": "…", "message": "New or changed issues in owner/name: #12 Title. Drain them.", "events": [], "done": ["node", ".../drains.js", "ack", "--repo", "owner/name", "--wake", "…"] }] }
```

The runner sends each `message` to its `session`, then runs `done`; if the send failed it runs `done` with `--error <text>` added. Events are saved before `poll` prints them, so a wake that is never acknowledged comes back with the next poll, and a crash loses nothing. An acknowledgement for an older batch never clears a newer one. A failed poll (no token, network, GitHub error) wakes no one, moves no marker, and shows in `errors` and `status`.

One poll or ack runs at a time: a second one stops with an error while the first holds `poll.lock`, and takes over a lock whose process has died.

## Moving an Ouroboros drain list

Ouroboros used to poll these drains itself, from `issueDrains` in its `agent.json`. Copy that array into `config.json` as `drains` (the fields are the same) and its `issue-drains.json` state file to `state.json`; the shapes match, so the seen markers carry over and nothing wakes again. Then give Ouroboros the command to run, as Ouroboros's app-sessions documentation describes.
