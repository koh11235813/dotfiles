#!/bin/sh

# UserPromptSubmit hook: モデル family ごとに prompts/by-model/<family>.md を注入する。
# family は model-state.sh が書いた ~/.claude/state/model.d/<session_id> の prefix で決める
# （"claude-opus-5[1m]" のようなサフィックスは prefix 一致で吸収する）。

PROMPT_DIR="$HOME/.claude/prompts/by-model"
SESSION_ID=$(python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("session_id") or "")
except Exception:
    print("")
' 2>/dev/null)

case "$SESSION_ID" in
    ''|*/*|.|..) MODEL= ;;
    *) MODEL=$(cat "$HOME/.claude/state/model.d/$SESSION_ID" 2>/dev/null) ;;
esac

case "$MODEL" in
    claude-fable*)  FAMILY=fable ;;
    claude-opus*)   FAMILY=opus ;;
    claude-sonnet*) FAMILY=sonnet ;;
    claude-haiku*)  FAMILY=haiku ;;
    *)              FAMILY=default ;;
esac

FILE="$PROMPT_DIR/$FAMILY.md"
[ -r "$FILE" ] || FILE="$PROMPT_DIR/default.md"
[ -r "$FILE" ] && cat "$FILE"
exit 0
