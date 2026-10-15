### Fixed

- Claude's Desk worker and observer now declare an `AskUserQuestion` exclusion through native agent tool policy, preserving the inherited tool pool and ordinary chat questions. Document Copilot's launcher-owned `--excluded-tools=ask_user` boundary: plugin instructions and deny hooks do not hide tools, and plugin metadata does not impose a CLI flag. Overlay and consumer catalog visibility remain separately qualified.
