#!/bin/sh

# SessionStart / PostModelSwitch hook: 現在のモデル ID を session ごとの state ファイルに書く。
# UserPromptSubmit hook の stdin にはモデル名が入らないので、
# prompt-by-model.sh はここで書いたファイルを読む。
# 1枚のファイルを共有すると並列セッションのモデルが混ざるので、session_id で分ける。

STATE_DIR="$HOME/.claude/state/model.d"

# 1行目 session_id、2行目モデル名
INPUT=$(python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print(d.get("session_id") or "")
print(d.get("to_model") or d.get("model") or "")
' 2>/dev/null)
SESSION_ID=$(printf '%s\n' "$INPUT" | sed -n 1p)
MODEL=$(printf '%s\n' "$INPUT" | sed -n 2p)

case "$SESSION_ID" in
    ''|*/*|.|..) exit 0 ;;
esac

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
mkdir -p "$STATE_DIR"
printf '%s\n' "$MODEL" > "$STATE_DIR/$SESSION_ID"

# SessionEnd が走らずに残ったファイル（クラッシュ等）を掃除する
find "$STATE_DIR" -type f -mtime +7 -delete 2>/dev/null
exit 0
