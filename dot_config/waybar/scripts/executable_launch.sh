#!/bin/sh
# Pick the waybar config for the running compositor (both set these at session start).
dir="${XDG_CONFIG_HOME:-$HOME/.config}/waybar"
if [ -n "$HYPRLAND_INSTANCE_SIGNATURE" ]; then
  wm=hyprland
elif [ -n "$NIRI_SOCKET" ]; then
  wm=niri
else
  echo "launch.sh: unknown compositor (HYPRLAND_INSTANCE_SIGNATURE/NIRI_SOCKET unset)" >&2
  exit 1
fi
exec waybar -c "$dir/config-$wm" -s "$dir/style.css"
