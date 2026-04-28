---
name: statusline-setup
description: Claude Code のカスタム statusline を新しいマシン・環境にセットアップする。~/.claude/statusline-command.sh を書き込み、settings.json の statusLine を設定する。
triggers:
  - "statusline を設定"
  - "statusline を再現"
  - "新しいマシンにstatusline"
  - "statusline-setup"
  - "statusline をセットアップ"
---

# statusline-setup スキル

このスキルが呼び出されたら、以下の手順を自動的に実行してください。

## 実行手順

### Step 1: statusline-command.sh を作成する

以下の内容で `/Users/kinoko/.claude/statusline-command.sh`（または `~/.claude/statusline-command.sh`）を作成してください（Write ツール使用）:

```bash
#!/bin/bash
# Claude Code statusline script
# Line 1: prompt git_branch ctx bar% model_name

input=$(cat)

# ---------- ANSI Colors ----------
GREEN=$'\e[38;2;151;201;195m'
YELLOW=$'\e[38;2;229;192;123m'
RED=$'\e[38;2;224;108;117m'
GRAY=$'\e[38;2;74;88;92m'
RESET=$'\e[0m'
# Standard ANSI colors for PROMPT display (matching zsh %F{color})
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

# ---------- Progress bar (10 segments) ----------
progress_bar() {
  local pct="$1"
  local segments="${2:-10}"
  local filled
  filled=$(awk "BEGIN{printf \"%d\", int($pct / 100 * $segments + 0.5)}" 2>/dev/null || echo 0)
  [ "$filled" -gt "$segments" ] 2>/dev/null && filled=$segments
  [ "$filled" -lt 0 ] 2>/dev/null && filled=0
  local bar=""
  for i in $(seq 1 "$segments"); do
    if [ "$i" -le "$filled" ]; then
      bar="${bar}⛝"
    else
      bar="${bar}⛶"
    fi
  done
  printf '%s' "$bar"
}

# ---------- Parse stdin (single jq call) ----------
eval "$(echo "$input" | jq -r '
  "model_name=" + (.model.display_name // "Unknown" | @sh),
  "used_pct=" + (.context_window.used_percentage // 0 | tostring),
  "rl5_pct=" + ((.rate_limits.five_hour.used_percentage // .rate_limits.five_hour.utilization // empty) | tostring),
  "rl7_pct=" + ((.rate_limits.seven_day.used_percentage // .rate_limits.seven_day.utilization // empty) | tostring)
' 2>/dev/null)"

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
prompt_display="${BLUE_P}${cwd}${RESET}"
git_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
rprompt_display=""
[ -n "$git_branch" ] && rprompt_display=" ${CYAN_P}[${git_branch}]${RESET}"

# ---------- Rate limits (line 2) ----------
line2=""
if [ -n "$rl5_pct" ] && [ -n "$rl7_pct" ]; then
  h5_int=$(printf "%.0f" "$rl5_pct" 2>/dev/null || echo 0)
  h7_int=$(printf "%.0f" "$rl7_pct" 2>/dev/null || echo 0)
  c5=$(color_for_pct "$h5_int")
  bar5=$(progress_bar "$h5_int")
  c7=$(color_for_pct "$h7_int")
  bar7=$(progress_bar "$h7_int")
  line2="${c5} 5h ${bar5} ${h5_int}%${RESET} ${c7} 7d ${bar7} ${h7_int}%${RESET}"
fi

# ---------- Output ----------
ctx_color=$(color_for_pct "$ctx_pct_int")
ctx_bar=$(progress_bar "$ctx_pct_int" 10)
printf '%s\n' "${prompt_display}${rprompt_display} ${ctx_color}ctx ${ctx_bar} ${ctx_pct_int}%${RESET} ${GREEN}${model_name}${RESET}"
[ -n "$line2" ] && printf '%s' "$line2" || printf '%s' ""
```

### Step 2: 実行権限を付与する

```bash
chmod +x ~/.claude/statusline-command.sh
```

### Step 3: settings.json を更新する

`~/.claude/settings.json` に以下の `statusLine` セクションが存在することを確認し、なければ追加してください:

```json
"statusLine": {
  "type": "command",
  "command": "~/.claude/statusline-command.sh"
}
```

settings.json の更新には `update-config` スキルを使用するか、Edit/Write ツールで直接編集してください。

### Step 4: 動作確認

以下のコマンドで動作確認してください:

```bash
# rate_limits あり（行2表示）
echo '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":25},"rate_limits":{"five_hour":{"used_percentage":22},"seven_day":{"used_percentage":30}}}' | ~/.claude/statusline-command.sh

# rate_limits なし（行1のみ）
echo '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":25}}' | ~/.claude/statusline-command.sh
```

## statusline の仕様

**表示内容:**
- **行1:** `<cwd略称> [git_branch] ctx <バー> <ctx%> <モデル名>`
- **行2:** `5h <バー> <5h%> 7d <バー> <7d%>`（rate_limits が存在する場合のみ）

**カラー設計:**
- Green: `\e[38;2;151;201;195m`（<50%）
- Yellow: `\e[38;2;229;192;123m`（50-79%）
- Red: `\e[38;2;224;108;117m`（≥80%）
- Gray: `\e[38;2;74;88;92m`（null値）
- Blue (path): `\e[34m`（標準ANSI）
- Cyan (branch): `\e[36m`（標準ANSI）

**プログレスバー:** `⛝`（filled）/ `⛶`（empty）、10セグメント

**rate_limits フィールド対応:**
- v2.1.80+ `used_percentage` と旧 `utilization` の両方をサポート
- `rate_limits` absent（API プランユーザーなど）は行2を非表示
