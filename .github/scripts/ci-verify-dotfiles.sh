#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
H="$REPO_ROOT/.claude/skills/verify-dotfiles/verify-dotfiles.sh"
CHECK_JSON="$REPO_ROOT/.github/scripts/check_json.py"

TMP_EVIDENCE=""
if [[ -z ${VERIFY_DOTFILES_EVIDENCE:-} ]]; then
  TMP_EVIDENCE=$(mktemp -d "${TMPDIR:-/tmp}/ci-verify-evidence.XXXXXX")
  export VERIFY_DOTFILES_EVIDENCE="$TMP_EVIDENCE"
fi

ACTIVE_RUN_ID=""
cleanup_all() {
  if [[ -n $ACTIVE_RUN_ID ]]; then
    "$H" cleanup "$ACTIVE_RUN_ID" >/dev/null 2>&1 || true
    ACTIVE_RUN_ID=""
  fi
  if [[ -n $TMP_EVIDENCE ]]; then
    rm -rf "$TMP_EVIDENCE"
  fi
}
trap cleanup_all EXIT

# 1. Host ignore matrix + rendered JSON/JSONC/JSONL schema check across all 4 hosts.
while IFS='|' read -r host present absent; do
  eval "$("$H" launch --host "$host")"
  ACTIVE_RUN_ID="$RUN_ID"
  "$H" doctor "$RUN_ID" > "$EVIDENCE/doctor.txt"
  "$H" capture "$RUN_ID" managed -- "$H" chez "$RUN_ID" managed --include=files
  for d in $present; do
    [[ -n $(find "$SCRATCH_HOME/.config/$d" -type f | head -1) ]] || { echo "$host: .config/$d missing" >&2; exit 1; }
  done
  for d in $absent zed; do
    [[ ! -e "$SCRATCH_HOME/.config/$d" ]] || { echo "$host: .config/$d should be absent" >&2; exit 1; }
    ! grep -q "^\.config/$d/" "$EVIDENCE/managed.out" || { echo "$host: .config/$d is managed" >&2; exit 1; }
  done
  [[ ! -e "$SCRATCH_HOME/LICENSE" ]] || { echo "$host: LICENSE rendered" >&2; exit 1; }
  [[ -f "$SCRATCH_HOME/.claude/settings.json" ]] || { echo "$host: no claude settings" >&2; exit 1; }
  python3 "$CHECK_JSON" --rendered-root "$SCRATCH_HOME"
  echo "PASS host-ignore-matrix ($host)"
  "$H" cleanup "$RUN_ID" >/dev/null
  ACTIVE_RUN_ID=""
done <<'HOSTS'
Arch|hypr kitty mako systemd wallpaper waybar|niri
Lab-Arch||hypr kitty mako niri systemd wallpaper waybar
other|kitty niri systemd waybar|hypr mako wallpaper
darwin|kitty|hypr mako niri systemd wallpaper waybar
HOSTS

