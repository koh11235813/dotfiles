#!/usr/bin/env bash
# Isolated driver for the chezmoi dotfiles repo. See SKILL.md next to this file.
# Must stay bash: zsh does not word-split, and the flag array is the safety boundary.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)
EVIDENCE_ROOT=${VERIFY_DOTFILES_EVIDENCE:-${XDG_STATE_HOME:-$HOME/.local/state}/verify-dotfiles}
REAL_STATE_DB=${XDG_CONFIG_HOME:-$HOME/.config}/chezmoi/chezmoistate.boltdb
REAL_SETTINGS=$HOME/.claude/settings.json
# First apply on an empty home only; see Gotchas in SKILL.md.
FRESH_DRIFT=' M .codex/config.toml'

die() { echo "verify-dotfiles: $*" >&2; exit 1; }
log() { echo "verify-dotfiles: $*" >&2; }

usage() {
  cat >&2 <<'EOF'
usage: verify-dotfiles.sh <command>
  launch [--host native|darwin|Arch|Lab-Arch|other] [--no-apply] [--dest DIR]
  paths <run-id>
  doctor <run-id>
  chez <run-id> <apply|verify|diff|status|managed|cat|source-path|data> [args]
  capture <run-id> <label> [--home] -- <command...>
  cleanup <run-id>
EOF
  exit 2
}

mtime() {
  python3 -c 'import os,sys
try: print(os.stat(sys.argv[1]).st_mtime_ns)
except FileNotFoundError: print("absent")' "$1"
}

# Refuses $HOME and anything containing it. Also checks the passwd home, because
# recipes run hooks with HOME pointed at the scratch home.
assert_dest_safe() {
  python3 - "$1" "$HOME" <<'PY' || die "refusing destination $1: it resolves to \$HOME or a parent of it"
import os, pwd, sys
dest = os.path.realpath(sys.argv[1])
homes = {os.path.realpath(sys.argv[2]), os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)}
sys.exit(1 if any(os.path.commonpath([dest, h]) == dest for h in homes) else 0)
PY
}

load_run() {
  RUN_ID=${1:-}
  [[ $RUN_ID =~ ^[0-9]{8}-[0-9]{6}-[0-9]+$ ]] || die "bad run id: '$RUN_ID'"
  EVIDENCE=$EVIDENCE_ROOT/$RUN_ID
  [[ -f $EVIDENCE/scratch-path ]] || die "no such run: $EVIDENCE"
  SCRATCH=$(<"$EVIDENCE/scratch-path")
  DEST=$(<"$EVIDENCE/dest-path")
  OVERRIDE=$(<"$EVIDENCE/override-data")
}

# The only place chezmoi touches a source, config, state, or destination. Its defaults
# are the real ones, so every call has to pass all four.
chz() {
  local verb=$1; shift
  assert_dest_safe "$DEST"
  local flags=(--source "$REPO" --config "$SCRATCH/config.toml" --persistent-state "$SCRATCH/state.db" --destination "$DEST")
  [[ -n $OVERRIDE ]] && flags+=(--override-data "$OVERRIDE")
  case $verb in
    apply) flags+=(--exclude=scripts --force) ;;
    diff) flags+=(--exclude=scripts --no-pager) ;;
    verify|status|managed) flags+=(--exclude=scripts) ;;
  esac
  chezmoi "$verb" "${flags[@]}" "$@"
}

print_paths() {
  printf 'RUN_ID=%q\nSCRATCH_HOME=%q\nEVIDENCE=%q\n' "$RUN_ID" "$DEST" "$EVIDENCE"
}

cmd_launch() {
  local host=native apply=1 dest=
  while (($#)); do
    case $1 in
      --host) host=${2:?}; shift 2 ;;
      --no-apply) apply=0; shift ;;
      --dest) dest=${2:?}; shift 2 ;;
      *) usage ;;
    esac
  done
  case $host in
    native) OVERRIDE= ;;
    darwin) OVERRIDE='{"chezmoi":{"hostname":"other","os":"darwin"}}' ;;
    Arch|Lab-Arch|other) OVERRIDE="{\"chezmoi\":{\"hostname\":\"$host\",\"os\":\"linux\"}}" ;;
    *) usage ;;
  esac
  if [[ -n $dest ]]; then
    assert_dest_safe "$dest"
    [[ ! -e $dest || -z $(ls -A "$dest") ]] || die "refusing non-empty destination $dest"
  fi

  RUN_ID=$(date +%Y%m%d-%H%M%S)-$$
  EVIDENCE=$EVIDENCE_ROOT/$RUN_ID
  SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/verify-dotfiles.XXXXXX")
  SCRATCH=$(cd "$SCRATCH" && pwd -P)
  DEST=${dest:-$SCRATCH/home}
  mkdir -p "$EVIDENCE" "$DEST"
  DEST=$(cd "$DEST" && pwd -P)
  echo "$RUN_ID" > "$SCRATCH/.verify-dotfiles-run"
  echo "$SCRATCH" > "$EVIDENCE/scratch-path"
  echo "$DEST" > "$EVIDENCE/dest-path"
  echo "$OVERRIDE" > "$EVIDENCE/override-data"
  echo "$host" > "$EVIDENCE/host"
  print_paths
  { mtime "$REAL_STATE_DB"; mtime "$REAL_SETTINGS"; } > "$EVIDENCE/baseline-mtimes"
  { chezmoi --version; git -C "$REPO" rev-parse HEAD; git -C "$REPO" status --short; } > "$EVIDENCE/source.txt"

  # Config bootstrap: an empty config file instead of a real one, then the repo's own template.
  : > "$SCRATCH/config.toml"
  chz execute-template --init < "$REPO/.chezmoi.toml.tmpl" > "$SCRATCH/rendered.toml"
  mv "$SCRATCH/rendered.toml" "$SCRATCH/config.toml"

  ((apply)) || { touch "$EVIDENCE/ready"; log "ready (nothing applied): $DEST"; return; }
  chz apply 2> "$EVIDENCE/launch-apply.err" || die "apply failed; see $EVIDENCE/launch-apply.err"
  chz status > "$EVIDENCE/launch-status.txt" 2>> "$EVIDENCE/launch-apply.err"
  local status
  status=$(<"$EVIDENCE/launch-status.txt")
  [[ -z $status || $status == "$FRESH_DRIFT" ]] || die "not ready, unexpected drift after apply: $status"
  touch "$EVIDENCE/ready"
  log "ready: $DEST (host $host)"
}

