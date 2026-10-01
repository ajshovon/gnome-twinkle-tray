#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="twinkle-tray@local"
TARGET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$EXT_UUID"

echo "==> Installing $EXT_UUID"

if ! command -v python3 >/dev/null 2>&1; then
    echo "  python3 not found — install it first: sudo dnf install python3"
fi
if ! ls /dev/i2c-* >/dev/null 2>&1; then
    echo "  /dev/i2c-* missing — load the module: sudo modprobe i2c-dev"
    echo "  (persist with: echo i2c-dev | sudo tee /etc/modules-load.d/i2c-dev.conf)"
elif ! [ -r "$(ls /dev/i2c-* | head -1)" ] || ! [ -w "$(ls /dev/i2c-* | head -1)" ]; then
    echo "  no read/write access to /dev/i2c-* — run: sudo usermod -aG i2c \$USER (then log in again)"
fi

glib-compile-schemas "$SCRIPT_DIR/schemas/"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -r "$SCRIPT_DIR"/{metadata.json,extension.js,indicator.js,ddc.js,ddc-helper.py,prefs.js,stylesheet.css,schemas,icons} "$TARGET_DIR/"

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "$EXT_UUID" 2>/dev/null || true
fi

echo "==> Done. GNOME Shell on Wayland loads the new code after you log out and back in."
echo "    Check with: gnome-extensions info $EXT_UUID"
