#!/bin/sh

# custom-roll/ 配下の *.md から1件をランダムに選んで出力する。
# zsh の codex 関数（developer_instructions）と SessionStart hook の両方から呼ぶ。
# 注入済みかどうかの判定はここに置かない（呼び出し元ごとに意味が違うため）。

ROLL_DIR="$HOME/.codex/custom-roll"
[ -d "$ROLL_DIR" ] || exit 0

ROLL_LIST=$(find "$ROLL_DIR" -maxdepth 1 -name '*.md' -type f | sort)
ROLL_COUNT=$(printf '%s\n' "$ROLL_LIST" | grep -c '.')
[ "$ROLL_COUNT" -gt 0 ] || exit 0

# /dev/urandom から乱数を取る（awk の srand() は秒/PID 相関で偏るため使わない）
RAND=$(od -An -N4 -tu4 < /dev/urandom | tr -d ' ')
ROLL_MD=$(printf '%s\n' "$ROLL_LIST" | sed -n "$((RAND % ROLL_COUNT + 1))p")

[ -n "$ROLL_MD" ] && [ -r "$ROLL_MD" ] || exit 0
cat "$ROLL_MD"
