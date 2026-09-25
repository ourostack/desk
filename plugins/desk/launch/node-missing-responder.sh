#!/bin/sh
# Desk MCP responder for a machine with no compatible Node. POSIX sh and awk only.
#
# desk-node.sh --mcp execs this when it finds no Node that satisfies Desk's engines range. It speaks line-delimited JSON-RPC on stdio, so the host's MCP handshake still completes: it answers initialize, ping and tools/list (the full Desk tool list, so the list never changes once Node is installed), and answers every tools/call with the same degraded result, {state: "degraded:node_missing", fix: "<install command>"}, for the agent to act on. Other requests get a JSON-RPC "method not found" error; notifications get no reply.

required=${DESK_NODE_RANGE:->=20.0.0}

# The exact command that installs a compatible Node on this machine.
install_command() {
  nvm_sh="${NVM_DIR:-${HOME:-}/.nvm}/nvm.sh"
  if command -v brew >/dev/null 2>&1; then
    printf '%s' 'brew install node'
  elif [ -s "$nvm_sh" ]; then
    printf '%s' ". \"$nvm_sh\" && nvm install --lts"
  else
    printf '%s' 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install --lts'
  fi
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

fix="Run \`$(install_command)\` in a shell, then reconnect the Desk MCP server (in Claude Code run /mcp and reconnect desk; otherwise start a new session). Desk needs Node.js $required; none is installed."
summary="Desk needs Node.js $required and found none on PATH or under nvm, fnm, Volta, asdf, mise or Homebrew, so only this Node-free responder is running. Every Desk tool is unavailable until Node is installed."

status=$(printf '{"status":"degraded","state":"degraded:node_missing","code":"node_missing","required_node":"%s","summary":"%s","fix":"%s"}' \
  "$(json_escape "$required")" "$(json_escape "$summary")" "$(json_escape "$fix")")
status_text=$(json_escape "$status")

tools='[{"name":"task_create"},{"name":"task_update"},{"name":"task_archive"},{"name":"track_create"},{"name":"track_update"},{"name":"friction_add"},{"name":"lesson_add"},{"name":"desk_work_ledger"},{"name":"desk_search"},{"name":"desk_recall"},{"name":"desk_similar"},{"name":"desk_timeline"},{"name":"desk_thread"},{"name":"desk_reindex"},{"name":"desk_status"},{"name":"desk_doctor"}]'
tools=$(printf '%s' "$tools" | sed 's/{"name":"\([a-z_]*\)"}/{"name":"\1","description":"Unavailable: Desk found no compatible Node.js. Call desk_status for the install command.","inputSchema":{"type":"object","properties":{},"additionalProperties":true}}/g')

# Print "<id> <method> <tool name> <protocolVersion>", separated by the ASCII unit separator (a tab would let read merge empty fields), for one JSON-RPC message, reading only its top-level "id" and "method" (so an "id" inside params never counts) plus the "name" and "protocolVersion" inside params.
fields() {
  printf '%s\n' "$1" | awk '
    {
      s = $0; n = length(s); depth = 0; i = 1; id = ""; method = ""; name = ""; version = ""
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "\"") {
          j = i + 1
          while (j <= n) {
            d = substr(s, j, 1)
            if (d == "\\") { j += 2; continue }
            if (d == "\"") break
            j++
          }
          token = substr(s, i, j - i + 1)
          i = j + 1
          k = i
          while (k <= n && substr(s, k, 1) ~ /[ \t]/) k++
          if (substr(s, k, 1) == ":") {
            k++
            while (k <= n && substr(s, k, 1) ~ /[ \t]/) k++
            rest = substr(s, k)
            if (depth == 1 && token == "\"id\"" && match(rest, /^("([^"\\]|\\.)*"|-?[0-9][0-9.eE+-]*)/)) id = substr(rest, 1, RLENGTH)
            if (depth == 1 && token == "\"method\"" && match(rest, /^"[^"\\]*"/)) method = substr(rest, 2, RLENGTH - 2)
            if (depth == 2 && token == "\"name\"" && name == "" && match(rest, /^"[^"\\]*"/)) name = substr(rest, 2, RLENGTH - 2)
            if (depth == 2 && token == "\"protocolVersion\"" && match(rest, /^"[0-9A-Za-z.-]*"/)) version = substr(rest, 2, RLENGTH - 2)
            i = k
          }
          continue
        }
        if (c == "{" || c == "[") depth++
        else if (c == "}" || c == "]") depth--
        i++
      }
      printf "%s\037%s\037%s\037%s\n", id, method, name, version
    }
  '
}

reply() {
  printf '{"jsonrpc":"2.0","id":%s,%s}\n' "$1" "$2"
}

sep=$(printf "\037")
cr=$(printf '\r')

while IFS= read -r line || [ -n "$line" ]; do
  line=${line%"$cr"}
  IFS="$sep" read -r id method tool protocol <<EOF
$(fields "$line")
EOF
  # A message without an id is a notification: it gets no reply.
  if [ -z "$id" ]; then continue; fi
  case "$method" in
    initialize)
      reply "$id" "\"result\":{\"protocolVersion\":\"${protocol:-2025-06-18}\",\"capabilities\":{\"tools\":{\"listChanged\":true}},\"serverInfo\":{\"name\":\"desk-mcp-node-missing\",\"version\":\"0.0.0\"},\"instructions\":\"$(json_escape "$summary") $(json_escape "$fix")\"}"
      ;;
    ping)
      reply "$id" '"result":{}'
      ;;
    tools/list)
      reply "$id" "\"result\":{\"tools\":$tools}"
      ;;
    tools/call)
      case "$tool" in
        desk_status|desk_doctor) error=false ;;
        *) error=true ;;
      esac
      reply "$id" "\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"$status_text\"}],\"isError\":$error}"
      ;;
    *)
      reply "$id" "\"error\":{\"code\":-32601,\"message\":\"Method not found: $(json_escape "$method")\"}"
      ;;
  esac
done
exit 0
