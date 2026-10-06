#!/usr/bin/env bash
# Setup step for issue-agent. Builds the appended system prompt (the issue contract
# + optional app-specific context), minifies the reply schema for claude_args,
# renders MCP_CONFIG to a temp file (envsubst, so a token comes from env and is
# never hardcoded), and assembles the agent, tool and session flags.
#
# Reads:  GITHUB_ACTION_PATH, RUNNER_TEMP, GITHUB_WORKSPACE, GITHUB_REPOSITORY, AGENT,
#         CONTEXT_FILE, MCP_CONFIG, ALLOWED_TOOLS, DISALLOWED_TOOLS, SESSION_KEY,
#         SESSION_TITLE (+ vars MCP_CONFIG references, and CLAUDE_CONFIG_DIR /
#         CLAUDE_CODE_PROJECT_DIR_NAME where Claude's sessions persist)
# Writes (to $GITHUB_OUTPUT): system_prompt_file, schema, resumed, args
set -euo pipefail

# shell-quote one value for claude_args, which claude-code-action splits like a shell
q() { jq -rn --arg v "$1" '$v | @sh'; }

sys="$RUNNER_TEMP/issue-agent-system.md"
cp "$GITHUB_ACTION_PATH/issue-prompt.md" "$sys"
if [ -n "${CONTEXT_FILE:-}" ] && [ -f "$GITHUB_WORKSPACE/$CONTEXT_FILE" ]; then
  { printf '\n\n## Repository-specific context\n\n'; cat "$GITHUB_WORKSPACE/$CONTEXT_FILE"; } >> "$sys"
fi
echo "system_prompt_file=$sys" >> "$GITHUB_OUTPUT"
echo "schema=$(jq -c . "$GITHUB_ACTION_PATH/reply-schema.json")" >> "$GITHUB_OUTPUT"

# The agent is the role; its prompt replaces Claude Code's own and the issue
# contract above is appended to it.
args="--agent $(q "$AGENT")"

# MCP servers from an inline JSON or a file (absolute or repo-relative); every
# server it names is allowed.
mcp_tools=""
if [ -n "${MCP_CONFIG:-}" ]; then
  raw="$RUNNER_TEMP/issue-agent-mcp-raw.json"
  if [ -f "$MCP_CONFIG" ]; then
    cp "$MCP_CONFIG" "$raw"
  elif [ -f "$GITHUB_WORKSPACE/$MCP_CONFIG" ]; then
    cp "$GITHUB_WORKSPACE/$MCP_CONFIG" "$raw"
  else
    printf '%s' "$MCP_CONFIG" > "$raw"
  fi
  mcp="$RUNNER_TEMP/issue-agent-mcp.json"
  envsubst < "$raw" > "$mcp"
  mcp_tools="$(jq -r '.mcpServers | keys | map("mcp__" + .) | join(",")' "$mcp")"
  args="$args --mcp-config $(q "$mcp")"
fi

allowed="${ALLOWED_TOOLS:-}"
[ -z "$mcp_tools" ] || allowed="${allowed:+$allowed,}$mcp_tools"
[ -z "$allowed" ] || args="$args --allowedTools $(q "$allowed")"
[ -z "${DISALLOWED_TOOLS:-}" ] || args="$args --disallowedTools $(q "$DISALLOWED_TOOLS")"

# A session key makes the conversation resumable: uuid5(repo + key) is the session
# ID, so where Claude's sessions persist (CLAUDE_CONFIG_DIR, as on the kubed-io
# claude runner) an existing transcript is resumed and a new one starts under
# SESSION_TITLE. Elsewhere every run starts that session fresh.
resumed=false
if [ -n "${SESSION_KEY:-}" ]; then
  id="$(python3 -c 'import sys, uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, sys.argv[1]))' \
    "https://github.com/$GITHUB_REPOSITORY#$SESSION_KEY")"
  transcript="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/${CLAUDE_CODE_PROJECT_DIR_NAME:-none}/$id.jsonl"
  if [ -f "$transcript" ]; then
    args="$args --resume $id"
    resumed=true
  else
    args="$args --session-id $id --name $(q "${SESSION_TITLE:-$SESSION_KEY}")"
  fi
fi

echo "resumed=$resumed" >> "$GITHUB_OUTPUT"
echo "args=$args" | tee -a "$GITHUB_OUTPUT"
