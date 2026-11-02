# Dotfiles verification map

This directory is the maintained source for verifying what `chezmoi apply` produces from this repo. Read the index below, then use the matching feature file as the recipe.

## Baseline preconditions

- `chezmoi`, `python3`, and `git` are on `PATH`.
- Every recipe starts its own run with `launch`, on a scratch home it created. Never drive the real home.
- `H` is `"$(git rev-parse --show-toplevel)/.claude/skills/verify-dotfiles/verify-dotfiles.sh"`, run from inside this repo.

## Driving conventions

- Each `Driving` section is one bash session: run its fenced blocks in order, in the same bash process, because the variables carry over. Blocks contain their own heredocs, so feed them from a file or a uniquely named outer heredoc. `set -euo pipefail` makes a failed assertion stop the recipe with a non-zero exit.
- Reach rendered files through `$SCRATCH_HOME` and chezmoi through `"$H" chez`.
- Run hooks as `settings.json` wires them, with `capture --home`, so `$HOME` in the command resolves to the scratch home.
- A recipe's last block runs `cleanup`. If a recipe stops early, run `"$H" cleanup "$RUN_ID"` yourself.

## Proof and skip reporting

- Report the feature ID, the run id, and the evidence path.
- `capture` records the command, stdout, stderr, and exit code. Assertions in a recipe are the proof that those files say what they should.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped sub-feature as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-dotfiles.sh`, `Gotchas`.

## Features

| Feature | Covers | Reach for it when you changed |
|---|---|---|
| [Per-host ignore matrix](./host-ignore-matrix.md) | Which directories land on Arch, Lab-Arch, other Linux, and macOS | `.chezmoiignore.tmpl`, or adding anything under `dot_config/` |
| [Claude hooks](./claude-hooks.md) | `settings.json` wiring, the NG check, and the model-state hook chain, run from the rendered home | `dot_claude/settings.json`, `dot_claude/hooks/`, `.chezmoitemplates/ng-patterns.tsv`, `dot_claude/scripts/`, `dot_claude/prompts/` |
| [Modify templates](./modify-templates.md) | Pi and Codex keep host-owned keys over an existing file and fill defaults on a fresh host | `dot_pi/agent/modify_settings.json`, `dot_codex/modify_private_config.toml` |
| [Pi extensions](./pi-extensions.md) | The extension test suite, run from the rendered home | `dot_pi/agent/extensions/`, `dot_pi/agent/tests/` |
| [opencode config](./opencode.md) | The opencode global config, its three hook plugins, and the shared NG pattern TSV, driven from the rendered home | `dot_config/opencode/**`, `.chezmoitemplates/ng-patterns.tsv`, `dot_claude/hooks/ng-patterns.tsv.tmpl` |
