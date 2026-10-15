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
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
if [ -n "$DESK_PRIVATE_HOOK_GIT_DIR" ]; then
  GIT_DIR=$DESK_PRIVATE_HOOK_GIT_DIR
  GIT_WORK_TREE=$DESK_PRIVATE_HOOK_WORK_TREE
  export GIT_DIR GIT_WORK_TREE
  case "${GIT_INDEX_FILE-}" in
    ""|/*) ;;
    *) GIT_INDEX_FILE="$here/$GIT_INDEX_FILE"; export GIT_INDEX_FILE;;
  esac
fi
exec "$script" "$@"
