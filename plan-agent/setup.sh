#!/usr/bin/env bash
# Setup step for the plan-agent action. Builds the system prompt (the mode's role +
# optional app-specific context) into a temp file for --append-system-prompt-file,
# minifies the mode's JSON schema to one line for claude_args, optionally renders
# extra MCP servers to a temp .mcp.json (with env-var substitution so a bearer
# token from env is interpolated, never hardcoded), and assembles the agent, tool
# and session flags.
#
# Reads:  GITHUB_ACTION_PATH, RUNNER_TEMP, GITHUB_WORKSPACE, GITHUB_REPOSITORY, MODE,
#         AGENT, CONTEXT_FILE, MCP_CONFIG, DISALLOWED_TOOLS, EXTRA_DISALLOWED_TOOLS,
#         ALLOWED_TOOLS, SESSION_KEY, SESSION_TITLE (+ any vars MCP_CONFIG references,
#         and CLAUDE_CONFIG_DIR / CLAUDE_CODE_PROJECT_DIR_NAME on a runner that keeps
#         Claude's sessions)
# Writes (to $GITHUB_OUTPUT): system_prompt_file, schema, mcp_config_file,
#         disallowed_tools, args
set -euo pipefail

# shell-quote one value for claude_args, which claude-code-action splits like a shell
q() { jq -rn --arg v "$1" '$v | @sh'; }

case "${MODE:-plan}" in
  plan)  role="system-prompt.md"; schema_file="output-schema.json" ;;
  reply) role="reply-prompt.md";  schema_file="reply-schema.json" ;;
  *) echo "::error::mode must be plan or reply, got '${MODE}'"; exit 1 ;;
esac

sys="$RUNNER_TEMP/plan-agent-system.md"
cp "$GITHUB_ACTION_PATH/$role" "$sys"
if [ -n "${CONTEXT_FILE:-}" ] && [ -f "$GITHUB_WORKSPACE/$CONTEXT_FILE" ]; then
  { printf '\n\n## Repository-specific context\n\n'; cat "$GITHUB_WORKSPACE/$CONTEXT_FILE"; } >> "$sys"
fi
echo "system_prompt_file=$sys" >> "$GITHUB_OUTPUT"

schema="$(jq -c . "$GITHUB_ACTION_PATH/$schema_file")"
echo "schema=$schema" >> "$GITHUB_OUTPUT"

args=""

# A repo agent (.claude/agents/<name>.md) runs the session; its prompt replaces
# Claude Code's own, and the mode's role above is appended to it.
if [ -n "${AGENT:-}" ]; then
  args="$args --agent $(q "$AGENT")"
fi

# Optional extra MCP servers. MCP_CONFIG is either inline JSON or a path (absolute,
# or repo-relative under GITHUB_WORKSPACE). Render it through envsubst so
# placeholders like ${N8N_MCP_TOKEN} are filled from the environment at runtime —
# the token lives only in env (e.g. exported by the caller from Secret Manager),
# never in this action or the caller's YAML. Empty => no extra MCP servers. Every
# server it names is allowed; deny its write tools with the disallow lists.
mcp_config_file=""
mcp_tools=""
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
  mcp_tools="$(jq -r '.mcpServers | keys | map("mcp__" + .) | join(",")' "$mcp_config_file")"
  args="$args --mcp-config $(q "$mcp_config_file")"
fi
echo "mcp_config_file=$mcp_config_file" >> "$GITHUB_OUTPUT"

# Read-only guardrail by default: DISALLOWED_TOOLS defaults to
# Bash,Edit,Write,MultiEdit,NotebookEdit, and EXTRA_DISALLOWED_TOOLS appends to it
# (e.g. an MCP server's write tools). A caller can pass an empty DISALLOWED_TOOLS.
disallowed="${DISALLOWED_TOOLS:-}"
if [ -n "${EXTRA_DISALLOWED_TOOLS:-}" ]; then
  disallowed="${disallowed:+$disallowed,}$EXTRA_DISALLOWED_TOOLS"
fi
echo "disallowed_tools=$disallowed" >> "$GITHUB_OUTPUT"
[ -z "$disallowed" ] || args="$args --disallowedTools $(q "$disallowed")"

allowed="${ALLOWED_TOOLS:-}"
if [ -n "$mcp_tools" ]; then
  allowed="${allowed:+$allowed,}$mcp_tools"
fi
[ -z "$allowed" ] || args="$args --allowedTools $(q "$allowed")"

# A session key makes the conversation resumable: uuid5(repo + key) is the session
# ID, so where Claude's sessions persist (CLAUDE_CONFIG_DIR, as on the kubed-io
# claude runner) an existing transcript is resumed and a new one starts under
# SESSION_TITLE. Elsewhere every run simply starts that session fresh.
if [ -n "${SESSION_KEY:-}" ]; then
  id="$(python3 -c 'import sys, uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, sys.argv[1]))' \
    "https://github.com/$GITHUB_REPOSITORY#$SESSION_KEY")"
  transcript="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/${CLAUDE_CODE_PROJECT_DIR_NAME:-none}/$id.jsonl"
  if [ -f "$transcript" ]; then
    args="$args --resume $id"
  else
    args="$args --session-id $id --name $(q "${SESSION_TITLE:-$SESSION_KEY}")"
  fi
fi

echo "args=$args" | tee -a "$GITHUB_OUTPUT"
