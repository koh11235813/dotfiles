#!/bin/bash
# waybar custom module: screen backlight as an ASCII bar, same shape as volume_ascii.sh.
# -e4 matches niri's XF86MonBrightness binds, so the bar tracks what the keys actually do
# (the native `backlight` module reports the linear value and would disagree).

DEVICE=acpi_video0
BARS=5

pct=$(brightnessctl -d "$DEVICE" -e4 -m 2>/dev/null | cut -d, -f4 | tr -d '%')

if [[ -z "$pct" ]]; then
  printf '{"text":"[\U0001F506\uFE0E n/a]"}\n'
  exit 0
fi

level=$(( (pct * BARS + 50) / 100 ))
if (( level > BARS )); then level=$BARS; fi
if (( level < 0 )); then level=0; fi

bar=""
for ((i=1; i<=BARS; i++)); do
  if (( i <= level )); then bar+="\u2588"; else bar+="\u2591"; fi
done
bar=$(printf "$bar")

printf '{"text":"[\U0001F506\uFE0E %s %s%%]","percentage":%d}\n' "$bar" "$pct" "$pct"
