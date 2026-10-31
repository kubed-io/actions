#!/usr/bin/env bash
# The stdout as the step's `stdout` output, behind a marker it cannot contain.
set -eo pipefail

MARK="EOF_$(cat /proc/sys/kernel/random/uuid)"
{
  echo "stdout<<$MARK"
  cat "$OUT"
  [ -n "$(tail -c1 "$OUT")" ] && echo
  echo "$MARK"
} >> "$GITHUB_OUTPUT"
