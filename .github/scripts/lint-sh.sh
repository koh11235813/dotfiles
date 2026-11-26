#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
REQUIRE_SHELLCHECK=0
if [[ ${1:-} == "--require-shellcheck" ]]; then
  REQUIRE_SHELLCHECK=1
fi

HAS_SHELLCHECK=0
if command -v shellcheck >/dev/null 2>&1; then
  HAS_SHELLCHECK=1
elif ((REQUIRE_SHELLCHECK)); then
  echo "lint-sh: shellcheck is required but not found on PATH" >&2
  exit 1
else
  echo "lint-sh: shellcheck not installed locally; running syntax checks only" >&2
fi

HAS_ZSH=0
if command -v zsh >/dev/null 2>&1; then
  HAS_ZSH=1
fi

# Unrelated pre-existing scripts left untouched; exclude their known ShellCheck warnings.
run_shellcheck() {
  local file=$1
  local rel=$2
  local extra=()
  case $rel in
    dot_claude/scripts/executable_statusline-command.sh)
      extra=(-e SC2034 -e SC2088 -e SC2154) ;;
    dot_config/waybar/scripts/executable_brightness_ascii.sh)
      extra=(-e SC2059) ;;
    dot_config/waybar/scripts/executable_volume_ascii.sh)
      extra=(-e SC2046 -e SC2059) ;;
  esac
  shellcheck --severity=warning "${extra[@]}" "$file"
}

failed=0

mapfile_sh=()
while IFS= read -r rel; do
  [[ -n $rel ]] && mapfile_sh+=("$rel")
done < <(
  {
    git -C "$REPO_ROOT" ls-files '*.sh'
    for p in "$REPO_ROOT"/.github/scripts/*.sh; do
      [[ -f $p ]] && printf '%s\n' "${p#"$REPO_ROOT"/}"
    done
  } | sort -u
)

for rel in "${mapfile_sh[@]}"; do
  file="$REPO_ROOT/$rel"
  [[ -f $file ]] || continue
  shebang=$(head -n 1 "$file")
  case $shebang in
    *zsh*)
      if ((HAS_ZSH)); then
        if zsh -n "$file"; then
          echo "ok(zsh -n): $rel"
        else
          failed=1
        fi
      else
        echo "skip(zsh not installed): $rel"
      fi
      ;;
    *bash*)
      if ! bash -n "$file"; then
        failed=1
      elif ((HAS_SHELLCHECK)); then
        if run_shellcheck "$file" "$rel"; then
          echo "ok(bash -n + shellcheck): $rel"
        else
          failed=1
        fi
      else
        echo "ok(bash -n): $rel"
      fi
      ;;
    *)
      if ! sh -n "$file"; then
        failed=1
      elif ((HAS_SHELLCHECK)); then
        if run_shellcheck "$file" "$rel"; then
          echo "ok(sh -n + shellcheck): $rel"
        else
          failed=1
        fi
      else
        echo "ok(sh -n): $rel"
      fi
      ;;
  esac
done

# Render and lint chezmoi shell templates when chezmoi is available.
if command -v chezmoi >/dev/null 2>&1; then
  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lint-sh.XXXXXX")
  cleanup_tmp() {
    rm -rf "$TMP_DIR"
  }
  trap cleanup_tmp EXIT

  mkdir -p "$TMP_DIR/bin"
  printf '#!/bin/sh\nexit 0\n' > "$TMP_DIR/bin/hermes"
  chmod +x "$TMP_DIR/bin/hermes"

  PATH="$TMP_DIR/bin:$PATH" chezmoi execute-template \
    --source "$REPO_ROOT" \
    --config /dev/null \
    --config-format toml \
    < "$REPO_ROOT/.chezmoiscripts/run_onchange_after_hermes-custom-roll.sh.tmpl" \
    > "$TMP_DIR/hermes-custom-roll.sh"

  if ! sh -n "$TMP_DIR/hermes-custom-roll.sh"; then
    failed=1
  elif ((HAS_SHELLCHECK)); then
    if shellcheck --severity=warning "$TMP_DIR/hermes-custom-roll.sh"; then
      echo "ok(sh -n + shellcheck): .chezmoiscripts/run_onchange_after_hermes-custom-roll.sh.tmpl (rendered)"
    else
      failed=1
    fi
  else
    echo "ok(sh -n): .chezmoiscripts/run_onchange_after_hermes-custom-roll.sh.tmpl (rendered)"
  fi

  if ((HAS_ZSH)); then
    H="$REPO_ROOT/.claude/skills/verify-dotfiles/verify-dotfiles.sh"
    for host in darwin Arch; do
      eval "$("$H" launch --host "$host")"
      "$H" doctor "$RUN_ID" >/dev/null
      if zsh -n "$SCRATCH_HOME/.zshrc"; then
        echo "ok(zsh -n): dot_zshrc.tmpl ($host rendered)"
      else
        failed=1
      fi
      "$H" cleanup "$RUN_ID" >/dev/null
    done
  fi
fi

exit "$failed"
