#!/usr/bin/env bash
# Setup step for the plan-agent action. Builds the system prompt (role + optional
# app-specific context) into a temp file for --append-system-prompt-file, and
# minifies the JSON schema to one line for claude_args (--json-schema is inline
# JSON, and claude_args splits on newlines).
#
# Reads:  GITHUB_ACTION_PATH, RUNNER_TEMP, GITHUB_WORKSPACE, CONTEXT_FILE
# Writes (to $GITHUB_OUTPUT): system_prompt_file, schema
set -euo pipefail

sys="$RUNNER_TEMP/plan-agent-system.md"
cp "$GITHUB_ACTION_PATH/system-prompt.md" "$sys"
if [ -n "${CONTEXT_FILE:-}" ] && [ -f "$GITHUB_WORKSPACE/$CONTEXT_FILE" ]; then
  { printf '\n\n## Repository-specific context\n\n'; cat "$GITHUB_WORKSPACE/$CONTEXT_FILE"; } >> "$sys"
fi
echo "system_prompt_file=$sys" >> "$GITHUB_OUTPUT"

schema="$(jq -c . "$GITHUB_ACTION_PATH/output-schema.json")"
echo "schema=$schema" >> "$GITHUB_OUTPUT"
