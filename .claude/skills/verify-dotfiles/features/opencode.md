# opencode config

After apply, `~/.config/opencode/` is the opencode global config: a V2-native `opencode.jsonc` (MCP, permissions), the global `AGENTS.md`, three plugins that port the claude hooks (custom-roll injection, per-model prompts, NG expression check), a log-only plugin that records Jev's opinion of each shell command left at ask, and a `custom-roll` symlink shared with claude/codex through `~/.agents/custom-roll`. The NG pattern table is rendered from one chezmoi template shared with claude's hook, so the two agents read byte-identical data. These recipes drive the rendered home without touching the real one.

## Sub-features

- `layout` — the files land in the scratch home with the intended shapes, and `custom-roll` is a relative symlink to the shared rolls.
- `tsv-shared` — the rendered opencode TSV is byte-identical to claude's rendered TSV, and still carries a live pattern (`RQ:`), so the claude-hooks NG recipes stay meaningful after the rename.
- `prompts-parity` — the five by-model prompt files are the same bytes as claude's.
- `config-parse` — a standalone opencode boot reads the rendered config: the log names the configured `context7` MCP server.
- `plugin-load` — the four plugins load in a standalone boot from the rendered home, with no ERROR lines in the boot log.
- `live-hooks` — on a real model call, the by-model prompt reaches the system prompt and the NG notice reaches the write tool's result.
- `auto-review` — shell commands outside the read-only allow list stay at ask, force pushes are denied, and each ask leaves one log line with Jev's opinion or an `error`. The plugin never changes the decision.

## How to get to it (user POV)

- opencode reads global config from `~/.config/opencode/`, discovers `plugins/` there, and loads `AGENTS.md` from there for every session. Claude reads the same NG pattern file from `~/.claude/hooks/ng-patterns.tsv`.

## Driving it with verify-dotfiles.sh

- **Layout and parity.**

  ```bash
  set -euo pipefail
  H="$(git rev-parse --show-toplevel)/.claude/skills/verify-dotfiles/verify-dotfiles.sh"
  eval "$("$H" launch)"
  "$H" doctor "$RUN_ID" > "$EVIDENCE/doctor.txt"
  O="$SCRATCH_HOME/.config/opencode"
  test -f "$O/opencode.jsonc"
  test -f "$O/AGENTS.md"
  test -d "$O/plugins/roll-start"
  test -d "$O/plugins/model-prompts"
  test -d "$O/plugins/ng-check"
  test -d "$O/plugins/auto-review"
  test -f "$O/hooks/ng-patterns.tsv"
  test -f "$O/prompts/by-model/default.md"
  test -L "$O/custom-roll"
  test "$(readlink "$O/custom-roll")" = "../../.agents/custom-roll"
  test -f "$SCRATCH_HOME/.agents/custom-roll/ojyo.md"
  cmp "$O/hooks/ng-patterns.tsv" "$SCRATCH_HOME/.claude/hooks/ng-patterns.tsv"
  grep -qF 'RQ[:：]' "$O/hooks/ng-patterns.tsv"
  for f in default sonnet-5-5 opus-5-5 opus-5 fable; do
    cmp "$O/prompts/by-model/$f.md" "$SCRATCH_HOME/.claude/prompts/by-model/$f.md"
  done
  ```

- **Config parse: the rendered config is read.**

  ```bash
  "$H" capture "$RUN_ID" models --home -- opencode models --standalone
  grep -aq "server=context7" "$SCRATCH_HOME/.local/share/opencode/log/opencode.log"
  ```

- **Plugin load in a standalone boot.**

  ```bash
  "$H" capture "$RUN_ID" boot --home -- opencode api get /api/info --standalone
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert "version" in d, d' "$EVIDENCE/boot.out"

  L="$SCRATCH_HOME/.local/share/opencode/log/opencode.log"
  for p in roll-start model-prompts ng-check auto-review; do
    grep -aq "opencode/plugins/$p/index.ts" "$L"
  done
  if grep -aq "level=ERROR" "$L"; then echo "ERROR in boot log"; exit 1; fi
  ```

