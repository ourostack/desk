# Desk's session-start command (hooks.json, copilot-hooks.json) sources this in the host's own shell when no `node` is on PATH, so
# neither Desk's hooks nor its tool servers can start. It runs shell builtins only (no process, well under a millisecond), installs
# nothing, and prints the session's context: the Node.js Desk needs (the engines floor in mcp/package.json), the install command for
# this platform, and that a new session is needed because tool servers load only when a session starts. `desk_host` (claude or
# copilot) picks the host's output shape. The text goes into JSON through printf, so it holds no double quote, backslash or percent sign.
if [ "$OS" = Windows_NT ] || [ -n "$MSYSTEM" ]; then
  desk_install='run `winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements` in a terminal'
elif [ -d /System/Library/CoreServices ]; then
  desk_install='run `brew install node` in a terminal (without Homebrew, use the installer from https://nodejs.org/en/download)'
else
  desk_install='install the nodejs package with the distribution package manager (for example `sudo apt install nodejs` or `sudo dnf install nodejs`) and check that `node --version` prints v20 or newer; if it is older, install the current LTS from https://nodejs.org/en/download'
fi
desk_text='Desk needs Node.js 20 or newer, and this machine has no Node.js (no `node` on PATH), so the Desk tool servers (desk, desk-web) cannot run and Desk tools do not work in this session. Install it: '"$desk_install"'. Then the person must open a new terminal and start a new session, because tool servers load only when a session starts.'
if [ "$desk_host" = claude ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$desk_text"
else
  printf '{"additionalContext":"%s"}\n' "$desk_text"
fi
