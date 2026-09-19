#!/usr/bin/env bash
# Setup step for the plan-agent action. Builds the system prompt (role + optional
# app-specific context) into a temp file for --append-system-prompt-file, minifies
# the JSON schema to one line for claude_args, optionally renders extra MCP servers
# to a temp .mcp.json (with env-var substitution so a bearer token from env is
# interpolated, never hardcoded), and assembles the --disallowedTools list.
#
# Reads:  GITHUB_ACTION_PATH, RUNNER_TEMP, GITHUB_WORKSPACE, CONTEXT_FILE,
#         MCP_CONFIG, EXTRA_DISALLOWED_TOOLS (+ any vars MCP_CONFIG references)
# Writes (to $GITHUB_OUTPUT): system_prompt_file, schema, mcp_config_file,
#         disallowed_tools
set -euo pipefail

sys="$RUNNER_TEMP/plan-agent-system.md"
cp "$GITHUB_ACTION_PATH/system-prompt.md" "$sys"
if [ -n "${CONTEXT_FILE:-}" ] && [ -f "$GITHUB_WORKSPACE/$CONTEXT_FILE" ]; then
  { printf '\n\n## Repository-specific context\n\n'; cat "$GITHUB_WORKSPACE/$CONTEXT_FILE"; } >> "$sys"
fi
echo "system_prompt_file=$sys" >> "$GITHUB_OUTPUT"

schema="$(jq -c . "$GITHUB_ACTION_PATH/output-schema.json")"
echo "schema=$schema" >> "$GITHUB_OUTPUT"

# Optional extra MCP servers. MCP_CONFIG is either inline JSON or a path (absolute,
# or repo-relative under GITHUB_WORKSPACE). Render it through envsubst so
# placeholders like ${N8N_MCP_TOKEN} are filled from the environment at runtime —
# the token lives only in env (e.g. exported by the caller from Secret Manager),
# never in this action or the caller's YAML. Empty => no extra MCP servers.
mcp_config_file=""
if [ -n "${MCP_CONFIG:-}" ]; then
  raw="$RUNNER_TEMP/plan-agent-mcp-raw.json"
  if [ -f "$MCP_CONFIG" ]; then
    cp "$MCP_CONFIG" "$raw"
  elif [ -f "$GITHUB_WORKSPACE/$MCP_CONFIG" ]; then
    cp "$GITHUB_WORKSPACE/$MCP_CONFIG" "$raw"
  else
    printf '%s' "$MCP_CONFIG" > "$raw"
  fi
  mcp_config_file="$RUNNER_TEMP/plan-agent-mcp.json"
  envsubst < "$raw" > "$mcp_config_file"
fi
echo "mcp_config_file=$mcp_config_file" >> "$GITHUB_OUTPUT"

# Read-only guardrail: the agent never gets Bash/Edit/Write/etc. Callers can append
# more denials (e.g. an MCP server's write tools) via EXTRA_DISALLOWED_TOOLS to keep
# an MCP-enabled run read-only. Empty => only the built-in list is denied (unchanged).
disallowed="Bash,Edit,Write,MultiEdit,NotebookEdit"
if [ -n "${EXTRA_DISALLOWED_TOOLS:-}" ]; then
  disallowed="$disallowed,$EXTRA_DISALLOWED_TOOLS"
fi
echo "disallowed_tools=$disallowed" >> "$GITHUB_OUTPUT"
