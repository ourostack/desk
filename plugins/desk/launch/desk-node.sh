#!/bin/sh
# Desk Node selector. POSIX sh only, so it runs on machines with no usable Node.
#
# Every Desk entry point on a POSIX host starts Node through this script, so Desk never depends on which `node` a host or shell puts first on PATH. It lists the Node binaries on PATH and under the usual version managers (nvm, fnm, Volta, asdf, mise, Homebrew and the system), picks the newest one that satisfies the `engines.node` range in ../mcp/package.json, checks that it runs, and execs it with the given arguments.
#
# Usage:
#   sh desk-node.sh --mcp <script> [args...]  start the Desk MCP server; with no compatible Node, exec node-missing-responder.sh
#   sh desk-node.sh <script> [args...]        run a hook script; with no compatible Node, fall back to the first `node` on PATH, or exit 127
#   sh desk-node.sh --which                   print the chosen Node and exit 0, or exit 1 when none qualifies
#
# DESK_NODE_SYSTEM_PREFIX prefixes the fixed Homebrew and system locations, so tests can point them at a fixture tree.

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 127

# Keep in step with "engines.node" in ../mcp/package.json; used only when that file cannot be read.
DEFAULT_NODE_RANGE='>=20.0.0'

mode=run
case "${1:-}" in
  --mcp) mode=mcp; shift ;;
  --which) mode=which; shift ;;
esac

tab=$(printf '\t')

