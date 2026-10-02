Desk now denies the shell commands that kill the operator's other sessions. On 2026-10-02 an agent ran `pkill -f "cat" -U $(id -u) -n` to stop one hung process. macOS and BSD `pkill` stop reading options at the first non-option argument, so `-U`, the user id and `-n` became extra patterns, and the command killed about 100 processes, among them 8 Claude Code sessions, 2 Copilot sessions and the browser.

A new `PreToolUse` and `preToolUse` hook, [`hooks/process-kill-guard.cjs`](hooks/process-kill-guard.cjs), reads each Bash and PowerShell command with the same shell inspector the protected-checkout guard uses (compound commands, `bash -c`, pipelines and substitutions included) and denies four shapes:

- `pkill`, `pgrep` or `killall` with an option after the first non-option argument.
- `pkill` (or a `pgrep` that feeds a `kill`) with a pattern under 8 characters or a single common word such as `cat`, `node`, `git`, `claude` or `bash`, and `killall` of any common name.
- `kill -9 -1`, `kill 0` and other `kill` of a process group, including `kill $(pgrep ...)` and `pgrep ... | xargs kill` when the pgrep would itself be denied.
- On Windows, `Stop-Process -Name` and `taskkill /IM` with a common or wildcard name, and `Get-Process <wildcard> | Stop-Process`.

The denial opens with the fix, to stop the process by exact PID (`ps -axo pid,command | grep <specific>`, then `kill <pid>`), and gives the reason in one more sentence. `kill <pid list>`, `kill -TERM <pid>`, `pkill -f` with a long specific pattern and options first, and `pgrep -f <specific>` alone still pass. The guard answers before it loads on any command that does not name a kill program, and it fails open on any error. The [README](README.md) lists it in the guard table.
