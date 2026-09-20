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
# cksum（CRC32）は使わない。CRC は線形なので、連続する日付文字列の差分
# （末尾1〜2文字）が毎回ほぼ同じビットパターンとして出力に写り、下位ビットが
# 隣接日で強く相関する。730日の実測で「翌日も同じロール」が 2件時 69.8%
# （期待50%）、4件時 58.8%（期待25%）と、数日同じ口調が続く挙動になっていた。
# sha256sum は雪崩効果があるので先頭8hexを取るだけで相関が消える（実測25.8%）。
#
# なお RAND % ROLL_COUNT は下位 log2(ROLL_COUNT) ビットしか使わないため、
# custom-roll/ の件数を増やすとシードに要求される質が変わる。追加したら
# 730日ぶんの分布と「翌日同じ」率を実測すること:
#   for d in $(seq 0 729); do date -d "2026-01-01 +$d days" +%F; done \
#     | while read -r x; do printf '%d\n' "0x$(printf '%s' "$x" | sha256sum | cut -c1-8)"; done \
#     | awk -v n=4 '{i=$1%n;c[i]++;if(NR>1&&i==p)s++;p=i} END{print s/(NR-1); for(k=0;k<n;k++) print k,c[k]}'
# sha256sum は GNU coreutils で macOS には無いため shasum(-a 256) にフォールバックする。
RAND=$((0x$(printf '%s' "$(date +%F)" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-8)))
ROLL_MD=$(printf '%s\n' "$ROLL_LIST" | sed -n "$((RAND % ROLL_COUNT + 1))p")

[ -n "$ROLL_MD" ] && [ -r "$ROLL_MD" ] || exit 0
cat "$ROLL_MD"
