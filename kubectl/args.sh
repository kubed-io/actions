#!/usr/bin/env bash
# The command line from the action's inputs, one NUL-ended argument each, so a value with
# spaces stays whole. The flags go after the args: build, plan and up read their first
# argument as the app's directory. Each run gets its own files, so several in a job keep
# theirs.
set -eo pipefail

read -ra CLI <<< "$CMD $ARGS"
[ "$ALL_NAMESPACES" = true ] && CLI+=(--all-namespaces)
CLI+=(
  ${NAMESPACE:+--namespace "$NAMESPACE"}
  ${SELECTOR:+--selector "$SELECTOR"}
  ${OUTPUT:+--output "$OUTPUT"}
  ${CONTEXT:+--context "$CONTEXT"}
  ${DRY_RUN:+--dry-run="$DRY_RUN"}
)

OUT="$(mktemp -p "$RUNNER_TEMP" kubectl-out-XXXXXX.txt)"
FILE="${OUT/kubectl-out-/kubectl-args-}"
printf '%s\0' "${CLI[@]}" > "$FILE"
{
  echo "args_file=$FILE"
  echo "output_file=$OUT"
  echo "error_file=${OUT/kubectl-out-/kubectl-err-}"
} >> "$GITHUB_OUTPUT"
echo "kubectl ${CLI[*]}"
