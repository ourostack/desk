Meaning-based search now works with nothing to install. Desk embeds the desk inside its own MCP server with a small built-in model (Model2Vec `potion-base-8M`, run in plain JavaScript), downloaded once on first use into the desk's `.state` folder. There is no separate search controller process, no Ollama and no shared index between Desk builds any more.

- `desk_recall` always answers. Before the model is ready it returns exact-word matches and says meaning-based search is getting ready; while sections are still being embedded it adds exact-word matches and says how many sections remain.
- Vectors are kept in `.state/desk-vectors.sqlite` by section text, so an edit embeds only the changed sections and nothing is embedded again after a restart. The first run embeds in small batches with short pauses so the machine stays responsive.
- `desk_status` reports search in plain words: "Search is ready." or "Search is preparing N of M sections…".
- At start Desk deletes the old shared index (`.state/desk-index.sqlite`, which reached 9.7 GB on one desk) when no other process has it open.
