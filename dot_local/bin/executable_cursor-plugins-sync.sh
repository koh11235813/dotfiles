#!/usr/bin/env zsh

set -euo pipefail

# Sync github.com/cursor/plugins into a Claude Code compatible marketplace.
#
# Cursor plugins use a `.cursor-plugin/` manifest directory; Claude Code only
# reads `.claude-plugin/`. The schemas are otherwise near-identical, so this
# script maintains a generated `.claude-plugin/` alongside each upstream
# `.cursor-plugin/` and registers the result as a local marketplace.

repo_url="https://github.com/cursor/plugins.git"
marketplace_name="cursor-plugins"
dest="${CURSOR_PLUGINS_DIR:-$HOME/.local/share/cursor-plugins}"

script_name="${0:t}"

usage() {
  echo "usage: $script_name [-d dest]" >&2
  echo "  -d dest   checkout directory (default: $dest)" >&2
  echo "            may also be set via CURSOR_PLUGINS_DIR" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -d)
      if [ "$#" -lt 2 ]; then
        usage
        exit 1
      fi
      dest="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

for cmd in git jq claude; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$script_name: required command not found: $cmd" >&2
    exit 1
  fi
done

# 1. fetch upstream
if [ -d "$dest/.git" ]; then
  echo "==> updating $dest"
  git -C "$dest" pull --ff-only
else
  echo "==> cloning into $dest"
  mkdir -p "${dest:h}"
  git clone --depth 1 "$repo_url" "$dest"
fi

cd "$dest"

# 2. rebuild the generated manifests from scratch so re-runs stay idempotent
echo "==> regenerating .claude-plugin manifests"
find . -name .claude-plugin -type d -prune -exec rm -rf {} +
find . -name .cursor-plugin -type d | while read -r d; do
  cp -R "$d" "${d:h}/.claude-plugin"
done

# 3. Claude Code requires marketplace sources to be explicitly relative
sed -i '' 's#"source": "\([^./][^"]*\)"#"source": "./\1"#' .claude-plugin/marketplace.json

# 4. drop the keys Claude Code rejects; skills/agents/commands are auto-detected
#    by directory convention, and Cursor declares them as strings rather than
#    the arrays Claude Code expects. Only the generated copies are touched so
#    the checkout stays clean for the next `git pull`.
find . -path '*/.claude-plugin/plugin.json' | while read -r f; do
  jq 'del(.agents, .skills, .commands, .hooks, .rules)' "$f" >"$f.tmp"
  mv "$f.tmp" "$f"
done

# 5. MCP-backed plugins ship `mcp.json`; Claude Code looks for `.mcp.json`
find . -maxdepth 3 -name mcp.json -not -path '*/.claude-plugin/*' | while read -r m; do
  cp "$m" "${m:h}/.mcp.json"
done

# 6. register or refresh the marketplace
if claude plugin marketplace list 2>/dev/null | grep -q "$marketplace_name"; then
  echo "==> updating marketplace $marketplace_name"
  claude plugin marketplace update "$marketplace_name"
else
  echo "==> adding marketplace $marketplace_name"
  claude plugin marketplace add "$dest"
fi

echo
echo "done. install plugins with:"
echo "  claude plugin install <name>@$marketplace_name"
