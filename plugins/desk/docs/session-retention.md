# Session retention

Agent sessions leave a lot behind: screen recordings, traces, screenshots, browser profiles, `node_modules`, clones and worktrees. Nothing removes them, so on a busy machine agent storage grows until the disk is full. Session retention keeps it bounded. It is opt-in: Desk never runs it by itself. You schedule the [CLI](../mcp/scripts/session-retention.js) once a day; the logic is in [session-retention.js](../mcp/src/runtime/session-retention.js).

It complements [workspace tidy](workspace-tidy.md), which closes out worktrees that task cards own. Retention knows nothing about task cards: it works from the GitHub Copilot app's session records and from Git's own state, and it has a storage ceiling.

It is a dry run unless you pass `--apply`. Try it first:

```sh
node <desk>/plugins/desk/mcp/scripts/session-retention.js --verbose
```

The dry run prints what it would remove and what it left in place, and writes the full list to a JSON report.

## Which sessions are active

Retention reads the Copilot app database (`<COPILOT_HOME>/data.db`, read only). A session is active when any of these is true:

- its workspace is not archived (a workspace session's archive state is on the workspace, through `workspaces` or `workspace_session_aliases`);
- it has no workspace and is not archived;
- the app marks it running;
- its session folder holds an `inuse.<pid>.lock` whose process is alive;
- a file at the top of its session folder was written in the last 24 hours (`--recent-hours`).

If the database is missing or cannot be read, retention does not guess: it leaves every session and worktree alone and prunes only old logs. The report says why.

## What it removes and what it keeps

| Where | Removed | Kept |
|---|---|---|
| Active session | Build folders (`node_modules`, `dist`, `target`, `.vite`, `.next`, `.turbo`, `.parcel-cache`, `.svelte-kit`, `DerivedData`, `.build`) older than 3 days | Everything else, including screenshots and other proof |
| Inactive session | Videos; traces (`.trace`, `.cpuprofile`, `.heapsnapshot`, `.heapprofile`, `.har`, trace `.zip` files, trace or profile JSON over 10 MB); screenshots older than 3 days, unless the session's workspace has an open pull request; browser profiles; build folders; clones and worktrees that are safe to remove | `events.jsonl`, `checkpoints/`, `workspace.yaml`, `session.db`, `plan.md`, `research/`, and small text files |
| Worktrees under the code roots | Linked worktrees that are safe to remove, once no active session uses them; old build folders in the ones that stay | Worktrees of active sessions, the app's `copilot-prewarm-*` pool, standalone clones, and anything unsafe |
| Log folders | Files older than 7 days (`--log-days`) | Newer logs |
| State roots (opt-in) | `node_modules` and browser profiles older than 3 days, unless the browser is running (`SingletonLock`) | Everything else |

Inside a Git checkout, a build folder other than `node_modules` goes only when `git check-ignore` says it is ignored, because a tracked `dist/` is source. `--artifact-days` changes the 3-day age.

The code roots default to the folders that hold the worktrees the app database knows about, never the home folder itself. Pass `--code-roots` to choose them; folder lists are separated by `:` (`;` on Windows). Worktrees are looked for up to 3 levels below each root (`--worktree-depth`).

## Never removing work

A clone or worktree is safe to remove only when all of these hold. Otherwise it stays, and the report lists it with the reason (`--verbose` prints them):

- `git status` is clean, counting untracked files;
- no merge, rebase, cherry-pick, revert or bisect is in progress;
- the worktree is not locked;
- it has a remote;
- every tip is on a remote: `HEAD`, and for a standalone clone every local branch, with no stash entries. A tip counts when a remote-tracking branch contains it or when a remote advertises its exact commit (`git ls-remote`), which covers a squash-merged pull request's head.

A removed worktree is followed by `git worktree prune` in its repository.

## The storage ceiling

With `--ceiling`, retention measures agent storage after the main pass: the session folders, the log folders and the linked worktrees under the code roots, each with `du -sk`. If that is over `--ceiling-gb` (60 by default), it prunes inactive sessions, archived ones first and then oldest first, until storage is under the ceiling. It removes only what the history needs least: every file that is not small text, never the files listed as kept above, and never anything inside a checkout the main pass did not verify as safe. Where `du` is not available (Windows), the report says the ceiling was not checked.

## Gentle on a busy machine

A full walk of a busy machine's agent storage can saturate the disk for hours, so retention:

- reads directory entries and stats only removal candidates, and never walks inside a build folder it is removing;
- measures what it freed from free-space readings, not per-file sizes (`--sizes` measures each listed folder with `du`, which is slower);
- moves each folder into a trash folder first, then deletes it in pieces at no more than 3 GB a minute (`--gb-per-min`); the trash (`--trash`) must be on the same volume, and a folder on another volume is deleted in place;
- slows down, without stopping, while the load average is above 12 (`--load-limit`), and pauses a second before each worktree's Git checks (`--git-pause-ms`);
- restores owner write permission and retries once when a folder is read-only, and reports anything it still cannot delete once.

Run it at the lowest priority: `nice -n 19`, plus `taskpolicy -d utility` on macOS for low disk priority.

## Schedule it

Run it daily, off hours. The report goes to `<XDG_STATE_HOME or ~/.local/state>/desk/session-retention/<date>-<mode>.json` (`--report-dir`). Point the schedule at the installed Desk plugin's `mcp/scripts/session-retention.js` and a Node 20 or later.

On macOS, a launchd agent at 03:00, saved as `~/Library/LaunchAgents/dev.desk.session-retention.plist` and loaded with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.desk.session-retention.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.desk.session-retention</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/sbin/taskpolicy</string><string>-d</string><string>utility</string>
    <string>/path/to/node</string>
    <string>/path/to/desk/plugins/desk/mcp/scripts/session-retention.js</string>
    <string>--apply</string><string>--ceiling</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>19</integer>
  <key>StandardOutPath</key><string>/path/to/logs/desk-session-retention.log</string>
  <key>StandardErrorPath</key><string>/path/to/logs/desk-session-retention.log</string>
</dict>
</plist>
```

On Linux, a systemd user timer: `~/.config/systemd/user/desk-session-retention.service`

```ini
[Unit]
Description=Keep agent session storage bounded

[Service]
Type=oneshot
Nice=19
IOSchedulingClass=idle
ExecStart=/path/to/node /path/to/desk/plugins/desk/mcp/scripts/session-retention.js --apply --ceiling
```

and `~/.config/systemd/user/desk-session-retention.timer`, enabled with `systemctl --user enable --now desk-session-retention.timer`:

```ini
[Unit]
Description=Daily agent session retention

[Timer]
OnCalendar=*-*-* 03:00
Persistent=true

[Install]
WantedBy=timers.target
```

Run `node session-retention.js --help` for every option.
