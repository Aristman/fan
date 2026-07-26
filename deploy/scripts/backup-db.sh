#!/usr/bin/env bash
#
# backup-db.sh — Daily backup of the FAN SQLite database (feature F-4.15,
#                Phase 4 autonomy)
#
# Backs up the live Prisma/SQLite DB (filin.db) into a backup directory with
# a timestamped name (filin-YYYYMMDD-HHmmss.db) and rotates old copies
# (keeps the newest $KEEP, default 7).
#
# Run ON the VPS (cron) — see docs/guides/scheduler.md for the cron entry:
#   0 3 * * * /opt/fan-agent/deploy/scripts/backup-db.sh >> /var/log/fan-backup.log 2>&1
#
# The script is IDEMPOTENT — safe to re-run at any time:
#   - a backup for the current second is not re-created (skipped if present)
#   - rotation always converges to the newest $KEEP files
#
# Copy mechanism (documented choice):
#   filin.db is a LIVE SQLite database — a bare `cp` can snapshot the file in
#   the middle of a write and produce a corrupted copy (WAL mode makes this
#   worse: the -wal sidecar holds uncommitted pages).
#   Therefore:
#     1. If the `sqlite3` CLI is available, the script uses the online backup
#        API via `sqlite3 "$DB" ".backup '<dest>'"` — this is crash-safe for
#        a live DB (handles WAL, active writers) and is the primary path.
#        The result is verified with `PRAGMA integrity_check`.
#     2. Fallback (no sqlite3 on the host, e.g. a minimal cron container):
#        plain `cp`. Acceptable only because the daily 03:00 window has no
#        scheduled tasks running, so the DB is almost certainly idle. The
#        fallback prints an explicit WARN — install sqlite3 (Debian:
#        `apt-get install -y sqlite3`) to get the safe path.
#
# Failure behavior: any error is logged to stderr and the script exits
# non-zero. It never touches the scheduler process — a cron-level failure is
# isolated (cron logs / mail capture the output).
#
# Env vars (all optional):
#   FAN_AGENT_DIR — agent data dir (default: $HOME/.fan/agent;
#                   in Docker: /data/.fan/agent)
#   DB_PATH       — full path to the DB (default: $FAN_AGENT_DIR/filin.db)
#   BACKUP_DIR    — backup directory (default: $FAN_AGENT_DIR/backups;
#                   in Docker this lives inside the fan-data volume)
#   KEEP          — how many newest backups to retain (default: 7)
#
set -euo pipefail

# ── Configuration ───────────────────────────────────────
AGENT_DIR="${FAN_AGENT_DIR:-${HOME}/.fan/agent}"
DB_PATH="${DB_PATH:-${AGENT_DIR}/filin.db}"
BACKUP_DIR="${BACKUP_DIR:-${AGENT_DIR}/backups}"
KEEP="${KEEP:-7}"

# ── Helpers ─────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo -e "${GREEN}==>${NC} $*"; }
ok()   { echo -e "    ${GREEN}[OK]${NC} $*"; }
warn() { echo -e "    ${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "    ${RED}[FAIL]${NC} $*" >&2; exit 1; }

# ── 1. Preconditions ────────────────────────────────────
[[ -f "${DB_PATH}" ]] || fail "Database not found: ${DB_PATH}"
[[ "${KEEP}" =~ ^[0-9]+$ ]] && [[ "${KEEP}" -ge 1 ]] \
    || fail "KEEP must be a positive integer, got: ${KEEP}"

mkdir -p "${BACKUP_DIR}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${BACKUP_DIR}/filin-${TIMESTAMP}.db"

step "Backing up ${DB_PATH}"
echo "    destination: ${DEST}"
echo "    retention:   keep newest ${KEEP}"

# ── 2. Create the backup ────────────────────────────────
if [[ -f "${DEST}" ]]; then
    # Same-second re-run: the backup already exists — idempotent skip.
    ok "Backup for ${TIMESTAMP} already exists — skipping copy (idempotent)."
elif command -v sqlite3 >/dev/null 2>&1; then
    # Safe online backup of a live DB (primary path).
    sqlite3 "${DB_PATH}" ".backup '${DEST}'" \
        || fail "sqlite3 .backup failed for ${DB_PATH}"
    # Verify the copy is a valid, uncorrupted database.
    INTEGRITY="$(sqlite3 "${DEST}" 'PRAGMA integrity_check;' 2>&1 || true)"
    if [[ "${INTEGRITY}" != "ok" ]]; then
        rm -f "${DEST}"
        fail "integrity_check failed on the copy: ${INTEGRITY}"
    fi
    ok "Backup created via sqlite3 .backup (online-safe), integrity_check: ok"
else
    # Fallback: plain copy of an (assumed idle) DB — see header for caveats.
    warn "sqlite3 CLI not found — falling back to 'cp'."
    warn "cp of a live SQLite DB can capture a mid-write state; install"
    warn "sqlite3 (apt-get install -y sqlite3) for the safe .backup path."
    cp "${DB_PATH}" "${DEST}" \
        || fail "cp failed for ${DB_PATH}"
    ok "Backup created via cp (fallback — DB assumed idle)"
fi

# Backups contain the same secrets as the DB (ClientToken, sessions) —
# restrict permissions to owner-only.
chmod 600 "${DEST}" || warn "chmod 600 failed for ${DEST}"

# ── 3. Rotation: keep newest $KEEP ──────────────────────
step "Rotating backups in ${BACKUP_DIR} (keep ${KEEP})"

# Sorted by name — the YYYYMMDD-HHmmss timestamp makes lexicographic order
# chronological. `ls -1` on a controlled glob is fine here.
mapfile -t BACKUPS < <(ls -1 "${BACKUP_DIR}"/filin-*.db 2>/dev/null || true)
COUNT="${#BACKUPS[@]}"

if [[ "${COUNT}" -le "${KEEP}" ]]; then
    ok "${COUNT} backup(s) present — nothing to rotate."
else
    REMOVE_COUNT=$(( COUNT - KEEP ))
    for (( i = 0; i < REMOVE_COUNT; i++ )); do
        rm -f "${BACKUPS[$i]}"
        ok "Removed old backup: $(basename "${BACKUPS[$i]}")"
    done
    ok "Rotation done: ${KEEP} backup(s) retained."
fi

step "DONE — backup complete."
