### The idle Desk MCP proxy ends on a signal instead of spinning

When Desk's MCP proxy had stopped its idle server and then received SIGINT, SIGTERM or SIGHUP, it re-sent the signal to itself while its own handler was still installed. The handler ran again and again, using a full CPU core and never exiting (reported in #1728). The proxy now removes its signal listeners before taking the signal itself, so the process ends with the signal's normal status. Signals while a server is running, a closed host stream and the re-exec path behave as before.
