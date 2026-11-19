### Sessions know the other desks on the machine again

Session start now names the other desks on this machine and where they are, in one line, so a session in one desk (a Crew workspace, say) no longer guesses a path to another desk or tries to clone one that is already here. This had been lost when session start moved into one script call: the agent-run step that read the desk registry was left out of the boot.

`desk_status` returns `machine_desks` (name, path, owner, remote) and takes a `desk` input that resolves a desk by name, repo or owner; a desk that isn't registered or isn't on this machine says to register it, never to clone it. Desk reads the registry from `$DESK_REGISTRY`, the path a registering tool records in `~/.config/desk/registry-path`, or the bound desk's own `_meta/desks.md`. `desk_save` also recognises registered Crew desks as other desks.

`start-task` now tells the agent to search the repo's history for a capability before designing it, and to treat finding one as a regression to restore.
