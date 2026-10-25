`desk_status` now reports search from the session's own search engine, so it says "Search is ready." or "Search is preparing N of M sections…" in every session. Before, a large desk's full status rarely finished within the call's time budget, and search read `not_checked`.

`desk_recall` now ranks by meaning and by exact words together (reciprocal rank fusion), so a document strong on both comes first. Search also indexes every Markdown file inside a track, such as a runbook or notes in an iteration folder, not only `task.md`, `planning.md`, `doing.md` and `feedback.md`.
