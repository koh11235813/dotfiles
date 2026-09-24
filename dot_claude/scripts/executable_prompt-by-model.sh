#!/bin/sh

# UserPromptSubmit hook: モデルごとに prompts/by-model/ の断片を注入する。
# default.md → <family>.md → <version>.md の順に、存在するものを全部つなげて出す。
#   claude-opus-5-5[1m] → default.md + opus.md + opus-5-5.md
# opus-5.md は opus-5-5 に継承させない。版ごとに挙動の向きが逆の項目があるため
# （Opus 5 は委譲過多、Opus 5.5 は並列委譲が得意）、共通にしたいものだけ <family>.md に置く。
# モデル名は model-state.sh が書いた ~/.claude/state/model.d/<session_id> から読む。

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

MODEL=${MODEL%%\[*}
VERSION=${MODEL#claude-}
FAMILY=${VERSION%%-*}

[ -r "$PROMPT_DIR/default.md" ] && cat "$PROMPT_DIR/default.md"
case "$MODEL" in
    */*|*..*) ;;
    claude-?*)
        [ -r "$PROMPT_DIR/$FAMILY.md" ] && cat "$PROMPT_DIR/$FAMILY.md"
        [ "$VERSION" != "$FAMILY" ] && [ -r "$PROMPT_DIR/$VERSION.md" ] && cat "$PROMPT_DIR/$VERSION.md"
        ;;
esac
exit 0
