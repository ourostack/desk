Desk no longer watches the harness or the shell. It acts only at its own boundaries: its MCP tools, the desk repository it owns, and its own session start and end. The harness provides and supervises its tools, and Desk neither intercepts them nor substitutes for them.

### Deleted, with their tests, docs, skill text, registrations and the code left without purpose

- The protected-checkout guard and the `desk.protected` marker.
- The process-kill guard, the credential-probe guard, the task-status guard (the card pre-commit Git hook stays), and the elsewhere-clone check.
- Host enforcement on every host, including the Codex adapter block. The Codex adapter no longer pins `memories = false` or registers a `PreToolUse` hook. Re-activation replaces an older generated block that did either.
- The brief task-line hook, entirely: its deny, its rewrite, its record mode and its brief-focus state. The task-line writer and the binding stay, and a brief still carries its `Desk-Task:` line, now written by the agent.
- The done-claim gate on every host, and the signoff witness with its ticket store.
- The ask gate, which inspected the harness's Write, Edit, Bash and PowerShell calls. Protecting the activation file in an unattended session is the harness's permission system's job.
- `desk_status` and `desk_doctor` lose the host-enforcement and gate-health sections, and the boot checks for host enforcement and hook dependencies are gone.

### Behaviour changes

- Desk's own commits now refuse to run when the desk checkout is not on its branch: the configured state branch when there is one, otherwise the remote's default branch (`origin/HEAD`), falling back to `main`. A detached HEAD is always refused. The refusal is an ordinary tool answer that names the branch it found and the one it expected, and it commits nothing. This covers every card write, `task_update`, `task_signoff` and `desk_save`.
- `task_signoff` records the sign-off without any human-channel verification, so a sign-off recorded through the tool counts as accepted. The sign-off block is now `{state, at, reason}`: Desk no longer writes `verified` or any witness or ticket field. Return lines for new refusals no longer end with a `verified` or `unverified` token. Existing cards keep their fields, and Desk readers accept both shapes.
- A later, different `task_signoff` answer now replaces the one held. Repeating the same answer changes nothing.
- The factory pipeline's sign-off, yield and rework rollups no longer emit `accepted_unverified`, `refused_unverified`, `signoff_unverified` or `compared_verified`, which were fixed at 0 and which nothing in this repository reads.

### Safe to delete

A leftover `desk.protected` Git config and the old state folders (`brief-focus/`, `host-enforcement-naming/` and the sign-off tickets) are inert now. Delete them whenever convenient.

The boot-acceptance evals keep their done-claim measurement patterns in the harness itself, as measurement only.
