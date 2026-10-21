### Fixed

- Move the unchanged Claude/Codex MCP payload to an explicitly referenced engine-owned file, leaving no generic root `.mcp.json` for Agency to reinject as user configuration. Keep Copilot's native MCP definition, launch payloads and provider trust guards unchanged. Native ownership and label behavior still require receiving-host qualification.
