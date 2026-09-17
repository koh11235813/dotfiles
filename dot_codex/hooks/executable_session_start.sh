#!/bin/sh

# SessionStart hook: ロール設定を現在のセッションのコンテキストに注入する。
# stdout の平文が developer context として注入される。
# stdin を EOF まで読まないと Codex 側がハングする（openai/codex#27550）。
cat >/dev/null

# zsh の codex 関数が developer_instructions に注入済みなら二重注入しない。
[ -n "$CODEX_CUSTOM_ROLL_INJECTED" ] && exit 0

exec "$HOME/.codex/scripts/custom-roll.sh"
