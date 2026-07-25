#!/usr/bin/env bash
#
# setup-tls.sh — Issue & verify the Let's Encrypt TLS certificate for
#                agent.sea-agents.ru (feature F-0.8, Phase 0 network contour)
#
# Run ON the VPS as root:
#   ssh root@185.219.41.46
#   bash /opt/fan-agent/deploy/scripts/setup-tls.sh
#
# The script is IDEMPOTENT — safe to re-run at any time:
#   - an existing valid certificate is not re-issued
#   - certbot / certbot.timer are only installed/enabled when missing
#
# What it does:
#   1. Verifies DNS: agent.sea-agents.ru must resolve to 185.219.41.46
#   2. Ensures certbot (+ nginx plugin) is installed
#   3. Issues the certificate via `certbot certonly --nginx` (if absent)
#   4. Ensures the certbot systemd renewal timer is enabled & active
#   5. Verifies renewal with `certbot renew --dry-run`
#   6. Prints certificate validity dates (openssl x509 -dates)
#
# Covers TDD cases TC-F-0.8-1 (certificate issued & valid) and
# TC-F-0.8-2 (automatic renewal works).
#
# Env vars:
#   CERTBOT_EMAIL  — if set, issuance runs non-interactively
#                    (--non-interactive --agree-tos -m "$CERTBOT_EMAIL").
#                    If unset, certbot runs interactively (prompts for email).
#
set -euo pipefail

# ── Configuration ───────────────────────────────────────
DOMAIN="agent.sea-agents.ru"
EXPECTED_IP="185.219.41.46"
LIVE_DIR="/etc/letsencrypt/live/${DOMAIN}"

# ── Helpers ─────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo -e "\n${GREEN}==>${NC} $*"; }
ok()   { echo -e "    ${GREEN}[OK]${NC} $*"; }
warn() { echo -e "    ${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "    ${RED}[FAIL]${NC} $*" >&2; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
    fail "Run as root (certificate paths and systemd require root)."
fi

# ── 1. DNS check ────────────────────────────────────────
step "1/6 Checking DNS: ${DOMAIN} must resolve to ${EXPECTED_IP}"

RESOLVED=""
if command -v dig >/dev/null 2>&1; then
    RESOLVED="$(dig +short A "${DOMAIN}" | tr '\n' ' ')"
elif command -v host >/dev/null 2>&1; then
    RESOLVED="$(host -t A "${DOMAIN}" | awk '/has address/ {print $4}' | paste -sd' ' -)"
else
    warn "Neither 'dig' nor 'host' found — install dnsutils/bind-utils for a strict check."
    warn "Falling back to getent: $(getent hosts "${DOMAIN}" || echo 'no result')"
    RESOLVED="$(getent hosts "${DOMAIN}" | awk '{print $1}' | paste -sd' ' -)"
fi

if [[ -z "${RESOLVED}" ]]; then
    fail "DNS: ${DOMAIN} does not resolve at all. Create the A record first (manual step)."
fi
ok "Resolved A records: ${RESOLVED}"

FOUND=0
for ip in ${RESOLVED}; do
    [[ "${ip}" == "${EXPECTED_IP}" ]] && FOUND=1
done
if [[ "${FOUND}" -ne 1 ]]; then
    fail "DNS: ${DOMAIN} does not point to ${EXPECTED_IP}. Fix the A record and wait for propagation."
fi
ok "DNS OK: ${DOMAIN} → ${EXPECTED_IP}"

# ── 2. certbot installed ────────────────────────────────
step "2/6 Checking certbot installation"

if command -v certbot >/dev/null 2>&1; then
    ok "certbot found: $(certbot --version 2>&1)"
else
    warn "certbot not found — installing (certbot python3-certbot-nginx)..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    command -v certbot >/dev/null 2>&1 || fail "certbot installation failed."
    ok "certbot installed: $(certbot --version 2>&1)"
fi

# ── 3. Issue certificate (idempotent) ───────────────────
step "3/6 Checking / issuing certificate for ${DOMAIN}"

if [[ -f "${LIVE_DIR}/fullchain.pem" && -f "${LIVE_DIR}/privkey.pem" ]]; then
    ok "Certificate already present in ${LIVE_DIR} — skipping issuance (idempotent)."
else
    EMAIL_ARGS=()
    if [[ -n "${CERTBOT_EMAIL:-}" ]]; then
        EMAIL_ARGS=(--non-interactive --agree-tos -m "${CERTBOT_EMAIL}")
        warn "Non-interactive mode (CERTBOT_EMAIL=${CERTBOT_EMAIL})"
    else
        warn "CERTBOT_EMAIL not set — certbot will prompt interactively."
    fi
    # --nginx: temporary ACME challenge block on port 80 (FAN Store unaffected).
    # --keep-until-expiring: extra idempotency guard if the cert exists but
    # live/ symlinks were altered.
    certbot certonly --nginx -d "${DOMAIN}" --keep-until-expiring "${EMAIL_ARGS[@]}"
    [[ -f "${LIVE_DIR}/fullchain.pem" ]] \
        || fail "certbot exited 0 but ${LIVE_DIR}/fullchain.pem is missing."
    ok "Certificate issued: ${LIVE_DIR}"
fi

# ── 4. Renewal timer ────────────────────────────────────
step "4/6 Checking certbot systemd renewal timer (TC-F-0.8-2)"

if ! systemctl list-unit-files certbot.timer >/dev/null 2>&1; then
    fail "certbot.timer unit not found — unexpected for the apt certbot package."
fi
if systemctl is-active --quiet certbot.timer && systemctl is-enabled --quiet certbot.timer; then
    ok "certbot.timer is enabled and active (shared with fan.sea-agents.ru)."
else
    warn "certbot.timer not active/enabled — enabling now..."
    systemctl enable --now certbot.timer
    ok "certbot.timer enabled and started."
fi
systemctl status certbot.timer --no-pager --lines=3 || true

# ── 5. Renewal dry-run ──────────────────────────────────
step "5/6 Verifying renewal: certbot renew --dry-run"

if certbot renew --dry-run; then
    ok "Renewal dry-run passed (TC-F-0.8-2)."
else
    fail "certbot renew --dry-run failed — inspect output above before continuing."
fi

# ── 6. Certificate dates ────────────────────────────────
step "6/6 Certificate validity (TC-F-0.8-1)"

openssl x509 -in "${LIVE_DIR}/fullchain.pem" -noout -subject -issuer -dates

NOT_AFTER="$(openssl x509 -in "${LIVE_DIR}/fullchain.pem" -noout -enddate | cut -d= -f2)"
EXP_EPOCH="$(date -d "${NOT_AFTER}" +%s)"
NOW_EPOCH="$(date +%s)"
DAYS_LEFT=$(( (EXP_EPOCH - NOW_EPOCH) / 86400 ))

if [[ "${DAYS_LEFT}" -le 0 ]]; then
    fail "Certificate is EXPIRED (${DAYS_LEFT} days)."
fi
ok "Certificate valid for ${DAYS_LEFT} more day(s) (Let's Encrypt: 90-day certs)."

step "DONE — TLS for ${DOMAIN} is set up."
echo "    nginx paths expected by deploy/nginx/agent.sea-agents.ru.conf:"
echo "      ssl_certificate     ${LIVE_DIR}/fullchain.pem"
echo "      ssl_certificate_key ${LIVE_DIR}/privkey.pem"
