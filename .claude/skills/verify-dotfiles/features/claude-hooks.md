# Claude hooks

After apply, Claude Code runs the commands in `~/.claude/settings.json`. The NG check blocks text that matches `ng-patterns.tsv`, and the model-state chain feeds the per-model prompt fragments. These recipes run the wired commands from the rendered home with the payloads Claude Code sends.

## Sub-features

- `hook-wiring` runs each hook by the command string read from rendered `settings.json`, not by a path written in the recipe.
- `ng-stop` blocks a Stop event whose last message matches a pattern, and passes a clean one.
- `ng-posttool` blocks a Write of a `.md` file with matching content, and ignores the same content in a `.py` file.
- `ng-harness` passes the stdlib test file from the rendered copy.
- `model-chain` records the model on SessionStart, emits that model's prompt on UserPromptSubmit, and removes the state on SessionEnd.

## How to get to it (user POV)

- Claude Code fires `Stop`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, and `SessionEnd`, each piping a JSON payload to the wired command.

## Driving it with verify-dotfiles.sh

Preconditions: none beyond the baseline. `RQ:` is a live pattern in the rendered `ng-patterns.tsv`.

- **Launch, and write a runner.** `hook.sh` reads the wired command from rendered `settings.json` and runs it with a payload on stdin, so `capture --home` makes `$HOME` in the command the scratch home.

```bash
set -euo pipefail
H="$(git rev-parse --show-toplevel)/.claude/skills/verify-dotfiles/verify-dotfiles.sh"
eval "$("$H" launch)"
"$H" doctor "$RUN_ID" > "$EVIDENCE/doctor.txt"
S="$SCRATCH_HOME/.claude/settings.json"
cat > "$EVIDENCE/hook.sh" <<'RUNNER'
#!/usr/bin/env bash
# usage: hook.sh <settings.json> <event> <command-substring> <payload>
cmd=$(python3 - "$1" "$2" "$3" <<'PY'
import json, sys
groups = json.load(open(sys.argv[1]))["hooks"][sys.argv[2]]
print(next(h["command"] for g in groups for h in g["hooks"] if sys.argv[3] in h["command"]))
PY
)
echo "wired: $cmd" >&2
printf '%s' "$4" | sh -c "$cmd"
RUNNER
chmod +x "$EVIDENCE/hook.sh"
blocked() { python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["decision"]=="block" and sys.argv[2] in d["reason"],d' "$1" "$2"; }
```

- **NG on Stop.** A message containing `RQ: x` produces a block decision naming `RQ:`'s category. A clean message produces no output.

```bash
"$H" capture "$RUN_ID" ng-stop-hit --home -- "$EVIDENCE/hook.sh" "$S" Stop ng-check '{"hook_event_name":"Stop","last_assistant_message":"RQ: x"}'
blocked "$EVIDENCE/ng-stop-hit.out" 疑問文見出し
"$H" capture "$RUN_ID" ng-stop-clean --home -- "$EVIDENCE/hook.sh" "$S" Stop ng-check '{"hook_event_name":"Stop","last_assistant_message":"plain sentence"}'
[ ! -s "$EVIDENCE/ng-stop-clean.out" ]
```

- **NG on PostToolUse.** The same content is blocked in a `.md` file and ignored in a `.py` file.

```bash
"$H" capture "$RUN_ID" ng-write-md --home -- "$EVIDENCE/hook.sh" "$S" PostToolUse ng-check '{"hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"/x/a.md","content":"RQ: x"}}'
blocked "$EVIDENCE/ng-write-md.out" 疑問文見出し
"$H" capture "$RUN_ID" ng-write-py --home -- "$EVIDENCE/hook.sh" "$S" PostToolUse ng-check '{"hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"/x/a.py","content":"RQ: x"}}'
[ ! -s "$EVIDENCE/ng-write-py.out" ]
```

- **Hook test harness.** The rendered copy passes. stderr ends with `OK`.

```bash
"$H" capture "$RUN_ID" ng-harness --home -- python3 "$SCRATCH_HOME/.claude/hooks/tests/test_ng_check.py"
tail -1 "$EVIDENCE/ng-harness.err" | grep -qx OK
grep -E '^Ran [0-9]+ tests' "$EVIDENCE/ng-harness.err"
```

- **Model-state chain.** SessionStart writes the model name to the scratch state dir. UserPromptSubmit then prints `default.md` followed by `opus-5-5.md`. SessionEnd removes the file. The real `~/.claude/state/model.d/<id>` never appears.

```bash
SID="verify-$RUN_ID"
STATE="$SCRATCH_HOME/.claude/state/model.d/$SID"
"$H" capture "$RUN_ID" model-start --home -- "$EVIDENCE/hook.sh" "$S" SessionStart model-state "{\"session_id\":\"$SID\",\"model\":\"claude-opus-5-5[1m]\"}"
[ "$(cat "$STATE")" = 'claude-opus-5-5[1m]' ]
"$H" capture "$RUN_ID" model-prompt --home -- "$EVIDENCE/hook.sh" "$S" UserPromptSubmit prompt-by-model "{\"session_id\":\"$SID\"}"
P="$SCRATCH_HOME/.claude/prompts/by-model"
cat "$P/default.md" "$P/opus-5-5.md" | cmp - "$EVIDENCE/model-prompt.out"
"$H" capture "$RUN_ID" model-end --home -- "$EVIDENCE/hook.sh" "$S" SessionEnd model-state-cleanup "{\"session_id\":\"$SID\"}"
[ ! -e "$STATE" ]
[ ! -e "$HOME/.claude/state/model.d/$SID" ]
```

- **Clean up.** Scratch is gone and evidence stays.

```bash
"$H" cleanup "$RUN_ID"
[ -s "$EVIDENCE/ng-stop-hit.out" ]
echo "PASS claude-hooks evidence=$EVIDENCE"
```

## Gotchas

- `ng-check.py` is fail-open and always exits 0, so assert on its stdout, never its rc.
- An empty stdout is what a broken hook prints too. That is why each negative case sits beside a positive one on the same path.
- Inline code is masked before matching, so a payload with `` `RQ: x` `` passes.
- The other `SessionStart` hook, `custom-roll.sh`, and the status line are not covered here.
- `hook.sh` lives in evidence because the runner is part of what a later reader needs to reproduce the proof.
