#!/bin/bash
# waybar custom module: JSON output with "class" so CSS states work
# (waybar "states" only accepts integer thresholds, not regex).

BARS=5

if [[ "$(pactl get-sink-mute @DEFAULT_SINK@ 2>/dev/null)" == "Mute: yes" ]]; then
  printf '{"text":"[\U0001F507\uFE0E %s --%%]","class":"muted","percentage":0}\n' "$(printf '\u2591%.0s' $(seq $BARS))"
  exit 0
fi

vol=$(pactl get-sink-volume @DEFAULT_SINK@ | awk -F'/' '/Volume:/ {gsub(/%/, "", $2); print $2+0}' | head -1)

if [[ -z "$vol" ]]; then
  printf '{"text":"[\U0001F509\uFE0E n/a]"}\n'
  exit 0
fi

# Round to the nearest of BARS steps: (vol + step/2) / step, step = 100/BARS.
level=$(( (vol * BARS + 50) / 100 ))
if (( level > BARS )); then level=$BARS; fi
if (( level < 0 )); then level=0; fi

bar=""
for ((i=1; i<=BARS; i++)); do
  if (( i <= level )); then bar+="\u2588"; else bar+="\u2591"; fi
done
bar=$(printf "$bar")

class=""
if (( vol == 0 )); then
  class="critical"
elif (( vol <= 20 )); then
  class="warning"
fi

printf '{"text":"[\U0001F509\uFE0E %s %s%%]","class":"%s","percentage":%d}\n' "$bar" "$vol" "$class" "$vol"