# 2. Claude hooks: test_ng_check.py + hook wiring + model-state chain.
eval "$("$H" launch)"
ACTIVE_RUN_ID="$RUN_ID"
"$H" doctor "$RUN_ID" > "$EVIDENCE/doctor.txt"
S="$SCRATCH_HOME/.claude/settings.json"
cat > "$EVIDENCE/hook.sh" <<'RUNNER'
#!/usr/bin/env bash
cmd=$(python3 - "$1" "$2" "$3" <<'PY'
import json, sys
groups = json.load(open(sys.argv[1]))["hooks"][sys.argv[2]]
print(next(h["command"] for g in groups for h in g["hooks"] if sys.argv[3] in h["command"]))
PY
)
printf '%s' "$4" | sh -c "$cmd"
RUNNER
chmod +x "$EVIDENCE/hook.sh"
blocked() { python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["decision"]=="block" and sys.argv[2] in d["reason"],d' "$1" "$2"; }

"$H" capture "$RUN_ID" ng-stop-hit --home -- "$EVIDENCE/hook.sh" "$S" Stop ng-check '{"hook_event_name":"Stop","last_assistant_message":"RQ: x"}'
blocked "$EVIDENCE/ng-stop-hit.out" 疑問文見出し
"$H" capture "$RUN_ID" ng-stop-clean --home -- "$EVIDENCE/hook.sh" "$S" Stop ng-check '{"hook_event_name":"Stop","last_assistant_message":"plain sentence"}'
[[ ! -s "$EVIDENCE/ng-stop-clean.out" ]]

"$H" capture "$RUN_ID" ng-write-md --home -- "$EVIDENCE/hook.sh" "$S" PostToolUse ng-check '{"hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"/x/a.md","content":"RQ: x"}}'
blocked "$EVIDENCE/ng-write-md.out" 疑問文見出し
"$H" capture "$RUN_ID" ng-write-py --home -- "$EVIDENCE/hook.sh" "$S" PostToolUse ng-check '{"hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"/x/a.py","content":"RQ: x"}}'
[[ ! -s "$EVIDENCE/ng-write-py.out" ]]

"$H" capture "$RUN_ID" ng-harness --home -- python3 "$SCRATCH_HOME/.claude/hooks/tests/test_ng_check.py"
tail -1 "$EVIDENCE/ng-harness.err" | grep -qx OK

SID="verify-$RUN_ID"
STATE="$SCRATCH_HOME/.claude/state/model.d/$SID"
"$H" capture "$RUN_ID" model-start --home -- "$EVIDENCE/hook.sh" "$S" SessionStart model-state "{\"session_id\":\"$SID\",\"model\":\"claude-opus-5-5[1m]\"}"
[[ "$(cat "$STATE")" = 'claude-opus-5-5[1m]' ]]
"$H" capture "$RUN_ID" model-prompt --home -- "$EVIDENCE/hook.sh" "$S" UserPromptSubmit prompt-by-model "{\"session_id\":\"$SID\"}"
P="$SCRATCH_HOME/.claude/prompts/by-model"
cat "$P/default.md" "$P/opus-5-5.md" | cmp - "$EVIDENCE/model-prompt.out"
"$H" capture "$RUN_ID" model-end --home -- "$EVIDENCE/hook.sh" "$S" SessionEnd model-state-cleanup "{\"session_id\":\"$SID\"}"
[[ ! -e "$STATE" ]]
echo "PASS claude-hooks"
"$H" cleanup "$RUN_ID" >/dev/null
ACTIVE_RUN_ID=""

# 3. Modify templates: seeded + fresh two-pass.
eval "$("$H" launch --no-apply)"
ACTIVE_RUN_ID="$RUN_ID"
"$H" doctor "$RUN_ID" > "$EVIDENCE/doctor.txt"
mkdir -p "$SCRATCH_HOME/.pi/agent" "$SCRATCH_HOME/.codex"
printf '{"theme":"light","defaultModel":"user/model","lastChangelogVersion":"9.9.9"}\n' > "$SCRATCH_HOME/.pi/agent/settings.json"
cat > "$SCRATCH_HOME/.codex/config.toml" <<'TOML'
model = "user-should-lose"
notify = ["seed-notify"]

[projects."/seed/project"]
trust_level = "trusted"

[mcp_servers.seed]
command = "seed-mcp"

[plugins."seed@market"]
enabled = false

[sandbox_workspace_write]
writable_roots = ["/seed/root"]

[shell_environment_policy.set]
SEED_ENV = "1"

[features]
seed_flag = true
js_repl = true

[tui]
screen_reader_detection_done = true
theme = "user-should-lose"
TOML
"$H" capture "$RUN_ID" seeded-apply -- "$H" chez "$RUN_ID" apply
"$H" capture "$RUN_ID" seeded-verify -- "$H" chez "$RUN_ID" verify
"$H" capture "$RUN_ID" seeded-status -- "$H" chez "$RUN_ID" status
[[ ! -s "$EVIDENCE/seeded-status.out" ]]
python3 - "$SCRATCH_HOME/.pi/agent/settings.json" "$SCRATCH_HOME/.codex/config.toml" <<'PY'
import json, sys, tomllib
d = json.load(open(sys.argv[1]))
assert d["theme"] == "light" and d["defaultModel"] == "user/model", d
assert d["lastChangelogVersion"] == "9.9.9", d
assert d["defaultProvider"] == "openrouter", d
assert d["skills"] == ["-~/.agents/skills/agmsg"], d
c = tomllib.load(open(sys.argv[2], "rb"))
assert c["notify"] == ["seed-notify"]
assert c["projects"] == {"/seed/project": {"trust_level": "trusted"}}
assert c["mcp_servers"] == {"seed": {"command": "seed-mcp"}}
assert c["plugins"] == {"seed@market": {"enabled": False}}
assert c["sandbox_workspace_write"]["writable_roots"] == ["/seed/root"]
assert c["shell_environment_policy"]["set"] == {"SEED_ENV": "1"}
assert c["features"]["seed_flag"] is True
assert c["tui"]["screen_reader_detection_done"] is True
assert c["model"] != "user-should-lose"
assert c["tui"]["theme"] != "user-should-lose"
assert "js_repl" not in c["features"]
PY
"$H" cleanup "$RUN_ID" >/dev/null
ACTIVE_RUN_ID=""

eval "$("$H" launch)"
ACTIVE_RUN_ID="$RUN_ID"
"$H" doctor "$RUN_ID" > "$EVIDENCE/doctor.txt"
cp "$SCRATCH_HOME/.codex/config.toml" "$EVIDENCE/codex-config.pass1.toml"
"$H" capture "$RUN_ID" fresh-apply-2 -- "$H" chez "$RUN_ID" apply
"$H" capture "$RUN_ID" fresh-verify-2 -- "$H" chez "$RUN_ID" verify
cp "$SCRATCH_HOME/.codex/config.toml" "$EVIDENCE/codex-config.pass2.toml"
python3 -c 'import sys,tomllib
a,b=(tomllib.load(open(p,"rb")) for p in sys.argv[1:])
assert a==b' "$EVIDENCE/codex-config.pass1.toml" "$EVIDENCE/codex-config.pass2.toml"
echo "PASS modify-templates"
"$H" cleanup "$RUN_ID" >/dev/null
ACTIVE_RUN_ID=""

# 4. Opencode layout & parity.
eval "$("$H" launch)"
ACTIVE_RUN_ID="$RUN_ID"
"$H" doctor "$RUN_ID" > "$EVIDENCE/doctor.txt"
O="$SCRATCH_HOME/.config/opencode"
test -f "$O/opencode.jsonc"
test -f "$O/AGENTS.md"
test -d "$O/plugins/roll-start"
test -d "$O/plugins/model-prompts"
test -d "$O/plugins/ng-check"
test -d "$O/plugins/auto-review"
test -f "$O/hooks/ng-patterns.tsv"
test -L "$O/custom-roll"
test "$(readlink "$O/custom-roll")" = "../../.agents/custom-roll"
cmp "$O/hooks/ng-patterns.tsv" "$SCRATCH_HOME/.claude/hooks/ng-patterns.tsv"
grep -qF 'RQ[:：]' "$O/hooks/ng-patterns.tsv"
for f in default sonnet-5-5 opus-5-5 opus-5 fable; do
  cmp "$O/prompts/by-model/$f.md" "$SCRATCH_HOME/.claude/prompts/by-model/$f.md"
done
echo "PASS opencode-layout"
"$H" cleanup "$RUN_ID" >/dev/null
ACTIVE_RUN_ID=""
