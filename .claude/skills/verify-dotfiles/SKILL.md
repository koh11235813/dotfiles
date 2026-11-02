---
name: verify-dotfiles
description: Prove behavior of the chezmoi dotfiles repo by rendering it into a throwaway home and driving what lands there (per-host ignore rules, Claude hooks, Pi and Codex modify templates, Pi extensions). Use after changing anything in this source tree, before telling the user a dotfiles change works, or when asked to verify, test, or check a change to dotfiles. Never applies to the real home.
---

# Verify dotfiles

There is no running app here. What a user touches is `chezmoi apply` turning this source tree into a home directory, and then tools reading those files. So the primary surface is the rendered home, and the secondary surfaces are the Claude hooks and Pi extensions inside it. This skill renders into a scratch home and drives that.

**Applying to `$HOME` is never part of verification.** The user runs `chezmoi apply` on the real home themselves. Do not run `chezmoi apply`, `chezmoi init`, or `chezmoi update` directly, and do not call bare `chezmoi` at all from a recipe: its defaults are the real home, the real config, and the real state db (`~/.config/chezmoi/chezmoistate.boltdb`). Go through the helper. Do not ssh to other hosts either.

Other hosts are rendered with `--override-data`, not visited. Lab-Arch's real checkout has uncommitted local edits and applying there breaks it, which is why `.chezmoiignore.tmpl` keeps its desktop config untouched.

## Helper

`.claude/skills/verify-dotfiles/verify-dotfiles.sh`, executable, one file, bash. Run recipes in bash, not zsh. Run a whole recipe in one bash process, because shell variables do not survive between tool calls. `paths <run-id>` restores them.

| Command | What it does |
|---|---|
| `launch [--host H] [--no-apply] [--dest DIR]` | Creates the scratch dir and evidence dir, renders the config, applies. Prints `RUN_ID`, `SCRATCH_HOME`, `EVIDENCE` on stdout for `eval`. `H` is `native` (default), `darwin`, `Arch`, `Lab-Arch`, or `other`. |
| `paths <run>` | Prints the same three variables. |
| `doctor <run>` | Read-only health check. |
| `chez <run> <verb> [args]` | Runs `apply`, `verify`, `diff`, `status`, `managed`, `cat`, `source-path`, or `data` against this run's isolated flags. Anything else is refused, as is passing `--destination`, `--source`, `--config`, or `--persistent-state`. |
| `capture <run> <label> [--home] -- cmd...` | Runs a command and writes `<label>.cmd`, `.out`, `.err`, `.rc` to evidence. Returns the command's rc. `--home` sets `HOME` to the scratch home for that one process. |
| `cleanup <run>` | Removes the scratch dir this run created, and nothing else. |

## Launch

```bash
H="$(git rev-parse --show-toplevel)/.claude/skills/verify-dotfiles/verify-dotfiles.sh"
eval "$("$H" launch)"
"$H" doctor "$RUN_ID"
```

Always follow `launch` with `doctor`. `eval` cannot see `launch`'s exit code, so a failed launch still sets the variables and carries on; `doctor` is what stops it, by failing unless launch reached ready.

Ready means the first apply is done and `chezmoi status` afterwards is empty or exactly ` M .codex/config.toml` (see Gotchas). Anything else logs the drift to stderr and leaves `ready` unwritten; run `cleanup` after diagnosing it.

Each launch gets its own scratch dir, state db, and evidence dir, so runs can sit side by side. There is nothing long-running, so there is no process to stop.

`launch --dest DIR` is for keeping the output somewhere you choose. It refuses `$HOME` (also through a symlink), any parent of it, and any non-empty directory, and `cleanup` leaves that directory in place.

## Doctor

```bash
"$H" doctor "$RUN_ID"
```

