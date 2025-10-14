#!/bin/bash

# 現在の音量（小数含む）
vol=$(pactl get-sink-volume @DEFAULT_SINK@ | awk -F'/' '/Volume:/ {gsub(/%/, "", $2); print $2+0}' | head -1)

# 音量が0の場合はMUTED表示＋critical判定用
if (( $(echo "$vol == 0" | bc -l) )); then
  echo "[🔇︎ ░░░░░░░░░░ 0%]"
  exit 0
fi

# 10段階バーに丸めて制限
level=$(echo "($vol + 0.5)/10" | bc)
if (( level > 10 )); then level=10; fi
if (( level < 0 )); then level=0; fi

# ASCIIバー作成
bar=""
for ((i=1; i<=10; i++)); do
  if (( i <= level )); then
    bar+="█"
  else
    bar+="░"
  fi
done

# 最終表示
icon="🔉︎"  # 音量アイコン

echo "[$icon $bar ${vol}%]"
