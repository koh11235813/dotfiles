#!/bin/sh

# custom-roll/ 配下の *.md から、その日のぶんを1件選んで出力する。
# zsh の codex 関数（developer_instructions）と SessionStart hook の両方から呼ぶ。
# 注入済みかどうかの判定はここに置かない（呼び出し元ごとに意味が違うため）。

ROLL_DIR="$HOME/.codex/custom-roll"
[ -d "$ROLL_DIR" ] || exit 0

ROLL_LIST=$(find "$ROLL_DIR" -maxdepth 1 -name '*.md' -type f | sort)
ROLL_COUNT=$(printf '%s\n' "$ROLL_LIST" | grep -c '.')
[ "$ROLL_COUNT" -gt 0 ] || exit 0

# 日付をシードにする。同じ日のうちは同じロールを選ぶので、resume した後に
# compact してもロールが混ざらない（#13）。日をまたぐと混ざるのは許容する。
# 改行込みで cksum に渡すと最下位ビットが日ごとにほぼ交互に反転する（730日で
# 最長20日の交互ラン）ため、printf '%s' で改行を落としてから渡す。
RAND=$(printf '%s' "$(date +%F)" | cksum | cut -d' ' -f1)
ROLL_MD=$(printf '%s\n' "$ROLL_LIST" | sed -n "$((RAND % ROLL_COUNT + 1))p")

[ -n "$ROLL_MD" ] && [ -r "$ROLL_MD" ] || exit 0
cat "$ROLL_MD"
