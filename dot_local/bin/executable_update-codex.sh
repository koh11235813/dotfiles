#!/usr/bin/env zsh


set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "do not run this script with sudo" >&2
  echo "run it as your normal user; the script will use sudo only for install" >&2
  exit 1
fi

repo="openai/codex"
install_path="/usr/local/bin/codex"

script_name="${0:t}"

usage() {
  echo "usage: $script_name [stable|alpha]" >&2
}

if [ "$#" -gt 1 ]; then
  usage
  exit 1
fi

requested_channel="${1:-}"
case "$requested_channel" in
  ""|stable|alpha)
    ;;
  *)
    usage
    exit 1
    ;;
esac

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing dependency: $1" >&2
    exit 1
  }
}

need gh
need tar
need awk
need uname

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

current_version="$(codex --version 2>/dev/null | awk '{print $2}' || true)"

if [ -n "$current_version" ]; then
  current_tag="rust-v${current_version}"
else
  current_tag=""
fi

os="$(uname -s)"
arch="$(uname -m)"

case "$os:$arch" in
  Darwin:arm64)
    asset="codex-aarch64-apple-darwin.tar.gz"
    bin="codex-aarch64-apple-darwin"
    ;;
  Darwin:x86_64)
    asset="codex-x86_64-apple-darwin.tar.gz"
    bin="codex-x86_64-apple-darwin"
    ;;
  Linux:x86_64)
    asset="codex-x86_64-unknown-linux-musl.tar.gz"
    bin="codex-x86_64-unknown-linux-musl"
    ;;
  Linux:aarch64|Linux:arm64)
    asset="codex-aarch64-unknown-linux-musl.tar.gz"
    bin="codex-aarch64-unknown-linux-musl"
    ;;
  *)
    echo "unsupported platform: $os $arch" >&2
    exit 1
    ;;
esac

# If no channel is requested, keep following the currently installed channel.
if [ -n "$requested_channel" ]; then
  channel="$requested_channel"
elif printf '%s\n' "$current_version" | grep -Eq -- '-alpha\.'; then
  channel="alpha"
else
  channel="stable"
fi

case "$channel" in
  alpha)
    latest_tag="$(
      gh release list \
        --repo "$repo" \
        --exclude-drafts \
        --json tagName,isPrerelease,publishedAt \
        --jq '
          map(select((.tagName | startswith("rust-v")) and .isPrerelease == true))
          | sort_by(.publishedAt)
          | reverse
          | .[0].tagName
        '
    )"
    ;;
  stable)
    latest_tag="$(
      gh release list \
        --repo "$repo" \
        --exclude-drafts \
        --exclude-pre-releases \
        --json tagName,isPrerelease,publishedAt \
        --jq '
          map(select(.tagName | startswith("rust-v")))
          | sort_by(.publishedAt)
          | reverse
          | .[0].tagName
        '
    )"
    ;;
esac

if [ -z "$latest_tag" ] || [ "$latest_tag" = "null" ]; then
  echo "could not find latest Codex release for channel: $channel" >&2
  exit 1
fi

echo "channel: $channel"
echo "current: ${current_tag:-not installed}"
echo "latest:  $latest_tag"

if [ "$current_tag" = "$latest_tag" ]; then
  echo "codex is already up to date"
  exit 0
fi

gh release download "$latest_tag" \
  --repo "$repo" \
  --pattern "$asset" \
  --dir "$tmp" \
  --clobber

tar -xzf "$tmp/$asset" -C "$tmp"
chmod +x "$tmp/$bin"

sudo install -m 0755 "$tmp/$bin" "$install_path"

echo "installed: $("$install_path" --version)"
