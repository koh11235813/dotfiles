#!/bin/bash
# waybar custom module: JSON output with "percentage" so integer "states" work.

usage=$(radeontop -d - -l 1 | grep -oP 'gpu \K[0-9.]+(?=%)')

if [[ -z "$usage" ]]; then
  printf '{"text":"gpu: N/A"}\n'
  exit 0
fi

printf '{"text":"gpu: %s%%","percentage":%d}\n' "$usage" "${usage%.*}"
