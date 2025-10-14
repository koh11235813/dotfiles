#!/bin/sh
set -eu

# Hyprlandのアクティブウィンドウタイトル（null対策）
TITLE="$(hyprctl activewindow -j | jq -r '.title // ""')"

# 文字数上限（必要に応じて調整）
MAX_LEN=30

# Pango/GTKに安全な文字へエスケープ
sanitize() {
  # & < > を実体参照へ
  # （必要なら " や ' も追加できる）
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g'  \
    -e 's/>/\&gt;/g'
}

# 長すぎるときは末尾に … を付けて切る
# ※ マルチバイトで稀に文字化けすることがあるので気になれば MAX_LEN を少し増やすか後述の設定変更も併用
if [ "$(printf %s "$TITLE" | wc -m)" -gt "$MAX_LEN" ]; then
  # wc -m は文字数（マルチバイト対応）。ただし切り方は簡易的。
  CUT="$(printf %s "$TITLE" | awk -v n="$MAX_LEN" '{
    # UTF-8ざっくり切り（完全なグラフェム分割ではない）
    out=""; len=0;
    for(i=1;i<=length($0);i++){
      ch=substr($0,i,1);
      out=out ch;
      len++;
      if(len>=n) break;
    }
    print out
  }')"
  TITLE="$CUT…"
fi

sanitize "$TITLE"

