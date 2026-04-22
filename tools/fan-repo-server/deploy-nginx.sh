#!/bin/bash
#
# deploy-nginx.sh — Deploy nginx config for FAN repo + dist on VPS
#
# Run as root on the server:
#   bash deploy-nginx.sh
#
set -euo pipefail

CONFIG="/etc/nginx/sites-available/fan-repo"
ENABLED="/etc/nginx/sites-enabled/fan-repo"

echo "==> Deploying nginx config..."

cat > "$CONFIG" << 'NGINX'
server {
    listen 80 default_server;
    server_name _;

    location /fan/ {
        alias /var/www/fan-repo/;
        add_header X-Content-Type-Options nosniff always;

        # FAN Store index
        location = /fan/index.json {
            add_header Cache-Control "no-cache, must-revalidate" always;
            add_header Content-Type application/json always;
        }

        # FAN Store packages (immutable, versioned archives)
        location /fan/packages/ {
            add_header Cache-Control "public, max-age=31536000, immutable" always;
        }

        # Install scripts — always fresh
        location ~ ^/fan/dist/install\.(sh|ps1)$ {
            add_header Cache-Control "no-cache, must-revalidate" always;
            add_header Content-Type text/plain always;
        }

        # Update manifest — always fresh
        location = /fan/dist/manifest.json {
            add_header Cache-Control "no-cache, must-revalidate" always;
            add_header Content-Type application/json always;
        }

        # Platform archives — immutable (versioned in filename)
        location ~ ^/fan/dist/fan-.*\.(tar\.gz|zip)$ {
            add_header Cache-Control "public, max-age=31536000, immutable" always;
        }
    }

    location / {
        return 404;
    }

    location ~ /\. {
        deny all;
    }
}
NGINX

# Enable site
ln -sf "$CONFIG" "$ENABLED"

# Test and reload
echo "==> Testing nginx config..."
nginx -t

echo "==> Reloading nginx..."
systemctl reload nginx

echo ""
echo "Done. Nginx config deployed."

location /fan/ {
    alias /var/www/fan-repo/;
    add_header X-Content-Type-Options nosniff always;

    location = /fan/index.json {
        add_header Cache-Control "no-cache, must-revalidate" always;
        add_header Content-Type application/json always;
    }

    location /fan/packages/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location ~ ^/fan/dist/install\.(sh|ps1)$ {
        add_header Cache-Control "no-cache, must-revalidate" always;
        add_header Content-Type text/plain always;
    }

    location = /fan/dist/manifest.json {
        add_header Cache-Control "no-cache, must-revalidate" always;
        add_header Content-Type application/json always;
    }

    location ~ ^/fan/dist/fan-.*\.(tar\.gz|zip)$ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }
}