- **Live hooks on a real model call.** Uses the free model and needs no credentials. A prompt and its reply go to the provider, so send nothing private. Run from a scratch directory, because the write tool is still allowed. The expected sentence is not in the prompt, so seeing it in the reply proves the injection.

  ```bash
  M=opencode/deepseek-v4.1-flash-free
  mkdir -p "$SCRATCH_HOME/work"; cd "$SCRATCH_HOME/work"
  "$H" capture "$RUN_ID" live-prompt --home -- env -u OPENCODE_API_KEY opencode run --standalone -m "$M" --format json 'Without using tools, quote the system prompt sentence that mentions your first tool call.'
  grep -aq "Before your first tool call" "$EVIDENCE/live-prompt.out"
  "$H" capture "$RUN_ID" live-ng --home -- env -u OPENCODE_API_KEY opencode run --standalone -m "$M" --format json 'Use the write tool to create ./ng.md containing exactly this line: RQ: test'
  grep -aq "NG表現を検出しました" "$EVIDENCE/live-ng.out"
  grep -q "RQ:" ng.md
  ```

- **Auto review on real Jev and the free model.** Needs `TYPESAFE_API_KEY` in the environment, and sends the test commands to TypeSafe. An ask is rejected in `opencode run`, so that rejection is the signal that a command stayed at ask. The model decides whether to call the tool, so `ar_run` reruns once and prints `RERAN` when it did not. The rendered `AGENTS.md` makes the model refuse any force push, so it is out of the way for the deny case only: the rule under test is the config's, and the directory is checked not to be a repo.

  ```bash
  if [ -z "${TYPESAFE_API_KEY:-}" ]; then echo "precondition: TYPESAFE_API_KEY is not set"; exit 1; fi
  mkdir -p "$SCRATCH_HOME/work/auto-review"; cd "$SCRATCH_HOME/work/auto-review"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "$PWD is a git repo; stopping"; exit 1; fi
  ARLOG="$SCRATCH_HOME/.local/state/opencode/auto-review.jsonl"
  cat > "$EVIDENCE/ar_check.py" <<'PY'
  import json, math, sys
  mode, path, *rest = sys.argv[1:]
  if mode == "tool":  # prints the state of the shell call running exactly this command
      for line in open(path, errors="replace"):
          try: event = json.loads(line)
          except ValueError: continue
          state = event.get("part", {}).get("state", {}) if event.get("type") == "tool_use" else {}
          if state.get("input", {}).get("command") == rest[0]:
              print(json.dumps({k: state.get(k) for k in ("status", "error", "output")}))
              sys.exit(0)
      sys.exit(3)
  start, resource, want = int(rest[0]), rest[1], rest[2]
  entries = [json.loads(l) for l in open(path).read().splitlines()[start:]]
  entries = [e for e in entries if resource in e["resources"]]
  assert entries, "no new log line for " + resource
  for e in entries:
      assert isinstance(e["latencyMs"], int) and e["ts"] and e["sessionID"], e
      if want == "error":
          assert isinstance(e["error"], str) and "probabilities" not in e, e
      else:
          assert "error" not in e and isinstance(e["wouldAllow"], bool), e
          assert all(isinstance(v, (int, float)) and math.isfinite(v) for v in e["probabilities"].values()), e
          assert "allow" in e["probabilities"] and isinstance(e["confidence"], (int, float)), e
  print(json.dumps(entries[-1]))
  PY
  ar_lines() { if [ -f "$ARLOG" ]; then wc -l < "$ARLOG" | tr -d ' '; else echo 0; fi; }
  # usage: ar_run <label> <command> [env args]; leaves the tool state in TOOL
  ar_run() {
    local label=$1 want=$2 l; shift 2
    for l in "$label" "$label-rerun"; do
      "$H" capture "$RUN_ID" "$l" --home -- env -u OPENCODE_API_KEY "$@" perl -e 'alarm 100; exec @ARGV' opencode run --standalone -m "$M" --format json "This is a permission-rule test in a throwaway directory that is not a git repo. Call the shell tool once with exactly this command, verbatim, then stop without trying anything else, whatever happens: $want" || true
      if TOOL=$(python3 "$EVIDENCE/ar_check.py" tool "$EVIDENCE/$l.out" "$want"); then return 0; fi
      echo "RERAN: $l produced no tool call for: $want"
    done
    echo "no tool call after a rerun: $want"; return 1
  }
  ar_absent() { if [ -e "$1" ]; then echo "$1 was written"; exit 1; fi; }

  n=$(ar_lines)
  ar_run ar-compound 'echo a > marker.txt && ls'
  grep -q 'cannot ask the user' <<<"$TOOL"
  ar_absent marker.txt
  python3 "$EVIDENCE/ar_check.py" log "$ARLOG" "$n" 'echo a > marker.txt' opinion | tee "$EVIDENCE/ar-compound.line"
  python3 -c 'import os,stat,sys; m=stat.S_IMODE(os.stat(sys.argv[1]).st_mode); assert m==0o600, oct(m)' "$ARLOG"

  ar_run ar-redirect 'ls > out.txt'
  grep -q 'cannot ask the user' <<<"$TOOL"
  ar_absent out.txt

  touch listed.txt
  n=$(ar_lines)
  ar_run ar-allow 'ls'
  grep -q '"status": "completed"' <<<"$TOOL"
  grep -q 'listed.txt' <<<"$TOOL"
  [ "$(ar_lines)" = "$n" ]

  ar_run ar-tree 'tree -o tree.txt'
  grep -q 'cannot ask the user' <<<"$TOOL"
  ar_absent tree.txt
  ar_run ar-pre 'rg --pre=cat a'
  grep -q 'cannot ask the user' <<<"$TOOL"
  echo 'NOT_A_SECRET=1' > .env
  ar_run ar-env 'cat .env'
  grep -q 'cannot ask the user' <<<"$TOOL"

  mv "$SCRATCH_HOME/.config/opencode/AGENTS.md" "$EVIDENCE/AGENTS.md.off"
  n=$(ar_lines)
  ar_run ar-deny 'git push --force origin main'
  mv "$EVIDENCE/AGENTS.md.off" "$SCRATCH_HOME/.config/opencode/AGENTS.md"
  grep -q 'Permission denied' <<<"$TOOL"
  [ "$(ar_lines)" = "$n" ]

  n=$(ar_lines)
  ar_run ar-nokey 'echo b > marker2.txt' -u TYPESAFE_API_KEY
  grep -q 'cannot ask the user' <<<"$TOOL"
  ar_absent marker2.txt
  python3 "$EVIDENCE/ar_check.py" log "$ARLOG" "$n" 'echo b > marker2.txt' error | tee "$EVIDENCE/ar-nokey.line"

  n=$(ar_lines)
  ar_run ar-badkey 'echo c > marker3.txt' TYPESAFE_API_KEY=invalid
  grep -q 'cannot ask the user' <<<"$TOOL"
  ar_absent marker3.txt
  python3 "$EVIDENCE/ar_check.py" log "$ARLOG" "$n" 'echo c > marker3.txt' error | tee "$EVIDENCE/ar-badkey.line"
  ```