cmd_doctor() {
  load_run "${1:-}"
  local fail=0 got base
  check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; fail=1; fi; }
  command -v chezmoi >/dev/null || die "chezmoi not on PATH"
  echo "info  $(chezmoi --version)"
  echo "info  host $(<"$EVIDENCE/host"), evidence $EVIDENCE"
  check "scratch exists: $SCRATCH" '[[ -f $SCRATCH/.verify-dotfiles-run ]]'
  check "launch reached ready" '[[ -f $EVIDENCE/ready ]]'
  [[ $fail == 0 ]] || { echo "not worth driving: the run was cleaned up or launch failed; see $EVIDENCE"; return 1; }
  got=$(chz source-path); check "source is this repo: $got" '[[ $got == "$REPO" ]]'
  got=$(chz data --format=json | python3 -c 'import json,sys;c=json.load(sys.stdin)["chezmoi"];print(c["destDir"]);print(c["hostname"],c["os"])')
  echo "info  rendering as: ${got#*$'\n'}"
  check "destination is the scratch one: ${got%%$'\n'*}" '[[ ${got%%$'"'"'\n'"'"'*} == "$DEST" ]]'
  check 'destination is not $HOME or a parent of it' '(assert_dest_safe "$DEST")'
  base=$(sed -n 1p "$EVIDENCE/baseline-mtimes")
  check "real state db unchanged since launch: $REAL_STATE_DB" '[[ $(mtime "$REAL_STATE_DB") == "$base" ]]'
  local rel=${EVIDENCE_ROOT#"$HOME"/}
  got=$(chz managed | grep -E "^${rel%%/*}/${rel#*/}(/|\$)" || true)
  check "evidence root is not managed by chezmoi: $EVIDENCE_ROOT" '[[ -z $got ]]'
  if [[ $(mtime "$REAL_SETTINGS") != "$(sed -n 2p "$EVIDENCE/baseline-mtimes")" ]]; then
    echo "warn  $REAL_SETTINGS changed since launch; Claude Code or the user may have written it"
  fi
  return "$fail"
}

cmd_chez() {
  load_run "${1:-}"; shift || usage
  local verb=${1:-}; shift || usage
  case $verb in
    apply|verify|diff|status|managed|cat|source-path|data) ;;
    *) die "chez does not run '$verb'" ;;
  esac
  local a
  for a in "$@"; do
    case $a in
      --destination*|-D*|--source*|-S*|--config*|-c*|--persistent-state*|--override-data*)
        die "chez sets $a itself" ;;
    esac
  done
  chz "$verb" "$@"
}

cmd_capture() {
  load_run "${1:-}"; shift || usage
  local label=${1:-}; shift || usage
  [[ $label =~ ^[A-Za-z0-9._-]+$ ]] || die "bad label: '$label'"
  local home=0
  [[ ${1:-} == --home ]] && { home=1; shift; }
  [[ ${1:-} == -- ]] || usage
  shift
  (($#)) || usage
  local rc=0 base=$EVIDENCE/$label
  printf '%q ' "$@" > "$base.cmd"; echo >> "$base.cmd"
  if ((home)); then
    echo "HOME=$DEST" >> "$base.cmd"
    HOME=$DEST "$@" > "$base.out" 2> "$base.err" < /dev/null || rc=$?
  else
    "$@" > "$base.out" 2> "$base.err" < /dev/null || rc=$?
  fi
  echo "$rc" > "$base.rc"
  log "$label rc=$rc -> $base.{cmd,out,err,rc}"
  return "$rc"
}

cmd_cleanup() {
  load_run "${1:-}"
  if [[ ! -e $SCRATCH ]]; then
    log "scratch already gone: $SCRATCH"
  else
    [[ $(<"$SCRATCH/.verify-dotfiles-run") == "$RUN_ID" ]] || die "$SCRATCH is not this run's scratch; leaving it"
    rm -rf "$SCRATCH"
    log "removed $SCRATCH"
  fi
  [[ $DEST == "$SCRATCH"/* ]] || log "--dest $DEST was yours; left in place"
  date -u +%FT%TZ > "$EVIDENCE/cleaned-at"
  echo "EVIDENCE=$EVIDENCE"
}

cmd=${1:-}; shift || usage
case $cmd in
  launch) cmd_launch "$@" ;;
  paths) load_run "${1:-}"; print_paths ;;
  doctor) cmd_doctor "$@" ;;
  chez) cmd_chez "$@" ;;
  capture) cmd_capture "$@" ;;
  cleanup) cmd_cleanup "$@" ;;
  *) usage ;;
esac
