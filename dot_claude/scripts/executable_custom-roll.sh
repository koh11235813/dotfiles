#!/bin/sh

# SessionStart hook: ロール設定を現在のセッションのコンテキストに注入する。
# MEMORY.md には書き込まない（索引としての役割を保つため）。

ROLL_MD="$HOME/.claude/custom-roll/imouto.md"

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

[ -r "$ROLL_MD" ] || exit 0

## マーカーが未記入の場合のみMEMORY.mdに追記（重複防止）
#if ! grep -q "$MARKER" "$MEMORY_FILE" 2>/dev/null; then
#    printf '\n%s\n' "$MARKER" >> "$MEMORY_FILE"
#    cat "$ROLL_MD" >> "$MEMORY_FILE"
#fi
cat "$ROLL_MD"
