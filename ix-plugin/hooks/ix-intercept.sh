#!/usr/bin/env bash
# ix-intercept.sh — PreToolUse hook for Grep and Glob
#
# Fires before Grep/Glob executes. Runs the ix equivalent silently and injects
# the result as additionalContext so Claude already has a graph-aware, token-
# efficient answer before the native tool runs.
#
# Exit 0 + JSON stdout → injects additionalContext, native tool still runs
# Exit 0 + no stdout  → no-op, native tool runs normally

set -euo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ -z "$TOOL" ] && exit 0

# Bail silently if ix is not in PATH
command -v ix >/dev/null 2>&1 || exit 0

# ── Health check with 30s TTL cache ─────────────────────────────────────────
IX_HEALTH_CACHE="${TMPDIR:-/tmp}/ix-healthy"
_now=$(date +%s)
_cache_ok=0
if [ -f "$IX_HEALTH_CACHE" ]; then
  _cached=$(cat "$IX_HEALTH_CACHE" 2>/dev/null || echo 0)
  (( (_now - _cached) < 30 )) && _cache_ok=1
fi
if [ "$_cache_ok" -eq 0 ]; then
  ix status >/dev/null 2>&1 || exit 0
  echo "$_now" > "$IX_HEALTH_CACHE"
fi

# ── Grep: text/symbol search ─────────────────────────────────────────────────
if [ "$TOOL" = "Grep" ]; then
  PATTERN=$(echo "$INPUT" | jq -r '.tool_input.pattern // empty')
  [ -z "$PATTERN" ] && exit 0

  PATH_ARG=$(echo "$INPUT" | jq -r '.tool_input.path // empty')
  LANG_ARG=$(echo "$INPUT" | jq -r '.tool_input.type // empty')

  TEXT_ARGS=("$PATTERN" "--limit" "20" "--format" "json")
  [ -n "$PATH_ARG" ] && TEXT_ARGS+=("--path" "$PATH_ARG")
  [ -n "$LANG_ARG" ] && TEXT_ARGS+=("--language" "$LANG_ARG")

  # Run ix text and ix locate in parallel
  _text_tmp=$(mktemp)
  _locate_tmp=$(mktemp)
  trap 'rm -f "$_text_tmp" "$_locate_tmp"' EXIT

  ix text "${TEXT_ARGS[@]}" > "$_text_tmp" 2>/dev/null &
  _text_pid=$!
  ix locate "$PATTERN" --limit 10 --format json > "$_locate_tmp" 2>/dev/null &
  _locate_pid=$!

  wait "$_text_pid" || true
  wait "$_locate_pid" || true

  TEXT_RESULT=$(cat "$_text_tmp")
  LOCATE_RESULT=$(cat "$_locate_tmp")

  [ -z "$TEXT_RESULT" ] && [ -z "$LOCATE_RESULT" ] && exit 0

  CONTEXT="[ix] Pre-search results for pattern: '${PATTERN}'"
  [ -n "$TEXT_RESULT" ]   && CONTEXT="${CONTEXT}\n\n--- ix text ---\n${TEXT_RESULT}"
  [ -n "$LOCATE_RESULT" ] && CONTEXT="${CONTEXT}\n\n--- ix locate ---\n${LOCATE_RESULT}"

# ── Glob: file pattern search ─────────────────────────────────────────────────
elif [ "$TOOL" = "Glob" ]; then
  PATTERN=$(echo "$INPUT" | jq -r '.tool_input.pattern // empty')
  [ -z "$PATTERN" ] && exit 0

  PATH_ARG=$(echo "$INPUT" | jq -r '.tool_input.path // empty')

  INV_ARGS=("--format" "json")
  [ -n "$PATH_ARG" ] && INV_ARGS+=("--path" "$PATH_ARG")

  INV_RESULT=$(ix inventory "${INV_ARGS[@]}" 2>/dev/null) || INV_RESULT=""

  [ -z "$INV_RESULT" ] && exit 0

  CONTEXT="[ix] Pre-search inventory for glob: '${PATTERN}'"
  [ -n "$PATH_ARG" ] && CONTEXT="${CONTEXT} (path: ${PATH_ARG})"
  CONTEXT="${CONTEXT}\n\n--- ix inventory ---\n${INV_RESULT}"

else
  exit 0
fi

[ -z "$CONTEXT" ] && exit 0

jq -n --arg ctx "$CONTEXT" '{"additionalContext": $ctx}'
exit 0
