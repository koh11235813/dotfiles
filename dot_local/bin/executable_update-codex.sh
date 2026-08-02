#!/usr/bin/env zsh


set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "do not run this script with sudo" >&2
  echo "run it as your normal user; the script will use sudo only for install" >&2
  exit 1
fi

repo="openai/codex"
bin_dir="/usr/local/bin"
install_path="$bin_dir/codex"
lib_root="/usr/local/lib/codex"

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
need sudo

tmp="$(mktemp -d)"
stage=""

cleanup() {
  rm -rf "$tmp"
  # The staging directory lives under $lib_root so the final mv is atomic;
  # it is root-owned, so removing it needs sudo.
  if [ -n "$stage" ] && [ -d "$stage" ]; then
    sudo rm -rf "$stage"
  fi
}
trap cleanup EXIT

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
    target="aarch64-apple-darwin"
    ;;
  Darwin:x86_64)
    target="x86_64-apple-darwin"
    ;;
  Linux:x86_64)
    target="x86_64-unknown-linux-musl"
    ;;
  Linux:aarch64|Linux:arm64)
    target="aarch64-unknown-linux-musl"
    ;;
  *)
    echo "unsupported platform: $os $arch" >&2
    exit 1
    ;;
esac

case "$os" in
  Darwin)
    sha256_cmd=(shasum -a 256)
    ;;
  Linux)
    sha256_cmd=(sha256sum)
    ;;
esac
need "${sha256_cmd[1]}"

# Upstream ships Codex as a package directory (bin/codex, bin/codex-code-mode-host,
# codex-path/rg, codex-resources/...), not a lone executable. codex walks up from
# its own resolved path to codex-package.json to find those siblings.
asset="codex-package-${target}.tar.gz"
sums_asset="codex-package_SHA256SUMS"

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
  --pattern "$sums_asset" \
  --dir "$tmp" \
  --clobber

expected_digest="$(awk -v a="$asset" '$2 == a { print $1 }' "$tmp/$sums_asset")"
if [ -z "$expected_digest" ]; then
  echo "no SHA-256 digest for $asset in $sums_asset" >&2
  exit 1
fi

actual_digest="$("${sha256_cmd[@]}" "$tmp/$asset" | awk '{print $1}')"
if [ "$expected_digest" != "$actual_digest" ]; then
  echo "checksum mismatch for $asset" >&2
  echo "  expected: $expected_digest" >&2
  echo "  actual:   $actual_digest" >&2
  exit 1
fi

version="${latest_tag#rust-v}"
release_dir="$lib_root/${version}-${target}"
stage="$lib_root/.staging.$$"

sudo mkdir -p "$lib_root"
sudo rm -rf "$stage"
sudo mkdir -p "$stage"
# The archive records the CI account (runner:staff), and root-run tar would
# otherwise restore that ownership onto files reachable from PATH.
sudo tar -xzf "$tmp/$asset" --no-same-owner -C "$stage"

sudo chmod 0755 \
  "$stage/bin/codex" \
  "$stage/bin/codex-code-mode-host" \
  "$stage/codex-path/rg"

# bwrap is only packaged for Linux targets.
if [ -f "$stage/codex-resources/bwrap" ]; then
  sudo chmod 0755 "$stage/codex-resources/bwrap"
fi

sudo rm -rf "$release_dir"
sudo mv "$stage" "$release_dir"
stage=""

sudo ln -sfn "$release_dir/bin/codex" "$install_path"
sudo ln -sfn "$release_dir/bin/codex-code-mode-host" "$bin_dir/codex-code-mode-host"

# Each release unpacks to ~260MB; keep the current one plus a single fallback.
prune_old_releases() {
  setopt local_options null_glob
  old="$(
    ls -dt "$lib_root"/*/ 2>/dev/null \
      | sed 's:/*$::' \
      | grep -v '/\.staging\.' \
      | tail -n +3 \
      || true
  )"
  [ -n "$old" ] || return 0
  printf '%s\n' "$old" | while IFS= read -r dir; do
    if [ "$dir" = "$release_dir" ]; then
      continue
    fi
    echo "removing old release: $dir"
    sudo rm -rf "$dir"
  done
}
prune_old_releases

echo "installed: $("$install_path" --version)"
