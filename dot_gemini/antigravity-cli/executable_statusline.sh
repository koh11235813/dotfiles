#!/bin/bash
# antigravity-cli (agy) statusline script
# settings.json の statusLine.stack_with_default=true で、既定行（モデル名・effort）の下に出る
# Line 1: ctx bar% tokens tps
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
# Gemini 以外（Claude, GPT-OSS）は 3p 側を消費する。
# Orchestrator 系は .model.id に表示名が入るため、transcript 側の実モデル名も参照できるよう別々に抜く
used_pct="" in_tokens="" out_tokens="" agent_state="" model_id="" conversation_id="" transcript_path=""
GEM_5H_PCT="" GEM_5H_RESET="" GEM_7D_PCT="" GEM_7D_RESET=""
TP_5H_PCT="" TP_5H_RESET="" TP_7D_PCT="" TP_7D_RESET=""
FIVE_HOUR_PCT="" FIVE_HOUR_RESET="" WEEKLY_PCT="" WEEKLY_RESET=""
eval "$(printf '%s' "$input" | jq -r '
  def used(q): if (q.remaining_fraction | type) == "number" then ((1 - q.remaining_fraction) * 100 | tostring) else "" end;
  def reset(q): if (q.reset_time | type) == "string" then (try (q.reset_time | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | tostring) catch "") else "" end;
  (.quota // {}) as $q
  | "used_pct="        + (.context_window.used_percentage // "" | tostring | @sh),
    "in_tokens="       + (.context_window.total_input_tokens // "" | tostring | @sh),
    "out_tokens="      + (.context_window.total_output_tokens // "" | tostring | @sh),
    "agent_state="     + (.agent_state // "" | tostring | @sh),
    "model_id="        + (.model.id // "" | tostring | @sh),
    "conversation_id=" + (.conversation_id // "" | tostring | @sh),
    "transcript_path=" + (.transcript_path // "" | tostring | @sh),
    "GEM_5H_PCT="      + (used($q["gemini-5h"]) | @sh),
    "GEM_5H_RESET="    + (reset($q["gemini-5h"]) | @sh),
    "GEM_7D_PCT="      + (used($q["gemini-weekly"]) | @sh),
    "GEM_7D_RESET="    + (reset($q["gemini-weekly"]) | @sh),
    "TP_5H_PCT="       + (used($q["3p-5h"]) | @sh),
    "TP_5H_RESET="     + (reset($q["3p-5h"]) | @sh),
    "TP_7D_PCT="       + (used($q["3p-weekly"]) | @sh),
    "TP_7D_RESET="     + (reset($q["3p-weekly"]) | @sh)
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

# ---------- Read tps state and transcript (when needed) ----------
# agy は statusline を sh -c で起動し、sh がそのまま exec するため、$PPID でプロセスごとに状態ファイルを分けられる
tps_state="${TMPDIR:-/tmp}/agy-statusline-tps.$PPID"
prev_t="" prev_out="" prev_state="" prev_tps="" prev_step=""
[ -f "$tps_state" ] && read -r prev_t prev_out prev_state prev_tps prev_step < "$tps_state"

# .model.id からプールを暫定判定する。モデル切替直後に前モデルの transcript へ引っ張られないよう 3p 判定を優先する
pool=""
shopt -s nocasematch
if [[ "$model_id" =~ (claude|gpt|opus|sonnet|haiku) ]]; then
  pool="3p"
elif [[ "$model_id" =~ ^gemini ]]; then
  pool="gemini"
fi

# 300ms スロットルごとの余計な I/O を避けるため、プール未確定または出力 token が増えたときだけ transcript を読む
need_transcript=0
[ -z "$pool" ] && need_transcript=1
if [ -n "$out_tokens" ] && [ -n "$prev_out" ] && [ "$out_tokens" -gt "$prev_out" ] 2>/dev/null; then
  need_transcript=1
fi

tr_step="" tr_start="" tr_out="" tr_model=""
if [ "$need_transcript" -eq 1 ]; then
  # agy が .transcript_path に antigravity 側を渡し、antigravity-cli の実体が見つからないことがあるため、conversation_id から補完する
  if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
    case "$conversation_id" in
      ""|*/*|*..*) ;;
      *)
        cli_tr="$HOME/.gemini/antigravity-cli/brain/$conversation_id/.system_generated/logs/transcript.jsonl"
        [ -f "$cli_tr" ] && transcript_path="$cli_tr"
        ;;
    esac
  fi
  if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
    eval "$(tail -n 50 "$transcript_path" 2>/dev/null | jq -nRr '
      [inputs | fromjson? | select((.output_tokens // 0) > 0 and (.created_at | type) == "string")]
      | last // empty
      | "tr_step="  + (.step_index // "" | tostring | @sh),
        "tr_start=" + (try (.created_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | tostring) catch "" | @sh),
        "tr_out="   + (.output_tokens // 0 | tostring | @sh),
        "tr_model=" + (.model // "" | @sh)
    ' 2>/dev/null)"
  fi
fi

if [ -z "$pool" ]; then
  if [ -n "$tr_model" ]; then
    if [[ "$tr_model" =~ ^gemini ]]; then
      pool="gemini"
    else
      pool="3p"
    fi
  elif [[ "$model_id" =~ ^orchestrator ]]; then
    pool="gemini"
  else
    pool="3p"
  fi
fi
shopt -u nocasematch

if [ "$pool" = "gemini" ]; then
  FIVE_HOUR_PCT="$GEM_5H_PCT"
  FIVE_HOUR_RESET="$GEM_5H_RESET"
  WEEKLY_PCT="$GEM_7D_PCT"
  WEEKLY_RESET="$GEM_7D_RESET"
else
  FIVE_HOUR_PCT="$TP_5H_PCT"
  FIVE_HOUR_RESET="$TP_5H_RESET"
  WEEKLY_PCT="$TP_7D_PCT"
  WEEKLY_RESET="$TP_7D_RESET"
fi

# ---------- Tokens per second ----------
# agy は約 300ms 間隔で呼び出すうえに自動承認ツール実行中も agent_state が working のままになる。
# 300ms ごとに開始時刻を上書きして桁が跳ね上がるのを防ぎ、ツール実行時間が計測へ混ざらないよう、
# transcript の直近応答（created_at / output_tokens）を優先して tps を算出し、未記録時のみ working 開始時刻で補う
tps=""
if [ -n "$out_tokens" ]; then
  now=$(date +%s.%N)
  next_start="" next_step=""
  read -r next_start tps next_step <<EOF
$(awk \
  -v now="$now" \
  -v out="$out_tokens" \
  -v state="$agent_state" \
  -v pt="$prev_t" \
  -v po="$prev_out" \
  -v ps="$prev_state" \
  -v old="$prev_tps" \
  -v pstep="$prev_step" \
  -v tstep="$tr_step" \
  -v tstart="$tr_start" \
  -v tout="$tr_out" '
BEGIN {
  old_tps = (old == "" || old == "-") ? "" : old
  prev_st = (pt == "" || pt == "-") ? 0 : pt + 0
  prev_step = (pstep == "" || pstep == "-") ? "" : pstep
  has_prev = (po != "" && po != "-")
  out_n = out + 0
  po_n = has_prev ? po + 0 : 0
  now_n = now + 0
  tstart_n = (tstart != "") ? tstart + 0 : 0
  tout_n = (tout != "") ? tout + 0 : 0

  if (!has_prev || out_n < po_n) {
    next_tps = ""
    next_start = now
    next_step = (tstep != "") ? tstep : ""
  } else if (out_n > po_n) {
    if (tstep != "" && tstep != prev_step && tstart_n > 0 && tout_n > 0 && now_n > tstart_n) {
      eff_start = (ps == "working" && prev_st > tstart_n && prev_st < tstart_n + 1) ? prev_st : tstart_n
      next_tps = sprintf("%d", tout_n / (now_n - eff_start) + 0.5)
      next_step = tstep
    } else if (ps == "working" && prev_st > 0 && now_n > prev_st) {
      next_tps = sprintf("%d", (out_n - po_n) / (now_n - prev_st) + 0.5)
      next_step = prev_step
    } else {
      next_tps = old_tps
      next_step = prev_step
    }
    next_start = now
  } else {
    next_tps = old_tps
    next_step = prev_step
    if (state == "working" && ps == "working" && prev_st > 0) {
      next_start = pt
    } else {
      next_start = now
    }
  }
  printf "%s %s %s\n", next_start, (next_tps == "" ? "-" : next_tps), (next_step == "" ? "-" : next_step)
}')
EOF
  [ "$tps" = "-" ] && tps=""
  [ "$next_step" = "-" ] && next_step=""
  # 空欄のまま書くと次回 read で列がずれるため、空の値は "-" に揃える
  printf '%s %s %s %s %s\n' "${next_start:--}" "$out_tokens" "${agent_state:--}" "${tps:--}" "${next_step:--}" > "$tps_state.$$" && mv -f "$tps_state.$$" "$tps_state"
fi

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
line1+=" ${DIM}tok ↑$(format_tokens "$in_tokens") ↓$(format_tokens "$out_tokens")"
[ -n "$tps" ] && line1+=" ${tps}tps"
line1+="${RESET}"

# ---------- Line 2 (5h + weekly) ----------
line2="$(quota_segment " 5h" "$FIVE_HOUR_PCT" "$FIVE_HOUR_RESET" "+%-I%p")"
line2+="  $(quota_segment "7d" "$WEEKLY_PCT" "$WEEKLY_RESET" "+%b %-d at %-I%p")"
[ -n "$FIVE_HOUR_RESET$WEEKLY_RESET" ] && line2+=" ${DIM}(Asia/Tokyo)${RESET}"

# ---------- Output ----------
printf '%s\n' "$line1"
printf '%s' "$line2"
exit 0
