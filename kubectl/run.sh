#!/usr/bin/env bash
# Runs the command line args.sh wrote, in the step's working directory. stderr goes apart,
# so a build stays YAML and a failure's error can be shown; the exit code is kubectl's.
set -o pipefail

mapfile -d '' CLI < "$ARGS_FILE"
kubectl "${CLI[@]}" 2> "$ERR" | tee "$OUT"
RC=${PIPESTATUS[0]}
cat "$ERR" >&2
exit "$RC"
