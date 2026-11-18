#!/bin/bash
# Installs ChatStatus: builds the app, registers the status hooks for Claude Code
# (~/.claude/settings.json) and Codex (~/.codex/hooks.json, if present), and (optionally) adds a login item so it auto-starts.
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
CODEX_HOOKS="$HOME/.codex/hooks.json"

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
    if [[ -f "$CODEX_HOOKS" ]]; then
        tmp="$(mktemp)"
        jq --arg h "update_status.py" '
            .hooks |= with_entries(
                .value |= (map(.hooks |= map(select((.command // "") | contains($h) | not)))
                           | map(select(.hooks | length > 0)))
            )' "$CODEX_HOOKS" > "$tmp" && mv "$tmp" "$CODEX_HOOKS"
        echo "Removed chat-status hooks from $CODEX_HOOKS"
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
    --arg tool "$(guarded tool)" \
    --arg tfail "$(guarded toolfail)" \
    --arg perm "$(guarded permission)" \
    --arg q "$(guarded question)" \
    --arg err "$(guarded error)" \
    --arg stop "$(guarded done)" \
    --arg end "$(guarded ended)" \
    --arg notify "$(guarded notify)" \
    --arg h "update_status.py" '
    # Drop any prior chat-status hooks first so re-running never duplicates,
    # and discard hook-groups left empty by that removal.
    def strip: map(.hooks |= map(select((.command // "") | contains($h) | not)))
             | map(select(.hooks | length > 0));
    def add($cmd): . + [{"hooks":[{"type":"command","command":$cmd,"timeout":5}]}];
    def addm($cmd; $m): . + [{"matcher": $m, "hooks":[{"type":"command","command":$cmd,"timeout":5}]}];
    .hooks //= {}
    | .hooks.SessionStart     = ((.hooks.SessionStart // [])     | strip | add($start))
    | .hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) | strip | add($prompt))
    # PostToolUse flips needs_input back to working the moment an approved tool
    # runs, instead of the card staying orange until the turn ends.
    | .hooks.PostToolUse      = ((.hooks.PostToolUse // [])      | strip | add($tool))
    # Failed tools keep a fail_streak so the app can flag a struggling chat.
    | .hooks.PostToolUseFailure = ((.hooks.PostToolUseFailure // []) | strip | add($tfail))
    # PermissionRequest carries the exact tool + arguments being asked about.
    | .hooks.PermissionRequest  = ((.hooks.PermissionRequest // [])  | strip | add($perm))
    # AskUserQuestion = Claude asked you a question (matcher scopes to that tool).
    | .hooks.PreToolUse         = ((.hooks.PreToolUse // [])         | strip | addm($q; "AskUserQuestion"))
    # StopFailure fires instead of Stop when the turn dies on an API error.
    | .hooks.StopFailure        = ((.hooks.StopFailure // [])        | strip | add($err))
    | .hooks.Stop             = ((.hooks.Stop // [])             | strip | add($stop))
    | .hooks.SessionEnd       = ((.hooks.SessionEnd // [])       | strip | add($end))
    | .hooks.Notification     = ((.hooks.Notification // [])     | strip | add($notify))
    ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
echo "Registered chat-status hooks in $SETTINGS"

# --- register Codex hooks (only when Codex is installed) --------------------
# Codex's hooks.json has the same shape as Claude's hooks block, and its
# payloads share Claude's field names, so the same script serves both; the
# extra `codex` argument tells it which agent is calling. Codex skips a new or
# changed hook until you trust it, so the first install needs one review.
if [[ -d "$HOME/.codex" ]]; then
    [[ -f "$CODEX_HOOKS" ]] || echo '{"hooks":{}}' > "$CODEX_HOOKS"
    tmp="$(mktemp)"
    jq \
        --arg start "$(guarded 'live codex')" \
        --arg prompt "$(guarded 'working codex')" \
        --arg tool "$(guarded 'tool codex')" \
        --arg perm "$(guarded 'permission codex')" \
        --arg stop "$(guarded 'done codex')" \
        --arg intr "$(guarded 'interrupt codex')" \
        --arg end "$(guarded 'ended codex')" \
        --arg h "update_status.py" '
        def strip: map(.hooks |= map(select((.command // "") | contains($h) | not)))
                 | map(select(.hooks | length > 0));
        def add($cmd; $t): . + [{"hooks":[{"type":"command","command":$cmd,"timeout":$t}]}];
        .hooks //= {}
        | .hooks.SessionStart      = ((.hooks.SessionStart // [])      | strip | add($start; 5))
        | .hooks.UserPromptSubmit  = ((.hooks.UserPromptSubmit // [])  | strip | add($prompt; 5))
        | .hooks.PostToolUse       = ((.hooks.PostToolUse // [])       | strip | add($tool; 5))
        | .hooks.PermissionRequest = ((.hooks.PermissionRequest // []) | strip | add($perm; 5))
        | .hooks.Stop              = ((.hooks.Stop // [])              | strip | add($stop; 5))
        # Codex caps Interrupt and SessionEnd hooks at 3 seconds.
        | .hooks.Interrupt         = ((.hooks.Interrupt // [])         | strip | add($intr; 3))
        | .hooks.SessionEnd        = ((.hooks.SessionEnd // [])        | strip | add($end; 3))
        ' "$CODEX_HOOKS" > "$tmp" && mv "$tmp" "$CODEX_HOOKS"
    echo "Registered chat-status hooks in $CODEX_HOOKS"
    echo "  Codex runs a hook only after you trust it: run /hooks in Codex once (or Settings > Hooks in the app)."
fi

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
