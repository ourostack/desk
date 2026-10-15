#!/bin/sh
# Keep paths in shell memory; only a cwd-relative original filename reaches exec.
name=$1
shift
case "$name" in ""|*[!a-z0-9-]*) exit 1;; esac
target=$DESK_PRIVATE_HOOK_ORIGINAL_DIR
[ -x "$target/$name" ] || exit 0
[ -f "$target/$name" ] || exit 1
here=$(pwd -P) || exit 1
case "$target" in
  /*)
    base=$here
    prefix=
    while :; do
      case "$target" in
        "$base"/*) suffix=${target#"$base"/}; break;;
        "$base") suffix=; break;;
      esac
      if [ "$base" = / ]; then suffix=${target#/}; break; fi
      base=${base%/*}
      [ -n "$base" ] || base=/
      prefix="../$prefix"
    done
    script="./$prefix$suffix/$name"
    ;;
  *) script="./$target/$name";;
esac
# Nested Git must retain the public hook-routing override.
if [ -n "$DESK_PRIVATE_HOOK_WORK_TREE" ]; then
  # Let Git discover this same worktree even after the original hook changes cwd.
  unset GIT_DIR
  GIT_WORK_TREE=$DESK_PRIVATE_HOOK_WORK_TREE
  export GIT_WORK_TREE
  case "${GIT_INDEX_FILE-}" in
    ""|/*) ;;
    *) GIT_INDEX_FILE="$here/$GIT_INDEX_FILE"; export GIT_INDEX_FILE;;
  esac
fi
exec "$script" "$@"
