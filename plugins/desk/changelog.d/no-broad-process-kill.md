Desk now denies the shell commands that kill the operator's other sessions. On 2026-10-02 an agent ran `pkill -f "cat" -U $(id -u) -n` to stop one hung process. macOS and BSD `pkill` stop reading options at the first non-option argument, so `-U`, the user id and `-n` became extra patterns, and the command killed about 100 processes, among them 8 Claude Code sessions, 2 Copilot sessions and the browser.

A new `PreToolUse` and `preToolUse` hook, [`hooks/process-kill-guard.cjs`](hooks/process-kill-guard.cjs), reads each Bash and PowerShell command with the same shell inspector the protected-checkout guard uses (compound commands, `bash -c`, pipelines and substitutions included) and denies by default: a command that kills processes is denied unless it has one of these safe shapes.

- `kill` with an optional signal and only literal PIDs above 2 or a job spec (`kill -9 123 456`, `kill %1`), or `kill $(cat <file>.pid)`. Any `$` variable in a kill target is denied.
- `pkill`, or `pgrep ... | kill`, with all options before one single-word pattern that is an absolute (or `~/`) path to a specific file, at least 3 segments below a home or temp root and outside app bundles, `~/.local/bin`, `versions` folders and tool-named folders (`pkill -f /Users/me/code/app/server.js`), and `pkill -P <pid>`.
- A port-targeted kill: exactly `lsof -t -i :N` (or `tcp:N`, `udp:N`) with one integer port and no other selector.
- Listing with `pgrep`, `ps` or `lsof` and no kill. A late option still denies `pgrep`, because its output usually feeds a kill.
- `Stop-Process -Id <ints>` (not 0, 1 or 2) and `taskkill /PID <ints> [/F] [/T]` (not 0 or 4).

Everything else that kills is denied: `killall` and `killall5`, `pkill` by user, group, session or terminal or with any other pattern, targets taken from a substitution or pipe, negative or computed process-group ids, a program name from a substitution, `Stop-Process` without `-Id`, `Get-Process` piped to `Stop-Process`, `taskkill` without `/PID`, `wmic ... delete`, CIM `Terminate`, `os.kill(-1)` and `process.kill(-1)` one-liners, and `osascript` quit.

The denial opens with the fix, to stop the process by exact PID (`ps -axo pid,command | grep <specific>`, then `kill <pid>`), then states the rule for any operator (stop only processes you started, by their exact PID, and ask the operator before stopping anything else on their machine) and gives the reason. The guard answers before it loads on any command that does not name a kill program, and it fails open on any error. The [README](README.md) lists it in the guard table.

Known gaps, left for later: `docker kill $(docker ps -q)`, `fuser -k`, `tmux kill-server`, `pm2 kill`, `launchctl kill` and `trap 'kill 0' EXIT`.
