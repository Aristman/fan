#!/bin/bash
#
# restore-server.sh — Restore /var/www/fan-repo/ directory structure on VPS
#
# Run as root on the server:
#   bash restore-server.sh
#
set -euo pipefail

REPO_DIR="/var/www/fan-repo"

echo "==> Restoring FAN repo directory structure..."

# Create directories
mkdir -p "$REPO_DIR/packages"
mkdir -p "$REPO_DIR/dist"

# Placeholder index.json
cat > "$REPO_DIR/index.json" << 'EOF'
{
  "repository": {
    "name": "fan-repo",
    "url": "http://185.219.41.46/fan/",
    "updatedAt": "2026-04-21T00:00:00Z"
  },
  "packages": []
}
EOF

# Set ownership
chown -R www-data:www-data "$REPO_DIR"
chmod 755 "$REPO_DIR"

echo "==> Directory structure restored:"
ls -laR "$REPO_DIR/"

echo ""
echo "Done. Next: run deploy-nginx.sh to update the config."
