# Per-host ignore matrix

A single source tree produces a different home on each machine: Arch gets the Hyprland stack, the MacBook gets niri, macOS gets neither, and Lab-Arch gets no desktop config at all because its local edits must stay untouched.

## Sub-features

- `host-arch` renders Hyprland and leaves out niri.
- `host-lab-arch` renders no desktop config.
- `host-other` renders niri, the MacBook Pro 2018 branch, and leaves out Hyprland.
- `host-darwin` renders kitty only under the desktop directories.
- `host-all` keeps `LICENSE` and `.config/zed` out on every host, and delivers `.claude/settings.json` on every host.

## How to get to it (user POV)

- The user runs `chezmoi apply` on that machine and looks in `~/.config`. Here it is `launch --host <H>` and a look in the scratch home.

## Driving it with verify-dotfiles.sh

Preconditions: none beyond the baseline. The assertions are about directories rather than file counts, since counts change whenever a file is added.

- **Render each host and compare.** One run per host. Each line is host, directories that must exist under `.config`, directories that must not. Every entry in `absent` must be missing from the rendered home and every entry in `present` must hold a file.

```bash
set -euo pipefail
H="$(git rev-parse --show-toplevel)/.claude/skills/verify-dotfiles/verify-dotfiles.sh"
while IFS='|' read -r host present absent; do
  eval "$("$H" launch --host "$host")"
  "$H" doctor "$RUN_ID" > "$EVIDENCE/doctor.txt"
  "$H" capture "$RUN_ID" managed -- "$H" chez "$RUN_ID" managed --include=files
  "$H" capture "$RUN_ID" config-listing -- find "$SCRATCH_HOME/.config" -maxdepth 1
  for d in $present; do
    [ -n "$(find "$SCRATCH_HOME/.config/$d" -type f | head -1)" ] || { echo "$host: .config/$d missing"; exit 1; }
  done
  for d in $absent zed; do
    [ ! -e "$SCRATCH_HOME/.config/$d" ] || { echo "$host: .config/$d should be absent"; exit 1; }
    ! grep -q "^\.config/$d/" "$EVIDENCE/managed.out" || { echo "$host: .config/$d is managed"; exit 1; }
  done
  [ ! -e "$SCRATCH_HOME/LICENSE" ] || { echo "$host: LICENSE rendered"; exit 1; }
  [ -f "$SCRATCH_HOME/.claude/settings.json" ] || { echo "$host: no claude settings"; exit 1; }
  echo "PASS $host evidence=$EVIDENCE"
  "$H" cleanup "$RUN_ID" > /dev/null
done <<'HOSTS'
Arch|hypr kitty mako systemd wallpaper waybar|niri
Lab-Arch||hypr kitty mako niri systemd wallpaper waybar
other|kitty niri systemd waybar|hypr mako wallpaper
darwin|kitty|hypr mako niri systemd wallpaper waybar
HOSTS
```

  Each host prints `PASS <host> evidence=<dir>`. A missing or extra directory stops the loop with the host and directory named.

## Gotchas

- Lab-Arch is proved here only as a rendering. Its real checkout has uncommitted edits, and applying there breaks it.
- Overrides do not change `.chezmoi.homeDir`, so paths rendered from it name this machine's home.
- This feature shows which files land, not that the compositor accepts them.
- `native` is left out of the loop on purpose. It would repeat `darwin` on this Mac and would mean something else on Linux.
- The ignore rules name directories, so a new `.config/<app>` lands on every host until someone adds a line. This matrix does not catch that; it only checks the directories it lists.
