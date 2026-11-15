Desk now exposes 21 tools instead of 24, keeping the ones agents use and folding three rarely used ones into close neighbours. Old skill text that names a removed tool needs the new call:

- `desk_timeline` is now `desk_search` with no `query` (or `newest: true`): it lists documents by update time, newest first, inside the `filters.since` to `filters.until` window, and the `track`, `status` and `kind` filters narrow it. In that mode `scope` defaults to `all`, as `desk_timeline` did.
- `desk_reindex` is now `desk_doctor` with `reindex: true`. It answers once exact-word search is current, and says `search_starting` until the search engine has started.
- `note_leave` and `note_ack` are now one tool, `note`: pass `to`, `subject` and `body` to leave a note, or `ack` with the note's path to acknowledge one. Its errors and the note files it writes name `note`, not the old tools. The Crew skills and the session-start details name the new calls.
