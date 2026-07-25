#!/usr/bin/env bash
# =============================================================================
# FAN — F-0.11-E2E: end-to-end smoke test on local Docker.
#
# Local Docker is a proxy for the VPS deployment: the same Dockerfile,
# docker-compose.yml and env (FAN_PUBLIC=1, ALLOWED_ORIGINS) are exercised
# here. VPS-specific checks (HTTPS/TLS, wss:// through nginx, certbot) are
# covered by the manual checklist in docs/guides/deployment.md
# ("E2E-проверка после деплоя").
#
# Full cycle:
#   docker compose up -d --build
#   → wait for /api/health (poll with timeout)
#   → 7 checks (health, auth 401, token bootstrap, sessions CRUD, CORS,
#     file logging, WebSocket)
#   → docker compose down (trap on exit)
#
# Exit code 0 only if every check passes (check 7 is optional — skipped
# when neither bun nor wscat is available on the host).
#
# Usage:
#   bash deploy/scripts/e2e-local.sh
# Env overrides:
#   E2E_BASE_URL        default http://127.0.0.1:3456
#   E2E_HEALTH_TIMEOUT  seconds to wait for readiness (default 180)
# =============================================================================
set -euo pipefail

# Git Bash (MSYS) on Windows rewrites absolute POSIX paths in command
# arguments (e.g. /data/logs/app.log → C:/Program Files/Git/data/logs/...)
# which breaks `docker exec` container paths. We therefore disable arg
# conversion for docker exec calls only (MSYS2_ARG_CONV_EXCL="*"). A global
# MSYS_NO_PATHCONV=1 would break the native Windows curl (`-o /dev/null`
# must still be converted to NUL), so it is set per-command.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BASE_URL="${E2E_BASE_URL:-http://127.0.0.1:3456}"
HEALTH_TIMEOUT="${E2E_HEALTH_TIMEOUT:-180}"
CONTAINER_NAME="fan-agent"
ALLOWED_ORIGIN="https://agent.sea-agents.ru"   # must match docker-compose.yml ALLOWED_ORIGINS
EVIL_ORIGIN="https://evil.com"

# --- docker compose v2 / v1 ---
if docker compose version >/dev/null 2>&1; then
	COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
	COMPOSE="docker-compose"
else
	echo "ERROR: neither 'docker compose' nor 'docker-compose' is available" >&2
	exit 1
fi

# --- colors (plain output when not a TTY) ---
if [ -t 1 ]; then
	C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_RESET=$'\033[0m'
else
	C_GREEN=""; C_RED=""; C_YELLOW=""; C_CYAN=""; C_RESET=""
fi

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo "${C_GREEN}[PASS]${C_RESET} $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo "${C_RED}[FAIL]${C_RESET} $*"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); echo "${C_YELLOW}[SKIP]${C_RESET} $*"; }
info() { echo "${C_CYAN}[INFO]${C_RESET} $*"; }
section() { echo; echo "${C_CYAN}=== $* ===${C_RESET}"; }

