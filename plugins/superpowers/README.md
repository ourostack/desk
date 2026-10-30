# Superpowers provider

This package contains the selected, unmodified source payload from [obra/superpowers](https://github.com/obra/superpowers) version 7.0.1, commit `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`. The MIT license and source notices remain intact. `upstream-sources.lock.json` records every selected source path and SHA-256; the upstream tree is `5e3a3c9af45c3474506fb62a3ce664bd03a2cdc4`.

The root `plugin.json`, `.claude-plugin/plugin.json`, this README, and `hooks/copilot-hooks.json` are Ourostack-authored packaging, not upstream files. Copilot uses the explicit `PLUGIN_ROOT` adapter with a bounded timeout. The pristine upstream hooks remain locked for provenance and Claude packaging.

With Desk, invoke `desk:using-superpowers-with-desk` before using these skills. That contract binds plans, progress, authority, and the terminal endpoint to Desk; it does not change the upstream payload. A successful hook transport probe is not proof of engineering-method consumption, background inheritance, or complete host qualification.
