#!/bin/sh

# SessionEnd hook: model-state.sh が書いた、このセッションの state ファイルを消す。

SESSION_ID=$(python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("session_id") or "")
except Exception:
    print("")
' 2>/dev/null)

case "$SESSION_ID" in
    ''|*/*|.|..) exit 0 ;;
esac

rm -f "$HOME/.claude/state/model.d/$SESSION_ID"
exit 0