Run this first whenever anything looks off. It writes nothing and exits 1 on any `FAIL`. It reports the chezmoi version and the host being rendered, and checks that the scratch still exists, launch reached ready, the source is this repo, the destination is the scratch one and not `$HOME` or a parent, the real state db mtime matches the launch baseline, and the evidence root is not managed by chezmoi. A changed `~/.claude/settings.json` is a `warn`, because Claude Code writes that file on its own.

## Drive

Read [features/README.md](features/README.md), pick the features your change touches, and run their recipes as written. Which source path maps to which feature is in that index.

```bash
"$H" chez "$RUN_ID" diff                         # what a further apply would change
"$H" chez "$RUN_ID" managed --include=files      # what chezmoi manages on this host
"$H" capture "$RUN_ID" zshrc -- cat "$SCRATCH_HOME/.zshrc"
```

## Evidence

Everything goes to `${VERIFY_DOTFILES_EVIDENCE:-${XDG_STATE_HOME:-$HOME/.local/state}/verify-dotfiles}/<run-id>/`. That path is outside what chezmoi manages (`chezmoi managed` lists `.local/bin/update-codex.sh` and nothing under `.local/state`), and `doctor` rechecks it each run.

Every run records `source.txt` (chezmoi version, HEAD, and `git status --short`; chezmoi renders the working tree, so uncommitted edits are part of what was proved), `host`, and `baseline-mtimes`.

A proof needs all of these:

- It goes through `chezmoi apply` and then reads or runs the rendered file, not the source file.
- It captures the action and the resulting state with `capture`, including any seed that went in.
- It checks side effects: files written, keys kept. A hook's exit code alone proves nothing, since `ng-check.py` always exits 0.
- It states what it did not cover. A journey that cannot run is reported as a failure with the unmet precondition. Never weaken one to make it pass.

## Cleanup

```bash
"$H" cleanup "$RUN_ID"
```

Removes the scratch dir after checking its `.verify-dotfiles-run` marker matches the run. Evidence stays. Run it after failed attempts too. There are no processes to kill.

## What this does not prove

- Overrides change `.chezmoi.hostname` and `.chezmoi.os` and nothing else. They prove what gets rendered for a host, not that Hyprland, niri, waybar, or systemd accept it. Only the real machine can show that, and the user does that part.
- `.chezmoiscripts/run_onchange_after_hermes-custom-roll.sh.tmpl` never runs here. It calls `hermes config set` when hermes is on PATH, so the helper always passes `--exclude=scripts`.

## Gotchas

- **`chezmoi verify` returns 1 right after the first apply to an empty home.** This is not a failed apply. With empty stdin, `dot_codex/modify_private_config.toml` writes its hand-written default `[mcp_servers.context7]` and `[plugins."..."]` tables. `verify` renders it again with that file on stdin, takes the `hasKey` branch, and `toToml` writes the same data in a different layout. The parsed TOML is identical, a second apply changes the file once, and from then on `verify` is 0. So do not use bare `verify` as a pass/fail right after a fresh `launch`: use the status check `launch` already does, or apply a second time first. Any entry other than `.codex/config.toml` is real drift.
- `chezmoi: warning: config file template has changed, run chezmoi init to regenerate config file` is noise from this recipe. `execute-template` does not record the template hash, and `init` is off limits. It goes to stderr, so parse stdout only.
- `.chezmoi.homeDir` stays the real home with a scratch destination. Rendered `.gemini/config/skills.json` therefore points at `/Users/kinoko/.agents/skills`. Nothing in this skill reads through that path, but do not treat it as isolated.
- `.chezmoi.hostname` on this Mac is `kinoko-M5`. `native` renders that; `darwin` overrides to `other`/`darwin`, so the Mac layout can be rendered from a Linux host.
- `--home` covers one process. Never `export HOME=...` in a recipe. The helper's defaults for the evidence root and the real state db read `HOME`.
- The user's shell is zsh, which does not word-split unquoted variables. The helper uses a bash array for this reason; do not paste its flags into an interactive command.
