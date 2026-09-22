#!/bin/sh

# SessionStart / PostModelSwitch hook: 現在のモデル ID を state ファイルに書く。
# UserPromptSubmit hook の stdin にはモデル名が入らないので、
# prompt-by-model.sh はここで書いたファイルを読む。

STATE_DIR="$HOME/.claude/state"
STATE_FILE="$STATE_DIR/model"
mkdir -p "$STATE_DIR"

MODEL=$(python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print(d.get("to_model") or d.get("model") or "")
' 2>/dev/null)

# hook 入力に無ければ settings.json の model キーを使う
if [ -z "$MODEL" ] && [ -r "$HOME/.claude/settings.json" ]; then
    MODEL=$(python3 -c '
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("model") or "")
except Exception:
    print("")
' "$HOME/.claude/settings.json" 2>/dev/null)
fi

[ -n "$MODEL" ] || exit 0
printf '%s\n' "$MODEL" > "$STATE_FILE"
