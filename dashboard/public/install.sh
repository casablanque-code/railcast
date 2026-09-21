#!/bin/sh
# Installs the railcast CLI.
#   curl -fsSL https://railcast.casablanque.com/install.sh | sh
set -e

REPO="casablanque-code/railcast"
INSTALL_DIR="$HOME/.railcast/bin"
BIN_PATH="$INSTALL_DIR/railcast"

os=$(uname -s)
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "railcast install: you're on Windows — this script (install.sh) is for macOS/Linux." >&2
    echo "Use the PowerShell installer instead:" >&2
    echo "  irm https://railcast.casablanque.com/install.ps1 | iex" >&2
    exit 1
    ;;
  *)
    echo "railcast install: unsupported OS '$os' — download a binary manually from https://github.com/$REPO/releases" >&2
    exit 1
    ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  *)
    echo "railcast install: unsupported architecture '$arch' — download a binary manually from https://github.com/$REPO/releases" >&2
    exit 1
    ;;
esac

echo "Finding the latest release..."
tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -n 1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
if [ -z "$tag" ]; then
  echo "railcast install: couldn't determine the latest release — download a binary manually from https://github.com/$REPO/releases" >&2
  exit 1
fi

url="https://github.com/$REPO/releases/download/$tag/railcast-$tag-$os-$arch"
sha_url="$url.sha256"
echo "Downloading railcast $tag for $os/$arch..."

mkdir -p "$INSTALL_DIR"
tmp_path="$BIN_PATH.download"
if ! curl -fsSL "$url" -o "$tmp_path"; then
  echo "railcast install: couldn't download $url — that release may not include a $os/$arch build." >&2
  rm -f "$tmp_path"
  exit 1
fi

# Every release binary is published with a matching *.sha256 file (see
# .github/workflows/release.yml) — verify the download against it before
# anything gets chmod +x'd and put on PATH, so a corrupted download or a
# tampered mirror doesn't get silently installed.
tmp_sha_path="$tmp_path.sha256"
if ! curl -fsSL "$sha_url" -o "$tmp_sha_path"; then
  echo "railcast install: couldn't download $sha_url to verify the binary — refusing to install an unverified download." >&2
  rm -f "$tmp_path" "$tmp_sha_path"
  exit 1
fi

expected_sha=$(awk '{print $1}' "$tmp_sha_path")
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha=$(sha256sum "$tmp_path" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_sha=$(shasum -a 256 "$tmp_path" | awk '{print $1}')
else
  echo "railcast install: neither sha256sum nor shasum is available — can't verify the download, refusing to install." >&2
  rm -f "$tmp_path" "$tmp_sha_path"
  exit 1
fi

if [ -z "$expected_sha" ] || [ "$expected_sha" != "$actual_sha" ]; then
  echo "railcast install: checksum mismatch for $url" >&2
  echo "  expected: ${expected_sha:-<empty>}" >&2
  echo "  got:      $actual_sha" >&2
  echo "The download may be corrupted, or the release/mirror may have been tampered with. Not installing." >&2
  rm -f "$tmp_path" "$tmp_sha_path"
  exit 1
fi
rm -f "$tmp_sha_path"

chmod +x "$tmp_path"
mv "$tmp_path" "$BIN_PATH"

echo "Installed to $BIN_PATH (sha256 verified)"

path_line="export PATH=\"$INSTALL_DIR:\$PATH\""
added=0
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [ -f "$rc" ] || [ "$rc" = "$HOME/.zshrc" ] || [ "$rc" = "$HOME/.bashrc" ]; then
    touch "$rc" 2>/dev/null || continue
    if ! grep -qF "$INSTALL_DIR" "$rc" 2>/dev/null; then
      printf '\n# added by railcast install.sh\n%s\n' "$path_line" >> "$rc"
      echo "Added $INSTALL_DIR to PATH in $rc"
      added=1
    fi
  fi
done

echo
if [ "$added" = "1" ]; then
  echo "Open a new terminal (or run: source ~/.zshrc  /  source ~/.bashrc) and run:"
else
  echo "$INSTALL_DIR is already on your PATH. Run:"
fi
echo "  railcast version"
