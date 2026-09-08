#!/bin/sh

# SessionStart hook: ロール設定を現在のセッションのコンテキストに注入する。
# custom-roll/ 配下の *.md から1件をランダムに選ぶ。
# stdout の平文が developer context として注入される。
# stdin を EOF まで読まないと Codex 側がハングする（openai/codex#27550）。
cat >/dev/null

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
