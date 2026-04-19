#!/usr/bin/env bash
#
# setup-vps.sh — One-shot setup of FAN package repository on Ubuntu VPS
#
# Usage:
#   ./setup-vps.sh <user@host>
#
# Example:
#   ./setup-vps.sh root@203.0.113.50
#
# What it does:
#   1. Installs Nginx, Apache utilities (for htpasswd)
#   2. Creates /var/www/fan-repo/
#   3. Generates htpasswd file (prompts for username/password)
#   4. Deploys Nginx config with Basic Auth
#   5. Enables and starts Nginx
#
set -euo pipefail

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ── Args ────────────────────────────────────────────────
SSH_TARGET="${1:-}"
if [[ -z "$SSH_TARGET" ]]; then
    echo "Usage: $0 <user@host>"
    echo "Example: $0 root@203.0.113.50"
    exit 1
fi

# Verify SSH connectivity + auto-accept host key
info "Checking SSH connection to $SSH_TARGET..."
ssh-keyscan -H "$(echo "$SSH_TARGET" | cut -d@ -f2)" >> ~/.ssh/known_hosts 2>/dev/null
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$SSH_TARGET" "echo ok" >/dev/null 2>&1 || error "Cannot connect to $SSH_TARGET. Check SSH config."

# ── Auth credentials ────────────────────────────────────
AUTH_USER="${2:-fan}"
AUTH_PASS="${3:-}"
if [[ -z "$AUTH_PASS" ]]; then
    AUTH_PASS=$(openssl rand -base64 18)
fi
info "Auth: $AUTH_USER / $(echo "$AUTH_PASS" | head -c4)***"

# ── Setup ───────────────────────────────────────────────
info "Setting up FAN repository server on $SSH_TARGET..."

ssh "$SSH_TARGET" bash -s <<REMOTE_SCRIPT
set -euo pipefail

# 1. Update & install packages
echo "[1/5] Installing Nginx and apache2-utils..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx apache2-utils >/dev/null

# 2. Create repo directory
echo "[2/5] Creating /var/www/fan-repo/..."
mkdir -p /var/www/fan-repo/packages

# Place a placeholder index.json
cat > /var/www/fan-repo/index.json <<'EOF'
{
  "repository": {
    "name": "fan-repo",
    "url": "PLACEHOLDER_URL",
    "updatedAt": "2026-04-19T00:00:00Z"
  },
  "packages": []
}
EOF
chown -R www-data:www-data /var/www/fan-repo

# 3. Create htpasswd file
echo "[3/5] Creating htpasswd..."
HTPASSWD_FILE="/etc/nginx/.fan-htpasswd"
htpasswd -cb "\$HTPASSWD_FILE" "$AUTH_USER" "$AUTH_PASS" 2>/dev/null
chmod 640 "\$HTPASSWD_FILE"
chown www-data:www-data "\$HTPASSWD_FILE"

# 4. Deploy Nginx config
echo "[4/5] Deploying Nginx config..."
cat > /etc/nginx/sites-available/fan-repo <<'NGINX'
server {
    listen 80;
    server_name _;

    root /var/www/fan-repo;
    index index.json;

    # Security headers
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;

    # Basic Auth
    auth_basic "FAN Repository";
    auth_basic_user_file /etc/nginx/.fan-htpasswd;

    # Only serve known files
    location / {
        try_files \$uri =404;

        # Short cache for index.json (5 min) so clients see updates quickly
        location = /index.json {
            add_header Cache-Control "no-cache, must-revalidate";
            add_header Content-Type application/json;
        }

        # Longer cache for archives (they never change once published)
        location ~ ^/packages/ {
            add_header Cache-Control "public, max-age=31536000, immutable";
        }
    }

    # Deny everything else
    location ~ /\. {
        deny all;
    }
}
NGINX

# Remove default site, enable fan-repo
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/fan-repo /etc/nginx/sites-enabled/fan-repo

# 5. Test & start
echo "[5/5] Starting Nginx..."
nginx -t
systemctl enable nginx
systemctl restart nginx

echo ""
echo "✅ FAN repository server is ready!"
echo "   Auth: $AUTH_USER / ****"
echo "   Directory: /var/www/fan-repo/"
REMOTE_SCRIPT

echo ""
info "Done! Server is configured."
echo ""
echo "  Repo URL:  http://$(echo "$SSH_TARGET" | cut -d@ -f2)/"
echo "  Auth:      $AUTH_USER"
echo ""
warn "NOTE: Running over HTTP. Add a domain + Let's Encrypt for HTTPS."
echo ""
echo "Next step: configure fan-repo CLI and publish packages."
