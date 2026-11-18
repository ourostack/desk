### Durable work goes on the desk, not in the host's session folder

The GitHub Copilot app tells agents to write plans and notes in the session's `files/` folder, and its image tool saves to the session's `images/` folder. Both vanish with the session and nobody else can find them, so a lane wrote an inventory, a generated test and reference images there and handed the person host paths. Three changes:

The boot text's last rule now says durable work (reports, evidence, images others must find) goes in the focused task's desk folder and the host's session `files/` is scratch, overriding the host's artifacts instruction. It replaces wording in place, so the boot text stays within its 1.4 KB budget.

A new Copilot `preToolUse` hook, [`hooks/copilot-durable-files.cjs`](hooks/copilot-durable-files.cjs), watches `create`, `edit` and the image tools. When one targets a durable-looking file (`.md`, an image, `.svg`, `.pdf`, `.csv`, `.json`, `.html`) under `~/.copilot/session-state/*/files` or `*/images`, it allows the call and adds a note naming the focused task's folder, or telling the agent to run start-task first when no task is focused. It never blocks and fails open.

`desk_status`'s "details are still loading" answer now says what to do meanwhile: `task_focus` the task or `task_create` one with `focus: true`, so the work has a desk folder.
