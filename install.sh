#!/bin/bash
# Installs ChatStatus: builds the app, registers the Claude Code status hooks in
# ~/.claude/settings.json, and (optionally) adds a login item so it auto-starts.
#
# Idempotent: safe to re-run. Uses this directory as the source of truth, so it
# works no matter where you cloned the repo.
#
#   ./install.sh              build + register hooks + launch
#   ./install.sh --login      also add a macOS login item
#   ./install.sh --uninstall  remove hooks + login item (leaves the build)
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
HOOK="$DIR/update_status.py"
APP="$DIR/build/ChatStatus.app"
SETTINGS="$HOME/.claude/settings.json"

command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }

# --- uninstall -------------------------------------------------------------
if [[ "${1:-}" == "--uninstall" ]]; then
    if [[ -f "$SETTINGS" ]]; then
        tmp="$(mktemp)"
        jq --arg h "update_status.py" '
            .hooks |= with_entries(
                .value |= (map(.hooks |= map(select((.command // "") | contains($h) | not)))
                           | map(select(.hooks | length > 0)))
            )' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
        echo "Removed chat-status hooks from $SETTINGS"
    fi
    osascript -e 'tell application "System Events" to delete (every login item whose name is "ChatStatus")' 2>/dev/null || true
    pkill -x ChatStatus 2>/dev/null || true
    echo "Uninstalled. (Build left in place; delete $DIR/build to remove it.)"
    exit 0
fi

# --- build -----------------------------------------------------------------
./build.sh

# --- register hooks --------------------------------------------------------
# Each hook is guarded so a missing script no-ops instead of blocking Claude.
mkdir -p "$HOME/.claude"
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"

guarded() { echo "s=$HOOK; if [ -f \"\$s\" ]; then python3 \"\$s\" $1; fi"; }

tmp="$(mktemp)"
jq \
    --arg start "$(guarded live)" \
    --arg prompt "$(guarded working)" \
    --arg stop "$(guarded done)" \
    --arg end "$(guarded ended)" \
    --arg notify "$(guarded notify)" \
    --arg h "update_status.py" '
    # Drop any prior chat-status hooks first so re-running never duplicates,
    # and discard hook-groups left empty by that removal.
    def strip: map(.hooks |= map(select((.command // "") | contains($h) | not)))
             | map(select(.hooks | length > 0));
    def add($cmd): . + [{"hooks":[{"type":"command","command":$cmd,"timeout":5}]}];
    .hooks //= {}
    | .hooks.SessionStart     = ((.hooks.SessionStart // [])     | strip | add($start))
    | .hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) | strip | add($prompt))
    | .hooks.Stop             = ((.hooks.Stop // [])             | strip | add($stop))
    | .hooks.SessionEnd       = ((.hooks.SessionEnd // [])       | strip | add($end))
    | .hooks.Notification     = ((.hooks.Notification // [])     | strip | add($notify))
    ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
echo "Registered chat-status hooks in $SETTINGS"

# --- optional login item ---------------------------------------------------
if [[ "${1:-}" == "--login" ]]; then
    osascript -e 'tell application "System Events" to delete (every login item whose name is "ChatStatus")' 2>/dev/null || true
    osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$APP\", hidden:false}" >/dev/null
    echo "Added login item -> $APP"
fi

# --- (re)launch ------------------------------------------------------------
pkill -x ChatStatus 2>/dev/null || true
sleep 1
open "$APP"
echo "Launched ChatStatus. Open a new Claude Code session to see it populate."