# --- teardown -----------------------------------------------------------
cleanup() {
	echo
	info "Teardown: $COMPOSE down"
	$COMPOSE down >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- helpers ------------------------------------------------------------
# HTTP status code of a request. Usage: http_status [curl-args...]
http_status() {
	curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@"
}

# =========================================================================
section "0. Build & start stack"
# =========================================================================
info "$COMPOSE up -d --build"
$COMPOSE up -d --build

info "Waiting for $BASE_URL/api/health (timeout ${HEALTH_TIMEOUT}s)..."
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
ready=0
while [ "$(date +%s)" -lt "$deadline" ]; do
	if [ "$(http_status "$BASE_URL/api/health" || true)" = "200" ]; then
		ready=1
		break
	fi
	sleep 2
done
if [ "$ready" != "1" ]; then
	fail "Stack did not become ready within ${HEALTH_TIMEOUT}s"
	$COMPOSE logs --tail=50 fan || true
	echo
	echo "${C_RED}E2E aborted: stack not ready.${C_RESET} PASS=$PASS_COUNT FAIL=$FAIL_COUNT SKIP=$SKIP_COUNT"
	exit 1
fi
info "Stack is ready."

# =========================================================================
section "1. GET /api/health → 200, db:\"up\""
# =========================================================================
health_body="$(curl -s --max-time 10 "$BASE_URL/api/health")"
health_code="$(http_status "$BASE_URL/api/health")"
info "Response ($health_code): $health_body"
if [ "$health_code" = "200" ] && echo "$health_body" | grep -q '"db"[: ]*"up"'; then
	pass "health endpoint returns 200 with db:\"up\""
else
	fail "health endpoint: expected 200 + db:\"up\", got code=$health_code body=$health_body"
fi

# =========================================================================
section "2. GET /api/sessions without token → 401 (FAN_PUBLIC=1, F-0.3)"
# =========================================================================
noauth_code="$(http_status "$BASE_URL/api/sessions")"
if [ "$noauth_code" = "401" ]; then
	pass "unauthenticated request rejected with 401 (auth is NOT disabled in public mode)"
else
	fail "unauthenticated /api/sessions: expected 401, got $noauth_code"
fi

# =========================================================================
section "3. Bootstrap token (first token with auth enabled)"
# =========================================================================
# POST /api/tokens is itself protected by tokenAuth (app.use("/api/*", ...)),
# so the first token cannot be created over HTTP — a chicken-and-egg
# bootstrap. There is also no `fan token create` CLI command (as of phase 0).
# Working path: create the token directly in the SQLite DB inside the
# container via the app's own @fan/db Prisma layer. This does NOT bypass
# auth at runtime — it is the operator-side provisioning step, equivalent to
# inserting a row into the ClientToken table on the server.
info "Creating token via docker exec + @fan/db (Prisma) inside the container..."
# -w /app/packages/coding-agent: bun's isolated install keeps workspace
# links in the consuming package's node_modules (@fan/db is not linked at
# the root), so the eval script must run with that cwd to resolve @fan/db.
TOKEN="$(
	MSYS2_ARG_CONV_EXCL="*" docker exec -w /app/packages/coding-agent "$CONTAINER_NAME" bun -e '
import { getPrismaClient } from "@fan/db";
import { randomBytes, randomUUID } from "node:crypto";
const prisma = getPrismaClient();
const token = randomBytes(32).toString("hex");
await prisma.clientToken.create({ data: { id: randomUUID(), name: "e2e-local", token } });
await prisma.$disconnect();
console.log(token);
' 2>/dev/null | grep -oE '[0-9a-f]{64}' | head -1 || true
)"
if [ -n "$TOKEN" ]; then
	pass "bootstrap token created (via direct DB insert in container)"
else
	fail "bootstrap token creation failed (docker exec + @fan/db)"
fi

# =========================================================================
section "4. POST /api/sessions with token → 201/200; session retrievable"
# =========================================================================
# NOTE: a brand-new session appears in GET /api/sessions only after its first
# assistant message is persisted — SessionManager deliberately creates the
# JSONL file on the first assistant response (see session-manager.ts,
# "matching the newSession() contract"). We therefore verify the created
# session via GET /api/sessions/<id> (200) + /api/health active session id,
# and check the list endpoint separately (200 + sessions array).
SESSION_ID=""
if [ -n "$TOKEN" ]; then
	create_resp="$(curl -s --max-time 15 -w '\n%{http_code}' -X POST "$BASE_URL/api/sessions" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" -d '{}')"
	create_code="${create_resp##*$'\n'}"
	create_body="${create_resp%$'\n'*}"
	SESSION_ID="$(echo "$create_body" | grep -o '"id"[: ]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
	info "POST /api/sessions → $create_code, session id: ${SESSION_ID:-<none>}"
	if { [ "$create_code" = "201" ] || [ "$create_code" = "200" ]; } && [ -n "$SESSION_ID" ]; then
		pass "session created with token (HTTP $create_code)"
	else
		fail "POST /api/sessions: expected 201/200 with id, got code=$create_code body=$create_body"
	fi

	# 4b. Created session is retrievable by id and is the active session.
	get_one_code="$(http_status "$BASE_URL/api/sessions/$SESSION_ID" -H "Authorization: Bearer $TOKEN")"
	active_id="$(curl -s --max-time 10 "$BASE_URL/api/health" | grep -o '"session"[^}]*' | grep -o '"id"[: ]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')"
	if [ "$get_one_code" = "200" ] && [ "$active_id" = "$SESSION_ID" ]; then
		pass "created session retrievable (GET /api/sessions/$SESSION_ID → 200) and active"
	else
		fail "created session: GET /api/sessions/$SESSION_ID → $get_one_code, health active id=$active_id"
	fi

	# 4c. List endpoint works with the token (empty sessions are not yet on
	# disk — see note above — so we check shape, not membership).
	list_resp="$(curl -s --max-time 10 -w '\n%{http_code}' "$BASE_URL/api/sessions" -H "Authorization: Bearer $TOKEN")"
	list_code="${list_resp##*$'\n'}"
	list_body="${list_resp%$'\n'*}"
	if [ "$list_code" = "200" ] && echo "$list_body" | grep -q '"sessions"'; then
		pass "GET /api/sessions with token → 200 with sessions array"
	else
		fail "GET /api/sessions with token: expected 200 + sessions array, got code=$list_code body=$list_body"
	fi
