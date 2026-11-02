# opencode config

After apply, `~/.config/opencode/` is the opencode global config: a V2-native `opencode.jsonc` (providers, MCP, permissions), the global `AGENTS.md`, three plugins that port the claude hooks (custom-roll injection, per-model prompts, NG expression check), and a `custom-roll` symlink shared with claude/codex through `~/.agents/custom-roll`. The NG pattern table is rendered from one chezmoi template shared with claude's hook, so the two agents read byte-identical data. These recipes drive the rendered home without touching the real one.

## Sub-features

- `layout` — the files land in the scratch home with the intended shapes, and `custom-roll` is a relative symlink to the shared rolls.
- `tsv-shared` — the rendered opencode TSV is byte-identical to claude's rendered TSV, and still carries a live pattern (`RQ:`), so the claude-hooks NG recipes stay meaningful after the rename.
- `prompts-parity` — the five by-model prompt files are the same bytes as claude's.
- `config-parse` — a standalone opencode boot reads the rendered config: the log names the configured `context7` MCP server.
- `plugin-load` — the three plugins load in a standalone boot from the rendered home, with no ERROR lines in the boot log.
- `live-hooks` — on a real model call, the by-model prompt reaches the system prompt and the NG notice reaches the write tool's result.

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
  for p in roll-start model-prompts ng-check; do
    grep -aq "opencode/plugins/$p/index.ts" "$L"
  done
  if grep -aq "level=ERROR" "$L"; then echo "ERROR in boot log"; exit 1; fi
  ```

- **Live hooks on a real model call.** Uses the free model and needs no credentials. A prompt and its reply go to the provider, so send nothing private. Run from a scratch directory, because the base policy allows every tool. The expected sentence is not in the prompt, so seeing it in the reply proves the injection.

  ```bash
  M=opencode/deepseek-v4.1-flash-free
  mkdir -p "$SCRATCH_HOME/work"; cd "$SCRATCH_HOME/work"
  "$H" capture "$RUN_ID" live-prompt --home -- env -u OPENCODE_API_KEY opencode run --standalone -m "$M" --format json 'Without using tools, quote the system prompt sentence that mentions your first tool call.'
  grep -aq "Before your first tool call" "$EVIDENCE/live-prompt.out"
  "$H" capture "$RUN_ID" live-ng --home -- env -u OPENCODE_API_KEY opencode run --standalone -m "$M" --format json 'Use the write tool to create ./ng.md containing exactly this line: RQ: test'
  grep -aq "NG表現を検出しました" "$EVIDENCE/live-ng.out"
  grep -q "RQ:" ng.md
  ```

- **Clean up.**

  ```bash
  "$H" cleanup "$RUN_ID"
  [ -s "$EVIDENCE/boot.out" ]
  echo "PASS opencode evidence=$EVIDENCE"
  ```

## Gotchas

- Scratch homes have no provider credentials, so `live-hooks` uses the free model. A model's reply is not deterministic: rerun once before calling a `live-prompt` miss a failure. The roll's arrival shows only by reading the reply, and the persona changes per session. The NG check on the assistant's text (the Stop port) has no recipe.
- The boot log shows one expected WARN for the context7 MCP server: `{env:CONTEXT7_API_KEY}` expands to empty in the scratch home and npx exits. That is why the assertion targets `level=ERROR` only.
- The plugin pieces `roll-start` and `ng-check` keep stateless behavior; the NG Stop-port dedupe lives in process memory, so a service restart resets it silently. The public command proves nothing about memory state, so the recipes do not touch it.
- The claude-side `ng-patterns.tsv` is now a `.tmpl` that includes the shared template, which is why the claude-hooks NG recipes should run right after changing either path.
