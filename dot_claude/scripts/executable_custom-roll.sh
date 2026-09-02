#!/bin/sh

# SessionStart hook: ロール設定を現在のセッションのコンテキストに注入する。
# custom-roll/ 配下の *.md から1件をランダムに選ぶ。
# MEMORY.md には書き込まない（索引としての役割を保つため）。

ROLL_DIR="$HOME/.claude/custom-roll"

#MARKER="<!-- custom-roll: imouto -->"
## 2. プロジェクトに対応するMEMORY.mdパスを決定
#if [ -n "$CLAUDE_PROJECT_DIR" ]; then
#    PROJECT_ENCODED=$(echo "$CLAUDE_PROJECT_DIR" | sed 's|/|-|g')
#    MEMORY_DIR="$HOME/.claude/projects/${PROJECT_ENCODED}/memory"
#else
#    MEMORY_DIR="$HOME/.claude/projects/-home-kinoko--claude/memory"
#fi
#MEMORY_FILE="$MEMORY_DIR/MEMORY.md"
#mkdir -p "$MEMORY_DIR"

[ -d "$ROLL_DIR" ] || exit 0

ROLL_LIST=$(find "$ROLL_DIR" -maxdepth 1 -name '*.md' -type f | sort)
ROLL_COUNT=$(printf '%s\n' "$ROLL_LIST" | grep -c '.')
[ "$ROLL_COUNT" -gt 0 ] || exit 0

# /dev/urandom から乱数を取る（awk の srand() は秒/PID 相関で偏るため使わない）
RAND=$(od -An -N4 -tu4 < /dev/urandom | tr -d ' ')
ROLL_MD=$(printf '%s\n' "$ROLL_LIST" | sed -n "$((RAND % ROLL_COUNT + 1))p")

[ -n "$ROLL_MD" ] && [ -r "$ROLL_MD" ] || exit 0

## マーカーが未記入の場合のみMEMORY.mdに追記（重複防止）
#if ! grep -q "$MARKER" "$MEMORY_FILE" 2>/dev/null; then
#    printf '\n%s\n' "$MARKER" >> "$MEMORY_FILE"
#    cat "$ROLL_MD" >> "$MEMORY_FILE"
#fi
cat "$ROLL_MD"
