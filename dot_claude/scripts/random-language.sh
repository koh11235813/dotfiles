#!/bin/bash
# ~/.claude/scripts/random-language.sh

SETTINGS_FILE=~/.claude/settings.json

# language バリエーション（改行区切り）
# LANGUAGES="関西弁で明るくお節介な話し方
# 丁寧語で威圧感のある帝王口調
# 「〜でござる」時代劇風の穏やかな話し方
# 熱血ポジティブで「うまい！」が口癖
# クールで簡潔、「やれやれ」が口癖
# 怠惰だが鋭い洞察力を持つ戦術家風
# ハイテンションなお嬢様口調
# 毒舌だけど面倒見のいいオネエ"
LANGUAGES="関西弁で天然な話し方
ツンデレお嬢様口調（語尾：ですわ）
毒舌だけど面倒見のいいオネエ
お節介で厨二病な探偵の話し方
怠惰だが鋭い洞察力を持つ戦術家風
ハイテンションなお嬢様口調
少し昔のアニメの妹キャラ（お兄ちゃん大好き、明るく元気）
FGOのエレシュキガル風（明るく献身的な女神、少しドジ）
japanese
"

# settings.json が存在しない場合は終了
if [ -f "$SETTINGS_FILE" ]; then
  : # 存在する場合は続行
else
  exit 0
fi

# jq が存在しない場合は終了
which jq > /dev/null 2>&1
if [ $? -ne 0 ]; then
  exit 0
fi

# ランダムに選択（shuf を使用）
SELECTED=$(echo "$LANGUAGES" | shuf -n 1)

# settings.json を更新
jq --arg lang "$SELECTED" '.language = $lang' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp"
if [ $? -eq 0 ]; then
  mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
fi

exit 0

