#!/bin/sh

ROLL_MD="$HOME/.claude/custom-roll/ojyo.md"
MARKER="<!-- custom-roll: ojyo -->"

# 1. Claudeのコンテキストに直接注入（現在のセッション）
cat "$ROLL_MD"

# 2. プロジェクトに対応するMEMORY.mdパスを決定
if [ -n "$CLAUDE_PROJECT_DIR" ]; then
    PROJECT_ENCODED=$(echo "$CLAUDE_PROJECT_DIR" | sed 's|/|-|g')
    MEMORY_DIR="$HOME/.claude/projects/${PROJECT_ENCODED}/memory"
else
    MEMORY_DIR="$HOME/.claude/projects/-home-kinoko--claude/memory"
fi

MEMORY_FILE="$MEMORY_DIR/MEMORY.md"
mkdir -p "$MEMORY_DIR"

# マーカーが未記入の場合のみMEMORY.mdに追記（重複防止）
if ! grep -q "$MARKER" "$MEMORY_FILE" 2>/dev/null; then
    printf '\n%s\n' "$MARKER" >> "$MEMORY_FILE"
    cat "$ROLL_MD" >> "$MEMORY_FILE"
fi
