#!/bin/sh
set -eu
case "${DESK_MULTI_USER-0}" in
  1)
    exec /usr/bin/setpriv --bounding-set=-all,+chown,+setgid,+setuid \
      --inh-caps=-all,+chown,+setgid,+setuid --ambient-caps=-all,+chown,+setgid,+setuid \
      --reuid=1000 --regid=1000 --clear-groups --no-new-privs -- /usr/bin/tini -- "$@"
    ;;
  0)
    exec /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
      --reuid=1000 --regid=1000 --clear-groups --no-new-privs -- /usr/bin/tini -- "$@"
    ;;
  *) echo "DESK_MULTI_USER must be 0 or 1." >&2; exit 1 ;;
esac
