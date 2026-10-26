# Hosts roadmap

Desk supports two hosts: Claude Code and Copilot CLI. The capabilities below were removed because no supported host used them. Rebuild one only when a real user needs it, and restore it from Git history (the removal pull request names the files).

| Removed capability | Problem it would solve |
| --- | --- |
| Codex support: the `.codex-plugin/` manifests, the `.agents/` marketplace, `agents/*.toml`, the Codex activation adapter and its smoke test, the activation ledger, the Codex plugin-cache audit and the `codex-onboarding` skill | Running Desk as the default worker in Codex CLI or Codex App, with Desk writing and later removing its own block in Codex's config and `AGENTS.md`. Rebuild it only if Codex becomes a supported target. |
