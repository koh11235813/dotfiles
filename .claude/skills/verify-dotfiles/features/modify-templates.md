# Modify templates

Pi and Codex rewrite their own config files while running. `chezmoi apply` must not undo that: it keeps what the host owns, enforces what the repo owns, and fills in defaults on a fresh machine.

## Sub-features

- `pi-preserve` keeps the host's values and any unknown key, and adds only the defaults that are missing.
- `codex-preserve` keeps `notify`, `projects`, `mcp_servers`, `plugins`, `writable_roots`, `shell_environment_policy.set`, `features.*`, and `tui.screen_reader_detection_done`.
- `codex-enforce` overrides `model` and `tui.theme` with the repo's values and drops `features.js_repl`.
- `seeded-stable` shows `verify` is 0 after one apply over a seeded file.
- `fresh-defaults` writes the defaults on an empty home.
- `fresh-two-pass` shows a second apply on a fresh home changes only the layout of `.codex/config.toml`, and then `verify` is 0.

## How to get to it (user POV)

- The user has `~/.pi/agent/settings.json` and `~/.codex/config.toml` already written by those tools, and runs `chezmoi apply`.
- The user runs `chezmoi apply` on a new machine, where neither file exists.

## Driving it with verify-dotfiles.sh

Preconditions: none beyond the baseline. The seeded case needs `--no-apply`, so the seed is in place before the first apply.

- **Seed an existing home.** The files look like ones the tools wrote, with values the repo would never pick. Copies go to evidence as the before state.

```bash
set -euo pipefail
H="$(git rev-parse --show-toplevel)/.claude/skills/verify-dotfiles/verify-dotfiles.sh"
eval "$("$H" launch --no-apply)"
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
cp "$SCRATCH_HOME/.pi/agent/settings.json" "$EVIDENCE/pi-settings.before.json"
cp "$SCRATCH_HOME/.codex/config.toml" "$EVIDENCE/codex-config.before.toml"
```

- **Apply and verify.** One apply over a seeded file reaches a fixed point, so `verify` is 0. There is no fresh-host exception here, since the seed has `mcp_servers` and `plugins`.

```bash
"$H" capture "$RUN_ID" seeded-apply -- "$H" chez "$RUN_ID" apply
"$H" capture "$RUN_ID" seeded-verify -- "$H" chez "$RUN_ID" verify
"$H" capture "$RUN_ID" seeded-status -- "$H" chez "$RUN_ID" status
[ ! -s "$EVIDENCE/seeded-status.out" ]
```

- **Read the Pi result.** Host values and the unknown key remain; the missing defaults are added.

```bash
cp "$SCRATCH_HOME/.pi/agent/settings.json" "$EVIDENCE/pi-settings.after.json"
python3 - "$EVIDENCE/pi-settings.after.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["theme"] == "light" and d["defaultModel"] == "user/model", d
assert d["lastChangelogVersion"] == "9.9.9", d
assert d["defaultProvider"] == "openrouter", d
assert d["skills"] == ["-~/.agents/skills/agmsg"], d
print("pi-preserve ok")
PY
```

- **Read the Codex result.** Host-owned keys remain; repo-owned keys win; `js_repl` is gone.

```bash
cp "$SCRATCH_HOME/.codex/config.toml" "$EVIDENCE/codex-config.after.toml"
python3 - "$EVIDENCE/codex-config.after.toml" <<'PY'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
assert d["notify"] == ["seed-notify"], d["notify"]
assert d["projects"] == {"/seed/project": {"trust_level": "trusted"}}, d["projects"]
assert d["mcp_servers"] == {"seed": {"command": "seed-mcp"}}, d["mcp_servers"]
assert d["plugins"] == {"seed@market": {"enabled": False}}, d["plugins"]
assert d["sandbox_workspace_write"]["writable_roots"] == ["/seed/root"]
assert d["shell_environment_policy"]["set"] == {"SEED_ENV": "1"}
assert d["features"]["seed_flag"] is True
assert d["tui"]["screen_reader_detection_done"] is True
assert d["model"] != "user-should-lose", d["model"]
assert d["tui"]["theme"] != "user-should-lose", d["tui"]["theme"]
assert "js_repl" not in d["features"], d["features"]
assert d["features"]["reasoning_effort_override"] is True
print("codex-preserve ok, codex-enforce ok")
PY
"$H" cleanup "$RUN_ID"
echo "PASS seeded evidence=$EVIDENCE"
```

- **Fresh host, two passes.** Defaults land on an empty home. The first `status` lists only `.codex/config.toml`, the second apply leaves the parsed TOML equal, and `verify` is then 0. The first `verify` is captured with `|| true` because its rc=1 is the known behavior; if it becomes 0 the source was fixed, and this bullet and the Gotcha should go.

```bash
eval "$("$H" launch)"
"$H" doctor "$RUN_ID" > "$EVIDENCE/doctor.txt"
"$H" capture "$RUN_ID" fresh-verify-1 -- "$H" chez "$RUN_ID" verify || true
"$H" capture "$RUN_ID" fresh-diff-1 -- "$H" chez "$RUN_ID" diff
cp "$SCRATCH_HOME/.codex/config.toml" "$EVIDENCE/codex-config.pass1.toml"
python3 - "$SCRATCH_HOME/.pi/agent/settings.json" "$EVIDENCE/codex-config.pass1.toml" <<'PY'
import json, sys, tomllib
pi = json.load(open(sys.argv[1]))
assert pi["theme"] == "dark" and pi["defaultProvider"] == "openrouter", pi
codex = tomllib.load(open(sys.argv[2], "rb"))
assert "context7" in codex["mcp_servers"], codex["mcp_servers"]
assert "github@openai-curated" in codex["plugins"], codex["plugins"]
print("fresh-defaults ok")
PY
"$H" capture "$RUN_ID" fresh-apply-2 -- "$H" chez "$RUN_ID" apply
"$H" capture "$RUN_ID" fresh-verify-2 -- "$H" chez "$RUN_ID" verify
cp "$SCRATCH_HOME/.codex/config.toml" "$EVIDENCE/codex-config.pass2.toml"
python3 -c 'import sys,tomllib
a,b=(tomllib.load(open(p,"rb")) for p in sys.argv[1:])
assert a==b
print("fresh-two-pass ok")' "$EVIDENCE/codex-config.pass1.toml" "$EVIDENCE/codex-config.pass2.toml"
"$H" cleanup "$RUN_ID"
echo "PASS fresh evidence=$EVIDENCE"
```

## Gotchas

- The seed must be in place before the first apply, hence `--no-apply`. Applying first and then editing proves a different thing.
- A seed without `mcp_servers` or `plugins` takes the fresh branch for that table and shows the same one-time `verify` rc=1.
- `sandbox_workspace_write` and `tui` are repo-owned tables with host-owned keys inside, so assert the individual keys, not the table.
- Compare parsed TOML, not text. `toToml` re-sorts and re-indents, and comments in those tables do not survive.
- The seed is synthetic. It has the keys the template names, not a copy of a real `config.toml`. Do not seed from the real file: it holds project paths and local state, and evidence outlives the run.