else
	fail "session checks skipped — no token (see check 3)"
fi

# =========================================================================
section "5. CORS whitelist (F-0.4): $EVIL_ORIGIN blocked, $ALLOWED_ORIGIN allowed"
# =========================================================================
evil_headers="$(curl -s -o /dev/null -D - --max-time 10 -H "Origin: $EVIL_ORIGIN" "$BASE_URL/api/health")"
if echo "$evil_headers" | grep -iq '^access-control-allow-origin:'; then
	fail "disallowed origin $EVIL_ORIGIN received Access-Control-Allow-Origin"
else
	pass "disallowed origin $EVIL_ORIGIN: no Access-Control-Allow-Origin header"
fi

good_headers="$(curl -s -o /dev/null -D - --max-time 10 -H "Origin: $ALLOWED_ORIGIN" "$BASE_URL/api/health")"
acao="$(echo "$good_headers" | grep -i '^access-control-allow-origin:' | tr -d '\r' || true)"
if echo "$acao" | grep -q "$ALLOWED_ORIGIN"; then
	pass "allowed origin $ALLOWED_ORIGIN: ACAO header present (${acao#*: })"
else
	fail "allowed origin $ALLOWED_ORIGIN: expected ACAO header, headers: $good_headers"
fi

# =========================================================================
section "6. File logging (F-0.10): /data/logs/app.log exists and is non-empty"
# =========================================================================
if MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" test -s /data/logs/app.log; then
	pass "/data/logs/app.log exists and is non-empty"
else
	fail "/data/logs/app.log missing or empty in container $CONTAINER_NAME"
fi

# =========================================================================
section "7. WebSocket upgrade (optional): /api/ws/<sessionId>?token=…"
# =========================================================================
if [ -z "$TOKEN" ] || [ -z "$SESSION_ID" ]; then
	skip "WS check skipped — no token/session (see checks 3-4)"
elif command -v bun >/dev/null 2>&1; then
	ws_out="$(E2E_WS_URL="ws://127.0.0.1:3456/api/ws/$SESSION_ID?token=$TOKEN" bun -e '
const url = process.env.E2E_WS_URL;
const timer = setTimeout(() => { console.log("WS_TIMEOUT"); process.exit(1); }, 10000);
try {
	const ws = new WebSocket(url);
	ws.onmessage = (e) => {
		try {
			const msg = JSON.parse(e.data);
			if (msg.type === "connected") { clearTimeout(timer); console.log("WS_CONNECTED"); process.exit(0); }
		} catch { /* ignore non-JSON frames */ }
	};
	ws.onerror = () => { clearTimeout(timer); console.log("WS_ERROR"); process.exit(1); };
} catch (err) { clearTimeout(timer); console.log("WS_THROW"); process.exit(1); }
' 2>/dev/null || true)"
	if [ "$ws_out" = "WS_CONNECTED" ]; then
		pass "WebSocket upgrade succeeded (101, welcome frame received)"
	else
		fail "WebSocket upgrade failed (bun client: ${ws_out:-no output})"
	fi
elif command -v wscat >/dev/null 2>&1; then
	if timeout 10 wscat -c "ws://127.0.0.1:3456/api/ws/$SESSION_ID?token=$TOKEN" </dev/null 2>&1 | grep -q '"connected"'; then
		pass "WebSocket upgrade succeeded (wscat, welcome frame received)"
	else
		fail "WebSocket upgrade failed (wscat)"
	fi
else
	skip "WS check skipped — neither bun nor wscat available on host"
fi

# =========================================================================
section "Summary"
# =========================================================================
echo "PASS=$PASS_COUNT FAIL=$FAIL_COUNT SKIP=$SKIP_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
	echo "${C_RED}E2E FAILED${C_RESET}"
	exit 1
fi
echo "${C_GREEN}E2E OK — all checks passed${C_RESET}"
exit 0
