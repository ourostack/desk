The [evaluation packet](docs/evaluation-packet.md) and several skills are corrected for what two cold agent dry runs of the packet found on October 12, 2026.

### The evaluation packet

- **The tidy scenario's block runs.** Desk's card guard refused the block's hand-made task card, so the scenario could not start. The block now commits that card past the desk's commit hook (`git commit --no-verify`), writes a valid card, deletes nothing (it moves the tidy record aside inside the throwaway folder) and stops on a desk with uncommitted changes. The scenario now gives the prompt for the new session and says the findings arrive through the startup tidy check, not through a `desk_doctor` call the evaluator makes.
- **The backup of the real Claude config directory is bounded.** Setup copied the whole directory, which took minutes and gigabytes on a profile in use, and the comparison at the end could not attribute a change. Setup now copies only what `SETUP.md` can change, following symbolic links, and records the Claude Code processes already running. The clean-up block prints the differences with both process lists; every difference is still a finding, recorded with its cause.
- **A signed-in profile is not empty.** Signing in can load the account's connectors and synced plugins. The preflight prompt now asks for the full name of the tool that answered, and a Desk tool from an account connector stops the run.
- **Launcher runs.** The packet says the overlay installs from its `v2-alpha` channel until promotion, names the four things a launcher run must isolate, gives the Agency variable for the launcher's configuration, and says the launcher's shared plugin cache is acceptable.
- **Scenarios 1 to 3 need an interactive session.** A host's non-interactive prompt mode can tell the agent that no user is present, so alignment cannot be exercised that way. [`evaluate-release`](skills/evaluate-release/SKILL.md) no longer offers that mode as a way to drive those scenarios.

### Behavior

- **Leaving.** The foundation now says what to do when the human says they are leaving: open the reply with what you need from them, even if that is nothing. [`interaction-style`](skills/interaction-style/SKILL.md) holds the procedure.
- **A requirement that changes mid-task.** The foundation and [`work-orchestration`](skills/work-orchestration/SKILL.md) now have the agent name, in its first reply after the change, which earlier evidence the change invalidates.
- **Scratch in a child's brief.** A child deletes only paths it created itself, each by the exact path it recorded at creation. A reviewer told to "delete it after" had removed a temporary folder it found by taking the newest match.
- **Friction about the system needs evidence.** [`friction-management`](skills/friction-management/SKILL.md) and [`desk-problem`](skills/desk-problem/SKILL.md) no longer treat a state that someone else produced, and that Desk reported and repaired as designed, as a Desk fault.
- **Question forms.** [`interaction-style`](skills/interaction-style/SKILL.md) names each host's structured-question tool, and [`session-start`](skills/session-start/SKILL.md) says the resume-or-start question is a sentence in the reply.
- **Sign-off lines after an archive.** [`archive-workflow`](skills/archive-workflow/SKILL.md) says the reply that reports a delivery still ends with the three sign-off lines when `task_archive` was the last tool call.

Four foundation sentences were shortened by a few words to make room inside the startup size limit. Three keep their meaning. The coaching sentence no longer ends with "then carry on"; [`interaction-style`](skills/interaction-style/SKILL.md) still says it.
