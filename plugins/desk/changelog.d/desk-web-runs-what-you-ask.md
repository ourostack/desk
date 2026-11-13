### desk-web no longer refuses what an agent asks it to run

`mine` now runs `eval` and `run-code` as given and returns what the script returns, unredacted, and it runs the other commands it used to refuse: raw `keydown`, `keyup`, `mousemove`, `mousedown` and `mouseup`, `upload`, `dialog-accept` and `dialog-dismiss`, `console`, and `localstorage-*` and `sessionstorage-*`. A script's own error comes back in `AUTH_SCRIPT_FAILED`. `goto` takes any address, and `press` takes any key Playwright knows, a space included. Snapshots and screenshots still redact typed values.

Gone: `AUTH_COMMAND_REFUSED` (an unknown command now says `AUTH_COMMAND_UNKNOWN` and lists the commands), `AUTH_URL_REFUSED`, the 64 KiB argument limit, the 10,000-pixel limit on `resize` and `mousewheel`, and the key-name pattern on `press`. In `fresh`, `run-code`, sign-in state and cookie commands are allowed too; commands that open, close, attach or list other browsers stay out, because they can kill sessions that are not this agent's. The hints and docs no longer say eval is never needed.

This lets the Teams send macros in MS Desk run in `mine` as they are.
