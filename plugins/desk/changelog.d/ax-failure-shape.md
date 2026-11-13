### Desk failures say what probably happened, how to look, how to report and how to keep working

Desk's session-start sync failures, the `content_home_unpublished_base` refusal and the blocked-push note on every write now use [Ouro AX](https://ui.ouroboros.bot/docs/ax-problem.md)'s one-line problem shape, copied into [`mcp/src/lib/ouro/ax/`](mcp/src/lib/ouro/ax/). Each line names the probable cause, the command or tool that shows more, the one call that reports the failure, and how to keep working meanwhile, so a failure no longer leaves an agent doubting its work.

The report call is `friction_add` with an `error_code`, such as `friction_add {"error_code":"desk_push_blocked"}`. It records the failure as system friction on the desk with the failure's message and stack, the Desk version, the host, the desk path and the recent sync status, credentials redacted; `body` and `title` are optional then. `desk_doctor` lists the failures its process has seen.

Desk's tests check every failure text in its MCP source and browser tool with Ouro AX's precise-failure check, against an allow-list of 72 texts not yet converted that can only shrink. The Ouro AX files are copied in but not yet imported by the server: they are TypeScript that Node runs from 22.18, and Desk still supports Node 20.
