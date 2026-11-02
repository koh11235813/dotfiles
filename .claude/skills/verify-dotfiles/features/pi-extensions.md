# Pi extensions

Pi loads the extensions under `~/.pi/agent/extensions/`. Each one ships tests, and `tests/run.mjs` runs them all against the Pi SDK of the managed install. Here the suite runs from the rendered home, so a file that failed to land or lost its layout shows up as a failure.

## Sub-features

- `pi-suite` passes every `extensions/**/*.test.ts` from the rendered home with no failures.
- `pi-isolation` shows the run did not change the real `~/.pi/agent/settings.json`.

## How to get to it (user POV)

- Pi loads the extensions on start. The repo's documented check is `node dot_pi/agent/tests/run.mjs`. This recipe runs the rendered copy of the same file.

## Driving it with verify-dotfiles.sh

Preconditions:

- `node` is on `PATH`. The suite ran on v22.23.2 without any flag beyond those in `run.mjs`.
- `~/.pi/agent/install/current-version` exists. If it does not, Pi is not installed on this host, so `run.mjs` cannot resolve `@earendil-works/*`: report that as the unmet precondition, not as a pass.

- **Link the SDK into the scratch home.** The rendered home has no `install/`, since chezmoi does not manage it. `run.mjs` finds the SDK under `$HOME/.pi/agent`, and `capture --home` points `HOME` at the scratch home.

```bash
set -euo pipefail
H="$(git rev-parse --show-toplevel)/.claude/skills/verify-dotfiles/verify-dotfiles.sh"
[ -f "$HOME/.pi/agent/install/current-version" ] || { echo "unmet precondition: no Pi install at ~/.pi/agent/install"; exit 1; }
eval "$("$H" launch)"
"$H" doctor "$RUN_ID" > "$EVIDENCE/doctor.txt"
ln -s "$HOME/.pi/agent/install" "$SCRATCH_HOME/.pi/agent/install"
before=$(ls -lT "$HOME/.pi/agent/settings.json" 2>/dev/null || ls -l --time-style=full-iso "$HOME/.pi/agent/settings.json")
```

- **Run the suite.** Exit code 0 and `# fail 0`. Expect about 15 seconds.

```bash
"$H" capture "$RUN_ID" pi-suite --home -- node "$SCRATCH_HOME/.pi/agent/tests/run.mjs"
grep -E '^# (tests|pass|fail|skipped) ' "$EVIDENCE/pi-suite.out"
grep -qx '# fail 0' "$EVIDENCE/pi-suite.out"
grep -E '# SKIP' "$EVIDENCE/pi-suite.out" || true
```

- **Check the real file, then clean up.** The real settings file is unchanged. Cleanup unlinks the symlink and does not follow it.

```bash
after=$(ls -lT "$HOME/.pi/agent/settings.json" 2>/dev/null || ls -l --time-style=full-iso "$HOME/.pi/agent/settings.json")
[ "$before" = "$after" ]
"$H" cleanup "$RUN_ID"
[ -f "$HOME/.pi/agent/install/current-version" ]
echo "PASS pi-extensions evidence=$EVIDENCE"
```

## Gotchas

- The `install` symlink is the one place the scratch home reaches into the real home. It is only read, for the SDK. Use it only inside this recipe.
- On this Mac 2 tests skip: `stopは、グループを抜けた子孫も止める` and `stopは、グループを抜けてSIGTERMを無視する子孫も、シェルが終わった時点で止める`. The recipe prints the skip list, so a change in it is visible. It does not fail on one.
- The tests use a fake host. Passing does not prove anything about the real Pi TUI; the extension READMEs list what was never checked there.
- `guard/tests/` starts real `sandbox-exec` on macOS and writes under `os.tmpdir()` and `/tmp`, and cleans up after itself. One test runs real chezmoi on a fake home it makes with `HOME` and the XDG variables cleared.
- bun and pytest are not on `PATH` and neither is needed.
