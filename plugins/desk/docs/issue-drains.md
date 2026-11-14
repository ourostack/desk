# Issue drains

A drain is an agent session that works one repository's issues. Desk owns the part that notices work: a deterministic poll that spends no model turns. It records which issues are new or changed and prints the wakes to deliver. It never delivers one. Whatever runs it (an always-on agent runtime, a launchd job, cron) delivers each wake to the named session. [How to work a drain](../skills/draining-issues/SKILL.md) is the skill; the code is [drains.js](../mcp/src/runtime/drains.js) and its [command line](../mcp/scripts/drains.js).

```sh
node <desk>/plugins/desk/mcp/scripts/drains.js poll      # record changes, print wakes
node <desk>/plugins/desk/mcp/scripts/drains.js ack ...   # report a wake's delivery (each wake carries the exact command)
node <desk>/plugins/desk/mcp/scripts/drains.js status    # one health line per drain, no poll
node <desk>/plugins/desk/mcp/scripts/drains.js why owner/name#123   # why each wake for that issue was made
```

## A runner that needs no checkout

Every `drains.js` command (`poll`, `status`; `ack` skips it) first refreshes `drains/run.mjs` in the state folder below. It is a copy of [drains-launcher.mjs](../mcp/scripts/drains-launcher.mjs), so the file at that stable path always matches the Desk that wrote it, and a new machine gets it from its first `drains.js status`. The command's JSON names the installed path and its SHA-256 under `launcher`. A runner calls `node <state>/ouroboros-skills/desk/drains/run.mjs poll` instead of a path inside a Desk checkout.

Each start, the launcher asks GitHub for the head of `ourostack/desk`'s `release` branch (one `git ls-remote`) and, when it moved, fetches it into its own shallow, sparse clone (`desk-release/` beside `run.mjs`) and runs `plugins/desk/mcp/scripts/drains.js` from there with `DESK_DRAINS_RELEASE` set to the commit. A Desk release therefore reaches the drains within one cycle, with no Agency cache or Desk checkout involved. If GitHub cannot be reached, the clone already there runs and one line goes to stderr and `resolve.log`. With no clone yet, the launcher falls back to the newest `plugins/desk@release` entry in Agency's plugin cache (`~/.local/agency/plugins/cache/cache_index.json`, then `entries/<dir_name>/mcp/scripts/drains.js`), then to the last path that worked (`last-good-script`); with none of them it exits 1. `drains.js` needs `git` on the runner's PATH for the own copy.

## Config and state

Both live in Desk's state folder, `$XDG_STATE_HOME/ouroboros-skills/desk/drains/` (else `~/.local/state/…`), on the machine that runs the poll. The config names real repositories and sessions, so it is never committed. `--config` and `--state` point the command elsewhere.

`config.json`:

```json
{ "drains": [
  { "repo": "owner/name", "session": "<session id>", "account": "<gh login>", "ignoredBodyTrailers": ["Active-at"], "ignoredLabels": ["agent:drain"], "ignoreComments": [{ "author": "some-bot[bot]", "match": "^Routine report" }] }
] }
```

Only `repo` and `session` are required. `session` is opaque to Desk: the runner decides what it means. `account` picks the `gh` login whose token the poll uses; without it the active account is used. An invalid entry fails the command with the reason; it is never dropped, because a dropped drain would stop watching its repository.

`state.json` holds, per repository, the revision last recorded for each issue, the events not yet delivered, and the last poll, wake and error. A first poll on a repository only records what is open. A closed issue's record is kept for 30 days, so one that returns unchanged is not new. A repository dropped from the config loses its state.

## What wakes a drain

An issue is news when something other than the drain changed it since the revision last recorded: a new issue, a title or body edit, a comment, a reopen, or a label change. These are not news:

