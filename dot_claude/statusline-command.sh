#!/bin/bash
# Claude Code statusline script
# Line 1: ctx bar% model_name
# Line 2:  5h bar% reset_time
# Line 3:  7d bar% reset_time

input=$(cat)

# ---------- ANSI Colors ----------
GREEN=$'\e[38;2;151;201;195m'
YELLOW=$'\e[38;2;229;192;123m'
RED=$'\e[38;2;224;108;117m'
GRAY=$'\e[38;2;74;88;92m'
RESET=$'\e[0m'
DIM=$'\e[2m'
# Standard ANSI colors for PROMPT display (matching zsh %F{color})
GREEN_P=$'\e[32m'
BLUE_P=$'\e[34m'
CYAN_P=$'\e[36m'

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

# ---------- Progress bar (Pattern 5: Braille Dots) ----------
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
eval "$(echo "$input" | jq -r '
  "model_name="      + (.model.display_name // "Unknown" | @sh),
  "used_pct="        + (.context_window.used_percentage // 0 | tostring),
  "cc_version="      + (.version // "0.0.0" | @sh),
  "FIVE_HOUR_PCT="   + (.rate_limits.five_hour.used_percentage | if type=="number" then tostring else "" end),
  "FIVE_HOUR_RESET=" + (.rate_limits.five_hour.resets_at       | if type=="number" then tostring else "" end),
  "SEVEN_DAY_PCT="   + (.rate_limits.seven_day.used_percentage  | if type=="number" then tostring else "" end),
  "SEVEN_DAY_RESET=" + (.rate_limits.seven_day.resets_at        | if type=="number" then tostring else "" end)
' 2>/dev/null)"


# ---------- Rate limit (Claude Code 2.1.80+ rate_limits field) ----------
# FIVE_HOUR_PCT / FIVE_HOUR_RESET / SEVEN_DAY_PCT / SEVEN_DAY_RESET は上の jq で設定済み

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

five_reset_display=""
if [ -n "$FIVE_HOUR_RESET" ] && [ "$FIVE_HOUR_RESET" != "0" ] && [ "$FIVE_HOUR_RESET" != "null" ]; then
  five_reset_display="Resets $(format_epoch_time "$FIVE_HOUR_RESET" "+%-I%p") (Asia/Tokyo)"
fi
seven_reset_display=""
if [ -n "$SEVEN_DAY_RESET" ] && [ "$SEVEN_DAY_RESET" != "0" ] && [ "$SEVEN_DAY_RESET" != "null" ]; then
  seven_reset_display="Resets $(format_epoch_time "$SEVEN_DAY_RESET" "+%b %-d at %-I%p") (Asia/Tokyo)"
fi

# ---------- Format context used% ----------
ctx_pct_int=0
if [ -n "$used_pct" ] && [ "$used_pct" != "null" ] && [ "$used_pct" != "0" ]; then
  ctx_pct_int=$(printf "%.0f" "$used_pct" 2>/dev/null || echo 0)
fi

# ---------- PROMPT / RPROMPT ----------
cwd_full=$(pwd | sed "s|^${HOME}|~|")
cwd_parent=$(dirname "$cwd_full")
cwd_base=$(basename "$cwd_full")
if [ "$cwd_parent" = "~" ] || [ "$cwd_parent" = "/" ] || [ "$cwd_full" = "~" ]; then
  cwd="$cwd_full"
else
  cwd="~/.../${cwd_base}"
fi
hostname_s=$(cat /etc/hostname 2>/dev/null | cut -d. -f1 || uname -n 2>/dev/null | cut -d. -f1 || echo "localhost")
# prompt_display="${GREEN_P}${USER}@${hostname_s}${RESET}:${BLUE_P}${cwd}${RESET}"
prompt_display="${BLUE_P}${cwd}${RESET}"
git_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
rprompt_display=""
[ -n "$git_branch" ] && rprompt_display=" ${CYAN_P}[${git_branch}]${RESET}"

# ---------- Line 1 (prompt + ctx + model) ----------
ctx_color=$(color_for_pct "$ctx_pct_int")
ctx_bar=$(braille_bar "$ctx_pct_int" 8)
line1="${prompt_display}${rprompt_display} ${ctx_color}ctx ${ctx_bar} ${ctx_pct_int}%${RESET} ${GREEN}${model_name}${RESET}"

# ---------- Line 2 (5h) ----------
if [ -n "$FIVE_HOUR_PCT" ]; then
  c5=$(color_for_pct "$FIVE_HOUR_PCT")
  bar5=$(braille_bar "$FIVE_HOUR_PCT" 10)
  pct5=$(printf "%.0f" "$FIVE_HOUR_PCT" 2>/dev/null || echo "--")
  line2="${c5} 5h ${bar5} ${pct5}%${RESET}"
  [ -n "$five_reset_display" ] && line2+=" ${DIM}${five_reset_display}${RESET}"
else
  line2="${GRAY} 5h           --% ${RESET}"
fi

# ---------- Line 3 (7d) ----------
if [ -n "$SEVEN_DAY_PCT" ]; then
  c7=$(color_for_pct "$SEVEN_DAY_PCT")
  bar7=$(braille_bar "$SEVEN_DAY_PCT" 10)
  pct7=$(printf "%.0f" "$SEVEN_DAY_PCT" 2>/dev/null || echo "--")
  line3="${c7} 7d ${bar7} ${pct7}%${RESET}"
  [ -n "$seven_reset_display" ] && line3+=" ${DIM}${seven_reset_display}${RESET}"
else
  line3="${GRAY} 7d           --% ${RESET}"
fi

# ---------- Output ----------
printf '%s\n' "$line1"
printf '%s\n' "$line2"
printf '%s' "$line3"
