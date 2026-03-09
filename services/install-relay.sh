#!/usr/bin/env bash
# ============================================
# Relay CLI Installer
# ============================================
# Installs the relay script as a global command
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/usr/local/bin"
SCRIPT_NAME="relay"

echo "Installing Relay CLI..."
echo ""

# Check if running with sudo for system-wide install
if [[ ! -w "$INSTALL_DIR" ]]; then
    echo "Error: Cannot write to $INSTALL_DIR"
    echo "Please run with sudo:"
    echo "  sudo ./install-relay.sh"
    exit 1
fi

# Create symlink
if [[ -L "$INSTALL_DIR/$SCRIPT_NAME" ]]; then
    echo "Removing existing relay command..."
    rm "$INSTALL_DIR/$SCRIPT_NAME"
fi

echo "Creating symlink: $INSTALL_DIR/$SCRIPT_NAME -> $SCRIPT_DIR/relay.sh"
ln -s "$SCRIPT_DIR/relay.sh" "$INSTALL_DIR/$SCRIPT_NAME"

# Make sure the script is executable
chmod +x "$SCRIPT_DIR/relay.sh"

echo ""
echo "✓ Installation complete!"
echo ""
echo "You can now use 'relay' from anywhere:"
echo "  relay up        # Start services"
echo "  relay down      # Stop services"
echo "  relay logs      # View logs"
echo "  relay splunk    # Check Splunk status"
echo "  relay help      # Show all commands"
echo ""
