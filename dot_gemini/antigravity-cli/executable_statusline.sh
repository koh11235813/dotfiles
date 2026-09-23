#!/bin/bash
# antigravity-cli (agy) statusline script
# settings.json の statusLine.stack_with_default=true で、既定行（モデル名・effort）の下に出る
# Line 1: ctx bar% tokens
# Line 2: 5h bar% reset_time  7d bar% reset_time
#
# agy は非ゼロ終了を 30 回続けると statusline を自動で無効化するので、何があっても exit 0 で終わる

input=$(cat)

# ---------- ANSI Colors ----------
GREEN=$'\e[38;2;151;201;195m'
YELLOW=$'\e[38;2;229;192;123m'
RED=$'\e[38;2;224;108;117m'
GRAY=$'\e[38;2;74;88;92m'
RESET=$'\e[0m'
DIM=$'\e[2m'

# ---------- Color by percentage ----------
color_for_pct() {
  local pct="$1"
  if [ -z "$pct" ] || [ "$pct" = "null" ]; then
    printf '%s' "$GRAY"
    return
  fi
  local ipct
  ipct=$(printf "%.0f" "$pct" 2>/dev/null || echo "0")
  if [ "$ipct" -ge 80 ]; then
    printf '%s' "$RED"
  elif [ "$ipct" -ge 50 ]; then
    printf '%s' "$YELLOW"
  else
    printf '%s' "$GREEN"
  fi
}

# ---------- Progress bar (Braille Dots) ----------
# chars[0]=' ' chars[1..7]=⣀⣄⣤⣦⣶⣷⣿
braille_bar() {
  local pct="$1"
  local width="${2:-8}"
  local chars=(' ' '⣀' '⣄' '⣤' '⣦' '⣶' '⣷' '⣿')
  local indices bar=""
  indices=$(awk -v pct="$pct" -v w="$width" 'BEGIN {
    level = pct / 100
    for (i = 0; i < w; i++) {
      seg_start = i / w; seg_end = (i + 1) / w
      if (level >= seg_end)        { printf "7 " }
      else if (level <= seg_start) { printf "0 " }
      else {
        frac = (level - seg_start) / (seg_end - seg_start)
        idx = int(frac * 7); if (idx > 7) idx = 7
        printf "%d ", idx
      }
    }
  }' 2>/dev/null)
  for idx in $indices; do
    bar="${bar}${chars[$idx]}"
  done
  printf '%s' "$bar"
}

# ---------- Parse stdin (single jq call) ----------
# quota は "gemini-5h" / "gemini-weekly" / "3p-5h" / "3p-weekly" のマップで、
# Gemini 以外（Claude, GPT-OSS）は 3p 側を消費する
used_pct="" in_tokens="" out_tokens=""
FIVE_HOUR_PCT="" FIVE_HOUR_RESET="" WEEKLY_PCT="" WEEKLY_RESET=""
eval "$(printf '%s' "$input" | jq -r '
  def used(q): if (q.remaining_fraction | type) == "number" then ((1 - q.remaining_fraction) * 100 | tostring) else "" end;
  def reset(q): if (q.reset_time | type) == "string" then (q.reset_time | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | tostring) else "" end;
  (if ((.model.id // "") | test("^gemini"; "i")) then "gemini" else "3p" end) as $pool
  | (.quota // {}) as $q
  | "used_pct="        + (.context_window.used_percentage // "" | tostring),
    "in_tokens="       + (.context_window.total_input_tokens // "" | tostring),
    "out_tokens="      + (.context_window.total_output_tokens // "" | tostring),
    "FIVE_HOUR_PCT="   + used($q[$pool + "-5h"]),
    "FIVE_HOUR_RESET=" + reset($q[$pool + "-5h"]),
    "WEEKLY_PCT="      + used($q[$pool + "-weekly"]),
    "WEEKLY_RESET="    + reset($q[$pool + "-weekly"])
' 2>/dev/null)"

# ---------- Format reset time (from epoch seconds) ----------
format_epoch_time() {
  local epoch="$1"
  local format="$2"
  [ -z "$epoch" ] || [ "$epoch" = "0" ] && echo "" && return
  local result
  result=$(TZ="Asia/Tokyo" date -j -f "%s" "$epoch" "$format" 2>/dev/null || \
           TZ="Asia/Tokyo" date -d "@${epoch}" "$format" 2>/dev/null || echo "")
  echo "$result" | sed 's/AM/am/;s/PM/pm/'
}

# ---------- Format token count (105330 -> 105.3k) ----------
format_tokens() {
  local n="$1"
  [ -z "$n" ] && echo "--" && return
  awk -v n="$n" 'BEGIN {
    if (n >= 1000000)   printf "%.1fM", n / 1000000
    else if (n >= 1000) printf "%.1fk", n / 1000
    else                printf "%d", n
  }'
}

# ---------- quota segment ----------
quota_segment() {
  local label="$1" pct="$2" reset="$3" reset_format="$4"
  if [ -z "$pct" ]; then
    printf '%s' "${GRAY}${label}           --% ${RESET}"
    return
  fi
  local color bar ipct seg
  color=$(color_for_pct "$pct")
  bar=$(braille_bar "$pct" 10)
  ipct=$(printf "%.0f" "$pct" 2>/dev/null || echo "--")
  seg="${color}${label} ${bar} ${ipct}%${RESET}"
  [ -n "$reset" ] && seg+=" ${DIM}Resets $(format_epoch_time "$reset" "$reset_format")${RESET}"
  printf '%s' "$seg"
}

# ---------- Line 1 (ctx + tokens) ----------
if [ -n "$used_pct" ]; then
  ctx_pct_int=$(printf "%.0f" "$used_pct" 2>/dev/null || echo 0)
  ctx_color=$(color_for_pct "$ctx_pct_int")
  ctx_bar=$(braille_bar "$ctx_pct_int" 8)
  line1="${ctx_color}ctx ${ctx_bar} ${ctx_pct_int}%${RESET}"
else
  line1="${GRAY}ctx         --%${RESET}"
fi
line1+=" ${DIM}tok ↑$(format_tokens "$in_tokens") ↓$(format_tokens "$out_tokens")${RESET}"

# ---------- Line 2 (5h + weekly) ----------
line2="$(quota_segment " 5h" "$FIVE_HOUR_PCT" "$FIVE_HOUR_RESET" "+%-I%p")"
line2+="  $(quota_segment "7d" "$WEEKLY_PCT" "$WEEKLY_RESET" "+%b %-d at %-I%p")"
[ -n "$FIVE_HOUR_RESET$WEEKLY_RESET" ] && line2+=" ${DIM}(Asia/Tokyo)${RESET}"

# ---------- Output ----------
printf '%s\n' "$line1"
printf '%s' "$line2"
exit 0
