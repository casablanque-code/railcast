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
echo "Downloading railcast $tag for $os/$arch..."

mkdir -p "$INSTALL_DIR"
tmp_path="$BIN_PATH.download"
if ! curl -fsSL "$url" -o "$tmp_path"; then
  echo "railcast install: couldn't download $url — that release may not include a $os/$arch build." >&2
  rm -f "$tmp_path"
  exit 1
fi
chmod +x "$tmp_path"
mv "$tmp_path" "$BIN_PATH"

echo "Installed to $BIN_PATH"

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