# Read engines.node from package.json without Node.
node_range() {
  range=$(awk '
    /"engines"[ \t]*:/ { inside = 1 }
    inside && /"node"[ \t]*:/ {
      line = $0
      sub(/.*"node"[ \t]*:[ \t]*"/, "", line)
      sub(/".*/, "", line)
      print line
      exit
    }
    inside && /}/ { inside = 0 }
  ' "$here/../mcp/package.json" 2>/dev/null)
  if [ -n "$range" ]; then printf '%s\n' "$range"; else printf '%s\n' "$DEFAULT_NODE_RANGE"; fi
}

emit() {
  if [ -f "$1" ] && [ -x "$1" ]; then printf '%s\n' "$1"; fi
}

# Print every candidate Node binary, PATH first so a tie keeps the host's own choice.
candidates() {
  old_ifs=$IFS
  set -f
  IFS=:
  # shellcheck disable=SC2086
  set -- ${PATH:-}
  IFS=$old_ifs
  set +f
  for dir in "$@"; do
    if [ -n "$dir" ]; then emit "$dir/node"; fi
  done
  home=${HOME:-}
  data_home=${XDG_DATA_HOME:-$home/.local/share}
  if [ -n "$home" ] || [ -n "${NVM_DIR:-}" ]; then
    for f in "${NVM_DIR:-$home/.nvm}"/versions/node/*/bin/node; do emit "$f"; done
  fi
  for base in "${FNM_DIR:-}" "${home:+$data_home/fnm}" "${home:+$home/Library/Application Support/fnm}" "${home:+$home/.fnm}"; do
    if [ -n "$base" ]; then
      for f in "$base"/node-versions/*/installation/bin/node; do emit "$f"; done
    fi
  done
  if [ -n "$home" ] || [ -n "${VOLTA_HOME:-}" ]; then
    for f in "${VOLTA_HOME:-$home/.volta}"/tools/image/node/*/bin/node; do emit "$f"; done
  fi
  if [ -n "$home" ] || [ -n "${ASDF_DATA_DIR:-}" ]; then
    for f in "${ASDF_DATA_DIR:-$home/.asdf}"/installs/nodejs/*/bin/node; do emit "$f"; done
  fi
  if [ -n "$home" ] || [ -n "${MISE_DATA_DIR:-}" ]; then
    for f in "${MISE_DATA_DIR:-$data_home/mise}"/installs/node/*/bin/node; do emit "$f"; done
  fi
  prefix=${DESK_NODE_SYSTEM_PREFIX:-}
  emit "$prefix/opt/homebrew/bin/node"
  emit "$prefix/usr/local/bin/node"
  for f in "$prefix"/opt/homebrew/opt/node*/bin/node "$prefix"/usr/local/opt/node*/bin/node; do emit "$f"; done
  emit "$prefix/usr/bin/node"
}

# Ask a binary for its version: prints X.Y.Z, or nothing when it does not run.
probe_version() {
  "$1" --version 2>/dev/null | awk 'NR == 1 { sub(/^v/, ""); if (match($0, /^[0-9]+\.[0-9]+\.[0-9]+/)) print substr($0, 1, RLENGTH) }'
}

# Print "version<TAB>order<TAB>path" for every candidate. Version managers keep each install in a directory named after its version, so those are read from the path; anything else is asked.
versioned_candidates() {
  order=0
  candidates | awk '
    {
      rest = $0; version = ""
      while (match(rest, /\/v?[0-9]+\.[0-9]+\.[0-9]+\//)) {
        version = substr(rest, RSTART + 1, RLENGTH - 2)
        rest = substr(rest, RSTART + RLENGTH - 1)
      }
      sub(/^v/, "", version)
      print (version == "" ? "?" : version) "\t" $0
    }
  ' | while IFS="$tab" read -r version path; do
    order=$((order + 1))
    if [ "$version" = "?" ]; then version=$(probe_version "$path"); fi
    if [ -n "$version" ]; then printf '%s\t%s\t%s\n' "$version" "$order" "$path"; fi
  done
}

# Keep the lines of "version<TAB>order<TAB>path" whose version satisfies the range, then print the path of the newest (the earliest on a tie).
pick_newest() {
  awk -F "$tab" -v range="$1" '
    function vcmp(a, b,   x, y, i) {
      split(a, x, "."); split(b, y, ".")
      for (i = 1; i <= 3; i++) {
        if (x[i] + 0 < y[i] + 0) return -1
        if (x[i] + 0 > y[i] + 0) return 1
      }
      return 0
    }
    # The version one step above a partial version at position n: 20 -> 21.0.0, 20.1 -> 20.2.0, 20.1.2 -> 20.1.3.
    function bump(p, n) {
      if (n == 1) return (p[1] + 1) ".0.0"
      if (n == 2) return p[1] "." (p[2] + 1) ".0"
      return p[1] "." p[2] "." (p[3] + 1)
    }
    function comparator_ok(version, c,   op, p, n, full, upper) {
      op = ""
      if (match(c, /^(>=|<=|>|<|=|\^|~)/)) { op = substr(c, 1, RLENGTH); c = substr(c, RLENGTH + 1) }
      sub(/^v/, "", c)
      if (c == "*" || c == "x" || c == "X") return op == "" || op == "=" || op == ">=" || op == "<="
      while (c ~ /\.(\*|x|X)$/) sub(/\.(\*|x|X)$/, "", c)
      if (c !~ /^[0-9]+(\.[0-9]+(\.[0-9]+)?)?$/) return 0
      n = split(c, p, ".")
      full = p[1] "." (n > 1 ? p[2] : 0) "." (n > 2 ? p[3] : 0)
      if (op == ">=") return vcmp(version, full) >= 0
      if (op == "<") return vcmp(version, full) < 0
      if (op == ">") return n == 3 ? vcmp(version, full) > 0 : vcmp(version, bump(p, n)) >= 0
      if (op == "<=") return n == 3 ? vcmp(version, full) <= 0 : vcmp(version, bump(p, n)) < 0
      if (op == "~") upper = bump(p, n == 1 ? 1 : 2)
      else if (op == "^") upper = (p[1] > 0 || n == 1) ? bump(p, 1) : ((p[2] > 0 || n == 2) ? bump(p, 2) : bump(p, 3))
      else if (n == 3) return vcmp(version, full) == 0
      else upper = bump(p, n)
      return vcmp(version, full) >= 0 && vcmp(version, upper) < 0
    }
    function satisfies(version, r,   alts, na, a, comps, nc, i, ok) {
      # npm allows a space between an operator and its version (">= 20").
      gsub(/>=[ \t]+/, ">=", r); gsub(/<=[ \t]+/, "<=", r); gsub(/>[ \t]+/, ">", r); gsub(/<[ \t]+/, "<", r)
      gsub(/=[ \t]+/, "=", r); gsub(/\^[ \t]+/, "^", r); gsub(/~[ \t]+/, "~", r)
      na = split(r, alts, /\|\|/)
      if (na == 0) return 1
      for (a = 1; a <= na; a++) {
        nc = split(alts[a], comps, /[ \t]+/)
        ok = 1
        for (i = 1; i <= nc; i++) {
          if (comps[i] == "") continue
          if (!comparator_ok(version, comps[i])) { ok = 0; break }
        }
        if (ok) return 1
      }
      return 0
    }
    satisfies($1, range) {
      if (best == "" || vcmp($1, best) > 0) { best = $1; path = $3 }
    }
    END { if (best != "") print path }
  '
}

select_node() {
  range=$(node_range)
  list=$(versioned_candidates)
  while [ -n "$list" ]; do
    chosen=$(printf '%s\n' "$list" | pick_newest "$range")
    if [ -z "$chosen" ]; then return 1; fi
    # A version read from a directory name is only trusted once the binary actually runs.
    if [ -n "$(probe_version "$chosen")" ]; then
      printf '%s\n' "$chosen"
      return 0
    fi
    list=$(printf '%s\n' "$list" | awk -F "$tab" -v drop="$chosen" '$3 != drop')
  done
  return 1
}

chosen=$(select_node)

case "$mode" in
  which)
    if [ -n "$chosen" ]; then printf '%s\n' "$chosen"; exit 0; fi
    exit 1
    ;;
  mcp)
    if [ -n "$chosen" ]; then exec "$chosen" "$@"; fi
    DESK_NODE_RANGE=$(node_range)
    export DESK_NODE_RANGE
    exec sh "$here/node-missing-responder.sh"
    ;;
esac

if [ -n "$chosen" ]; then exec "$chosen" "$@"; fi
fallback=$(command -v node 2>/dev/null)
if [ -n "$fallback" ]; then exec "$fallback" "$@"; fi
printf '%s\n' "desk-node: no Node.js is installed; Desk needs Node $(node_range)." >&2
exit 127
