Desk's [browser launcher](mcp/web.cjs) now finds Windows browser installations when environment variables retain their original casing, such as `ProgramFiles`, instead of requiring uppercase names. Its macOS path calculation also stays POSIX when exercised from a Windows host. Browser lock tests no longer assume a Unix PID exists.

The [bootstrap's installation hints](mcp/bootstrap.cjs) also compose POSIX script paths for Linux and macOS, regardless of the host exercising that branch.

Native Windows validation now runs package scripts through the selected Node's npm entry point rather than trying to execute a command shim directly. The test preload excludes the machine's system Git configuration, so line-ending policies cannot break fixture commits; it does not change that configuration. Startup and card-guard tests retain their behavioral checks without asserting POSIX separators or execute bits on Windows.

Fixture-only POSIX probes remain separate from the real native Node probe and MCP handshake checks.
