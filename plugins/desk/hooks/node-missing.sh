# Desk's session-start command (hooks.json, copilot-hooks.json) sources this in the host's own shell when no `node` is on PATH, so
# neither Desk's hooks nor its tool servers can start. It runs shell builtins only (no process, well under a millisecond), installs
# nothing, and prints the session's context: the Node.js Desk needs (the engines floor in mcp/package.json), the install command for
# this platform, and that a new session is needed because tool servers load only when a session starts. `desk_host` (claude or
# copilot) picks the host's output shape. The text goes into JSON through printf, so it holds no double quote, backslash or percent sign.
# A version manager the bootstrap would use comes first. nvm-windows also needs `nvm use`, because the host needs a `node` on PATH.
# On Windows, a node.exe that exists but is not on PATH (the app that started the session predates its install) gets the "installed at" message instead of install advice.
if [ "$OS" = Windows_NT ] || [ -n "$MSYSTEM" ]; then
  # Git Bash keeps Windows paths with backslashes, which the glob and the JSON text cannot use, so they become forward slashes first.
  desk_node=
  desk_pf=${ProgramFiles:-$PROGRAMFILES}
  desk_pf=${desk_pf//\\//}
  desk_nvm=${NVM_SYMLINK//\\//}
  desk_local=${LOCALAPPDATA//\\//}
  for desk_candidate in "$desk_pf/nodejs/node.exe" "/c/Program Files/nodejs/node.exe" "$desk_nvm/node.exe"; do
    if [ -z "$desk_node" ] && [ -f "$desk_candidate" ]; then desk_node=$desk_candidate; fi
  done
  # fnm keeps one folder per installed version; the last match in glob order wins.
  desk_fnm=
  for desk_candidate in "$desk_local"/fnm/node-versions/*/installation/node.exe; do
    if [ -f "$desk_candidate" ]; then desk_fnm=$desk_candidate; fi
  done
  if [ -z "$desk_node" ]; then desk_node=$desk_fnm; fi
  if [ -n "$desk_node" ]; then
    desk_install=
  elif [ -n "$NVM_HOME" ]; then
    desk_install='run `nvm install lts` and then `nvm use lts` in a terminal'
  else
    desk_install='run `winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements` in a terminal'
  fi
elif [ -s "$NVM_DIR/nvm.sh" ] || [ -s "$HOME/.nvm/nvm.sh" ]; then
  desk_install='run `nvm install --lts` in a terminal'
elif [ -d /System/Library/CoreServices ]; then
  desk_install='run `brew install node` in a terminal (without Homebrew, use the installer from https://nodejs.org/en/download)'
else
  desk_install='install the nodejs package with the distribution package manager (for example `sudo apt install nodejs` or `sudo dnf install nodejs`) and check that `node --version` prints v22.18 or newer; if it is older, install the current LTS from https://nodejs.org/en/download'
fi
desk_text='Desk needs Node.js 22.18 or newer, and this machine has no Node.js (no `node` on PATH), so the Desk tool servers (desk, desk-web) cannot run and Desk tools do not work in this session. Install it: '"$desk_install"'. Then the person must open a new terminal and start a new session, because tool servers load only when a session starts.'
if [ -n "$desk_node" ]; then
  desk_text="Desk needs Node.js 22.18 or newer. It is installed at $desk_node, but it is not on this session's PATH, because the app or service that started this session was started before Node was installed (or with an older PATH), so the Desk tool servers (desk, desk-web) cannot run and Desk tools do not work in this session. Restart the app or background service that started this session, or open a new terminal and start the session from there; there is nothing to install."
fi
if [ "$desk_host" = claude ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$desk_text"
else
  printf '{"additionalContext":"%s"}\n' "$desk_text"
fi
