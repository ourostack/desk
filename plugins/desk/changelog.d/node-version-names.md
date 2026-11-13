### Name the Node versions Desk supports when no local Node matches

When no installed Node matches a shipped runtime pack, Desk's `use_shipped_node` remediation now names the Node versions it supports on this machine, such as "Install Node 24", instead of module ABI numbers. A per-user install is enough and needs no administrator rights, for example with fnm under `%LOCALAPPDATA%` on Windows. Desk's launcher finds that Node by itself once the Desk MCP server reconnects.