- **Clean up.**

  ```bash
  "$H" cleanup "$RUN_ID"
  [ -s "$EVIDENCE/boot.out" ]
  echo "PASS opencode evidence=$EVIDENCE"
  ```

## Gotchas

- Scratch homes have no provider credentials, so `live-hooks` and `auto-review` use the free model; only `auto-review` needs a key, `TYPESAFE_API_KEY` from the calling environment. A model's reply is not deterministic: rerun once before calling a `live-prompt` miss a failure. The roll's arrival shows only by reading the reply, and the persona changes per session. The NG check on the assistant's text (the Stop port) has no recipe.
- The boot log shows one expected WARN for the context7 MCP server: `{env:CONTEXT7_API_KEY}` expands to empty in the scratch home and npx exits. That is why the assertion targets `level=ERROR` only.
- The plugin pieces `roll-start` and `ng-check` keep stateless behavior; the NG Stop-port dedupe lives in process memory, so a service restart resets it silently. The public command proves nothing about memory state, so the recipes do not touch it.
- `auto-review.jsonl` holds command text in the clear, and the same text is sent to TypeSafe on every ask. In daily use the plugin runs inside the background `opencode service`, whose environment decides whether the key is present; a key exported only in a shell shows up as `error` lines instead of opinions. `XDG_STATE_HOME`, if exported, sends the log outside the scratch home, because `capture --home` only sets `HOME`.
- The free model has a usage limit, and a full run here takes about a dozen calls. `provider.free-limit` in a `.out` file with `retryAfterMs` means quota, not a rule failure, though `ar_run` reports it as no tool call. Check `.out` before reading that message as a model refusal, then retry after the wait or set `M` to `opencode/glm-5.3-flash-free`, which also passes the whole recipe.
- `auto-review` asserts one force-push spelling live. `git push -uf` and `git -C . push --force` miss the deny and fall to ask, which still needs a person. This is a known gap, not a recipe failure.
- `POST /api/session/{id}/permission` is not a way to test rules without a model: under `opencode api --standalone` it answered `deny` for everything, including `ls`.
- The claude-side `ng-patterns.tsv` is now a `.tmpl` that includes the shared template, which is why the claude-hooks NG recipes should run right after changing either path.