- a new issue the drain filed or already triaged: a label in its `drain:` namespace, or the `<!-- ouro-drain-status -->` marker in its body, is there before the poll first sees it, so the issue is recorded as seen and only later changes by others count;
- the drain's own status comment, matched by the `<!-- ouro-drain-status -->` marker and the polling account, including its edits. The polling account is whoever the drain's token is (`GET /user` on its own `account`'s token), resolved per repository, so a drain on a work account and one on a personal account each recognise only their own comments;
- labels starting with `drain:`, and any label in the drain's `ignoredLabels`;
- body lines that start with a key in `ignoredBodyTrailers` (`Active-at: …`), so a lane's scheduled beat does not wake the drain;
- comments that fit an `ignoreComments` rule: written by its `author` (case-insensitive) and, when the rule has a `match`, a body that matches the regular expression. A rule without `match` skips every comment by that author; the same bot's other comments still wake the drain;
- a bot's comment that repeats that bot's previous comment on the issue: the two texts are the same once run URLs and IDs, dates, times and durations (`took 14 min`) are replaced, so a daily "checks failed" report or a CI-budget note wakes the drain the first time and when its text changes, not on every repeat. A person's comment, a bot's first comment and a changed text still wake it;
- a reopen that is the drain claiming the issue: the polling account reopens it within a minute of its own `drain:` label change;
- commit references (`referenced` events) and edits to the drain's own marked comment, which the rules above already skip;
- closes and assignments, and cross-references: a cross-reference the drain made itself. When an issue's `updated_at` moved and nothing above was news, the poll reads its timeline, and a `cross-referenced` event after the last marker wakes the drain unless its source is the drain's own work: a body with the `<!-- ouro-drain-status -->` marker, a pull request on a `drain-…` or `drain/…` branch, or the drain's marked comment on that issue that names this one around then. Any other cross-reference is news, and its event says where it came from. A pull request's merge or close is not news: the drain learns a fix landed from its own PR. A closed issue is not polled at all.

## Spending little quota

A poll is cheap on the account's REST quota. Between full syncs it asks GitHub only for what changed: `state=all&sort=updated&since=` the newest change it knew (less two minutes), sent with the `ETag` of the last answer as `If-None-Match`, so an unchanged repository costs one call that GitHub answers with a 304 and does not count against the rate limit. A change that closed an issue is in that list and marks it gone; a reopen is news. Once an hour the whole open list is read again (a full sync), which also catches anything the `since` window missed. The timeline of an issue is read only when its `updated_at` moved with nothing else news. The account's login is asked of GitHub once a day and kept in the state.

Every answer's `x-ratelimit-*` headers are kept per account. When an account has 25 calls or fewer left, its drains are not polled until the window resets; when it is under 200 left (or under a tenth of its limit), they are polled at most every 15 minutes. Drains that share an account share the reading. `status` shows each account's quota first (`quota <account>: 4700/5000 calls left, resets <time> (read 2m ago); the last cycle used 3 calls, 2 of them not modified`) and `held: …` after a drain that is waiting on quota.

## Seeing a gap

`status` (and the `status` lines `poll` prints) start with the Desk in use (`desk <version> (ourostack/desk@release 1a2b3c4d, the launcher's own copy)`; the JSON also has `desk.version` and `desk.release`) and then show, per drain, the last poll that read GitHub without an error and its lag (`last ok poll … (lag 2m)`), the last attempt, and how long the oldest waiting event has waited (`2 waiting (oldest 5h)`). A poll that keeps failing shows a growing lag and its last error; a wake that is made but never delivered shows a growing wait. Each recorded event carries `seenAt`, the time the poll first saw it, and `why`, the one change that made it news (`new issue`, `title or body edited`, `comment <id> by <login>`, `labeled <name>`, `unlabeled <name>`, `reopened`), so a wake nobody expected can be traced to a signal. The wake message names the reason after each issue (`#876 Title (cross-reference from owner/name#9)`), and each drain keeps its last 200 events in its state (with the Desk version, and the release commit for the launcher's own copy, that polled them), so `drains.js why owner/name#123` prints the reasons recorded for that issue (newest first), the marker the poll keeps for it and whether a wake is still waiting.

## Delivering a wake

`poll` prints one JSON value:

```json
{ "at": "…", "status": ["desk <version> (ourostack/desk@release 1a2b3c4d, the launcher's own copy)", "issue drain owner/name -> 58fbd57e: last ok poll 2026-11-13T23:43:29.106Z (lag 2m), polled just now, 7 open, 0 waiting, last wake 12m ago (1 issue)"],
  "errors": [{ "repo": "owner/name", "error": "GitHub answered HTTP 502" }],
  "wakes": [{ "id": "…", "repo": "owner/name", "session": "…", "message": "New or changed issues in owner/name: #12 Title. Drain them.", "events": [], "done": ["node", ".../drains.js", "ack", "--repo", "owner/name", "--wake", "…"] }] }
```

The runner sends each `message` to its `session`, then runs `done`; if the send failed it runs `done` with `--error <text>` added. Events are saved before `poll` prints them, so a wake that is never acknowledged comes back with the next poll, and a crash loses nothing. An acknowledgement for an older batch never clears a newer one. A failed poll (no token, network, GitHub error) wakes no one, moves no marker, and shows in `errors` and `status`.

One poll or ack runs at a time: a second one stops with an error while the first holds `poll.lock`, and takes over a lock whose process has died.

## Moving an Ouroboros drain list

Ouroboros used to poll these drains itself, from `issueDrains` in its `agent.json`. Copy that array into `config.json` as `drains` (the fields are the same) and its `issue-drains.json` state file to `state.json`; the shapes match, so the seen markers carry over and nothing wakes again. Then give Ouroboros the command to run, as Ouroboros's app-sessions documentation describes.
