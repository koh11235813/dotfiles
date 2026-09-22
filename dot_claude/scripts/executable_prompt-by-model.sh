#!/bin/sh

# UserPromptSubmit hook: モデル family ごとに prompts/by-model/<family>.md を注入する。
# family は model-state.sh が書いた ~/.claude/state/model の prefix で決める
# （"claude-opus-5[1m]" のようなサフィックスは prefix 一致で吸収する）。

PROMPT_DIR="$HOME/.claude/prompts/by-model"
MODEL=$(cat "$HOME/.claude/state/model" 2>/dev/null)

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
