#!/bin/bash
# waybar custom module: JSON output with "class" so CSS states work
# (waybar "states" only accepts integer thresholds, not regex).

vol=$(pactl get-sink-volume @DEFAULT_SINK@ | awk -F'/' '/Volume:/ {gsub(/%/, "", $2); print $2+0}' | head -1)

if (( $(echo "$vol == 0" | bc -l) )); then
  printf '{"text":"[🔇︎ ░░░░░░░░░░ 0%%]","class":"critical","percentage":0}\n'
  exit 0
fi

level=$(echo "($vol + 0.5)/10" | bc)
if (( level > 10 )); then level=10; fi
if (( level < 0 )); then level=0; fi

bar=""
for ((i=1; i<=10; i++)); do
  if (( i <= level )); then bar+="█"; else bar+="░"; fi
done

class=""
if (( $(echo "$vol <= 20" | bc -l) )); then class="warning"; fi

printf '{"text":"[🔉︎ %s %s%%]","class":"%s","percentage":%d}\n' "$bar" "$vol" "$class" "${vol%.*}"
