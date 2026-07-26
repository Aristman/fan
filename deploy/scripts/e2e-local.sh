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
#   → phase 0: 10 checks (health, auth 401, token bootstrap, sessions CRUD,
#     CORS, file logging, WebSocket)
#   → phase 1 (F-1.14-E2E): multi-project Workspace API workflow (section 8)
#   → phase 2 (F-2.14-E2E): Workspace UX — WS dispatch path + 3-project
#     switching performance (section 9)
#   → phase 3 (F-3.11-E2E, part 1): Universal Tasks — research workspace
#     lifecycle: template creation, type detection, prompt override,
#     manual type change (section 10)
#   → phase 3 (F-3.12-E2E, part 2): multi-type lifecycle — code/research/
#     automation projects via the API, per-type disk structures, registry
#     types, session isolation, per-type system prompts (section 11)
#   → phase 4 (F-4.16-E2E): autonomy — fan-scheduler compose service:
#     cron trigger → FIFO queue → persistent queue file → session creation →
#     budget cap → sendMessage → provider boundary, scheduler health proxy,
#     per-project budget API (section 12)
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
	# Best-effort workspace cleanup while the container is still up
	# (no-op when the stack never started or the function is not defined yet).
	e2e_workspace_cleanup || true
	info "Teardown: $COMPOSE down"
	$COMPOSE down >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- helpers ------------------------------------------------------------
# HTTP status code of a request. Usage: http_status [curl-args...]
http_status() {
	curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@"
}

# Float comparison for curl %{time_total} values: lt2 0.42 → true iff < 2.0s.
# awk is used because bash cannot compare floats (bc is not always present).
lt2() {
	awk -v t="$1" 'BEGIN{exit !(t < 2.0)}'
}

# Timed POST /api/sessions for a project cwd. Prints "<body>\n<code>\n<time_total>".
timed_post_session() {
	curl -s --max-time 15 -w '\n%{http_code}\n%{time_total}' -X POST "$BASE_URL/api/sessions" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" -d "{\"cwd\": \"$1\"}"
}

# --- Sections 8+9 (F-1.14-E2E / F-2.14-E2E) constants & idempotency cleanup --
# Fixed project names + thorough cleanup (start-of-section pre-clean AND
# end-of-run/trap cleanup) keep the sections idempotent against the
# PERSISTENT fan-data / fan-repos volumes: leftovers from a crashed previous
# run are removed before re-creating anything.
PROJ_A="/data/repos/e2e-proj-a"
PROJ_B="/data/repos/e2e-proj-b"
PROJ_C="/data/repos/e2e-proj-c"
PROJ_A_NAME="e2e-proj-a"
PROJ_B_NAME="e2e-proj-b"
# Session dirs use SessionManager's --encoded-cwd-- scheme
# (`--${cwd minus leading slash, slashes→dashes}--`, session-manager.ts).
SESS_DIR_A="/data/.fan/agent/sessions/--data-repos-e2e-proj-a--"
SESS_DIR_B="/data/.fan/agent/sessions/--data-repos-e2e-proj-b--"
SESS_DIR_C="/data/.fan/agent/sessions/--data-repos-e2e-proj-c--"

# --- Section 10 (F-3.11-E2E, part 1) constants ---
RESEARCH_PROJ="/data/repos/e2e-research-lab"
RESEARCH_PROJ_NAME="e2e-research-lab"
# Dist path of the F-3.6 prompt loader inside the runtime image (Dockerfile
# stage 2 copies each package's dist/ to /app/packages/<pkg>/dist).
PROMPT_LOADER_DIST="/app/packages/coding-agent/dist/workspace/prompt-loader.js"

# --- Section 11 (F-3.12-E2E, part 2) constants ---
P3_CODE="/data/repos/e2e-backend-api"
P3_RESEARCH="/data/repos/e2e-competitor-analysis"
P3_AUTO="/data/repos/e2e-backup-pipeline"
P3_CODE_NAME="e2e-backend-api"
P3_RESEARCH_NAME="e2e-competitor-analysis"
P3_AUTO_NAME="e2e-backup-pipeline"
SESS_DIR_P3_CODE="/data/.fan/agent/sessions/--data-repos-e2e-backend-api--"
SESS_DIR_P3_RESEARCH="/data/.fan/agent/sessions/--data-repos-e2e-competitor-analysis--"
SESS_DIR_P3_AUTO="/data/.fan/agent/sessions/--data-repos-e2e-backup-pipeline--"

# --- Section 12 (F-4.16-E2E) constants ---
SCHED_CONTAINER="fan-scheduler"
SCHED_PROJ="/data/repos/e2e-sched-project"
SESS_DIR_SCHED="/data/.fan/agent/sessions/--data-repos-e2e-sched-project--"
SCHED_TASK_A="e2e-sched-task-a"
SCHED_TASK_B="e2e-sched-task-b"
SCHED_BUDGET_LIMIT=100000
SCHED_PENDING_FILE="/data/.fan/agent/scheduler-pending.json"
SCHED_BUDGET_FILE="/data/.fan/agent/project-budgets.json"
# Generated cron config mounted into the scheduler container (host path,
# relative to the compose project dir); removed by the post-clean + trap.
SCHED_E2E_CONFIG="deploy/scheduler/.e2e-config.yaml"

# Remove test workspaces, their session dirs and their projects.json
# registry entries. Best-effort: never fails the script (used in the trap).
e2e_workspace_cleanup() {
	MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" \
		rm -rf "$PROJ_A" "$PROJ_B" "$PROJ_C" "$RESEARCH_PROJ" \
			"$P3_CODE" "$P3_RESEARCH" "$P3_AUTO" \
			"$SESS_DIR_A" "$SESS_DIR_B" "$SESS_DIR_C" \
			"$SESS_DIR_P3_CODE" "$SESS_DIR_P3_RESEARCH" "$SESS_DIR_P3_AUTO" \
			"$SCHED_PROJ" "$SESS_DIR_SCHED" "$SCHED_PENDING_FILE" 2>/dev/null || true
	rm -f "$REPO_ROOT/$SCHED_E2E_CONFIG" 2>/dev/null || true
	MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" bun -e '
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const p = "/data/.fan/agent/projects.json";
if (existsSync(p)) {
	try {
		const list = JSON.parse(readFileSync(p, "utf8"));
		if (Array.isArray(list)) {
			const e2e = [
				"/data/repos/e2e-proj-a", "/data/repos/e2e-proj-b", "/data/repos/e2e-proj-c",
				"/data/repos/e2e-research-lab",
				"/data/repos/e2e-backend-api", "/data/repos/e2e-competitor-analysis", "/data/repos/e2e-backup-pipeline",
				"/data/repos/e2e-sched-project",
			];
			const keep = list.filter((e) => e && !e2e.includes(e.path));
			writeFileSync(p, JSON.stringify(keep, null, 2));
		}
	} catch { /* corrupted registry → app already treats it as empty */ }
}
// F-4.9: drop the E2E entry from the per-project budget store.
const b = "/data/.fan/agent/project-budgets.json";
if (existsSync(b)) {
	try {
		const j = JSON.parse(readFileSync(b, "utf8"));
		if (j && typeof j === "object" && j.budgets && typeof j.budgets === "object") {
			delete j.budgets["/data/repos/e2e-sched-project"];
			writeFileSync(b, JSON.stringify(j, null, 2));
		}
	} catch { /* corrupted store → treated as empty */ }
}
' >/dev/null 2>&1 || true
}

# =========================================================================
section "0. Build & start stack"
# =========================================================================
info "$COMPOSE up -d --build fan"
# Only the `fan` service is started here. The companion `fan-scheduler`
# service (phase 4) requires a provisioned FAN_API_TOKEN, which does not
# exist until check 3 — section 12 starts it afterwards with the token and
# an E2E config via FAN_SCHEDULER_TOKEN / FAN_SCHEDULER_CONFIG env vars.
$COMPOSE up -d --build fan

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
section "8. Phase 1 — Workspace API (F-1.14-E2E): multi-project workflow"
# =========================================================================
# Covers TC-F-1.14-E2E-1..3 against the compose whitelist
# (FAN_WORKSPACE_ROOT=/data/repos → allowedRoots=[/data/repos], F-1.13):
#   create projects A/B → sessions in both → registry + ?project= filters →
#   cross-project delete 403 → path traversal 403 → in-project delete 204.
#
# LAZY-JSONL WORKAROUND (documented phase-0 behaviour): a session only
# appears in GET /api/sessions (and becomes deletable — deleteSession is
# disk-only and refuses the ACTIVE runtime session) once its JSONL file
# exists on disk, which normally happens on the first assistant response.
# An LLM round-trip is not available in this stack, so after creating
# session A (and then B, which makes A non-active) we seed a minimal
# v3-header JSONL for session A via docker exec — exactly the header
# SessionManager.newSession() would write (session-manager.ts). Session B
# intentionally stays unpersisted: the ?project=B filter check asserts the
# documented lazy behaviour instead of fighting it.
SESSION_A_ID=""
SESSION_B_ID=""
if [ -z "$TOKEN" ]; then
	fail "phase 1 checks skipped — no token (see check 3)"
else
	# 8.0. Pre-clean: wipe leftovers from a crashed previous run (volumes persist).
	e2e_workspace_cleanup

	# 8.1. Workspace dirs in the container; .git + src/ in A → auto-register type=code
	# (F-1.7 via the F-3.2 detector: code = .git AND (src/ OR package.json)).
	if MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" mkdir -p "$PROJ_A/.git" "$PROJ_A/src" "$PROJ_B" 2>/dev/null; then
		pass "test workspaces created ($PROJ_A with .git + src/, $PROJ_B)"
	else
		fail "failed to create test workspace directories in container"
	fi

	# 8.2. POST /api/sessions { cwd: PROJ_A } → 201, response.cwd matches (F-1.3/F-1.12).
	create_a_resp="$(curl -s --max-time 15 -w '\n%{http_code}' -X POST "$BASE_URL/api/sessions" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" -d "{\"cwd\": \"$PROJ_A\"}")"
	create_a_code="${create_a_resp##*$'\n'}"
	create_a_body="${create_a_resp%$'\n'*}"
	SESSION_A_ID="$(echo "$create_a_body" | grep -o '"id"[: ]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
	create_a_cwd="$(echo "$create_a_body" | grep -o '"cwd"[: ]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
	info "POST /api/sessions {cwd: $PROJ_A} → $create_a_code, id: ${SESSION_A_ID:-<none>}, cwd: ${create_a_cwd:-<none>}"
	if [ "$create_a_code" = "201" ] && [ -n "$SESSION_A_ID" ] && [ "$create_a_cwd" = "$PROJ_A" ]; then
		pass "session A created in project A (HTTP 201, response.cwd correct)"
	else
		fail "POST session A: expected 201 + cwd=$PROJ_A, got code=$create_a_code body=$create_a_body"
	fi

	# 8.3. POST /api/sessions { cwd: PROJ_B } → 201 (runtime switches to B; A becomes non-active).
	create_b_resp="$(curl -s --max-time 15 -w '\n%{http_code}' -X POST "$BASE_URL/api/sessions" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" -d "{\"cwd\": \"$PROJ_B\"}")"
	create_b_code="${create_b_resp##*$'\n'}"
	create_b_body="${create_b_resp%$'\n'*}"
	SESSION_B_ID="$(echo "$create_b_body" | grep -o '"id"[: ]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
	create_b_cwd="$(echo "$create_b_body" | grep -o '"cwd"[: ]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
	info "POST /api/sessions {cwd: $PROJ_B} → $create_b_code, id: ${SESSION_B_ID:-<none>}, cwd: ${create_b_cwd:-<none>}"
	if [ "$create_b_code" = "201" ] && [ -n "$SESSION_B_ID" ] && [ "$create_b_cwd" = "$PROJ_B" ]; then
		pass "session B created in project B (HTTP 201, response.cwd correct)"
	else
		fail "POST session B: expected 201 + cwd=$PROJ_B, got code=$create_b_code body=$create_b_body"
	fi

	if [ -z "$SESSION_A_ID" ] || [ -z "$SESSION_B_ID" ]; then
		fail "phase 1 workflow aborted — session ids missing (see checks above)"
	else
		# 8.4. Lazy-JSONL workaround: seed session A's JSONL on disk (see section header).
		seed_out="$(MSYS2_ARG_CONV_EXCL="*" docker exec -e E2E_SID="$SESSION_A_ID" "$CONTAINER_NAME" bun -e '
import { mkdirSync, writeFileSync } from "node:fs";
const id = process.env.E2E_SID;
const ts = new Date().toISOString();
const dir = "/data/.fan/agent/sessions/--data-repos-e2e-proj-a--";
mkdirSync(dir, { recursive: true });
const file = `${dir}/${ts.replace(/[:.]/g, "-")}_${id}.jsonl`;
const header = { type: "session", version: 3, id, timestamp: ts, cwd: "/data/repos/e2e-proj-a" };
writeFileSync(file, JSON.stringify(header) + "\n");
console.log("SEEDED");
' 2>/dev/null || true)"
		if [ "$seed_out" = "SEEDED" ]; then
			pass "session A persisted to disk (manual JSONL seed — lazy-JSONL workaround)"
		else
			fail "session A JSONL seed failed (docker exec: ${seed_out:-no output})"
		fi

		# 8.5. GET /api/projects → both projects auto-registered (F-1.5/F-1.7);
		# A has type=code (.git + src/ detected, F-3.2) and sessionCount=1 (seeded JSONL counted).
		projects_body="$(curl -s --max-time 10 "$BASE_URL/api/projects" -H "Authorization: Bearer $TOKEN")"
		info "GET /api/projects → $projects_body"
		if echo "$projects_body" | grep -q "\"path\":\"$PROJ_A\"" && echo "$projects_body" | grep -q "\"path\":\"$PROJ_B\""; then
			pass "GET /api/projects: both projects present (auto-registration F-1.7)"
		else
			fail "GET /api/projects: expected $PROJ_A and $PROJ_B, got $projects_body"
		fi
		if echo "$projects_body" | grep -q "\"path\":\"$PROJ_A\",\"name\":\"$PROJ_A_NAME\",\"type\":\"code\",\"sessionCount\":1"; then
			pass "project A entry: type=code (.git + src/ detected, F-3.2), sessionCount=1"
		else
			fail "project A entry: expected type=code + sessionCount=1, got $projects_body"
		fi

		# 8.6. GET /api/sessions?project=A → session A listed with correct cwd (F-1.2/F-1.12).
		filt_a_resp="$(curl -s --max-time 10 -w '\n%{http_code}' "$BASE_URL/api/sessions?project=$PROJ_A" -H "Authorization: Bearer $TOKEN")"
		filt_a_code="${filt_a_resp##*$'\n'}"
		filt_a_body="${filt_a_resp%$'\n'*}"
		if [ "$filt_a_code" = "200" ] && echo "$filt_a_body" | grep -q "\"id\":\"$SESSION_A_ID\"" \
			&& echo "$filt_a_body" | grep -q "\"cwd\":\"$PROJ_A\"" && ! echo "$filt_a_body" | grep -q "\"id\":\"$SESSION_B_ID\""; then
			pass "GET /api/sessions?project=A: session A listed with cwd=$PROJ_A (filter F-1.2)"
		else
			fail "GET /api/sessions?project=A: expected session A with cwd, got code=$filt_a_code body=$filt_a_body"
		fi

		# 8.7. GET /api/sessions?project=B → 200 with sessions array; session A
		# absent. Session B itself is absent too — DOCUMENTED lazy-JSONL
		# behaviour (no first message → no JSONL → not listed), not a bug.
		filt_b_resp="$(curl -s --max-time 10 -w '\n%{http_code}' "$BASE_URL/api/sessions?project=$PROJ_B" -H "Authorization: Bearer $TOKEN")"
		filt_b_code="${filt_b_resp##*$'\n'}"
		filt_b_body="${filt_b_resp%$'\n'*}"
		if [ "$filt_b_code" = "200" ] && echo "$filt_b_body" | grep -q '"sessions"' && ! echo "$filt_b_body" | grep -q "\"id\":\"$SESSION_A_ID\""; then
			pass "GET /api/sessions?project=B: 200, no cross-project leakage (lazy-JSONL: unpersisted B not listed — documented)"
		else
			fail "GET /api/sessions?project=B: expected 200 without session A, got code=$filt_b_code body=$filt_b_body"
		fi

		# 8.8. TC-F-1.14-E2E-2: cross-project delete is rejected and session survives.
		del_x_code="$(http_status -X DELETE "$BASE_URL/api/sessions/$SESSION_A_ID?project=$PROJ_B" -H "Authorization: Bearer $TOKEN")"
		still_there="$(curl -s --max-time 10 "$BASE_URL/api/sessions?project=$PROJ_A" -H "Authorization: Bearer $TOKEN")"
		if [ "$del_x_code" = "403" ] && echo "$still_there" | grep -q "\"id\":\"$SESSION_A_ID\""; then
			pass "cross-project DELETE (A via ?project=B) → 403, session NOT deleted (F-1.4)"
		else
			fail "cross-project DELETE: expected 403 + session intact, got code=$del_x_code list=$still_there"
		fi

		# 8.9. TC-F-1.14-E2E-3: path traversal outside the whitelist is rejected.
		trav_resp="$(curl -s --max-time 15 -w '\n%{http_code}' -X POST "$BASE_URL/api/sessions" \
			-H "Authorization: Bearer $TOKEN" \
			-H "Content-Type: application/json" -d '{"cwd": "/etc/passwd"}')"
		trav_code="${trav_resp##*$'\n'}"
		trav_body="${trav_resp%$'\n'*}"
		if [ "$trav_code" = "403" ] && echo "$trav_body" | grep -q "cwd rejected"; then
			pass "POST {cwd: /etc/passwd} → 403 cwd rejected (whitelist F-1.13)"
		else
			fail "path traversal: expected 403 + cwd rejected, got code=$trav_code body=$trav_body"
		fi

		# 8.10. TC-F-1.14-E2E-1 (final): in-project delete succeeds → 204, session gone.
		del_a_code="$(http_status -X DELETE "$BASE_URL/api/sessions/$SESSION_A_ID?project=$PROJ_A" -H "Authorization: Bearer $TOKEN")"
		after_del="$(curl -s --max-time 10 "$BASE_URL/api/sessions?project=$PROJ_A" -H "Authorization: Bearer $TOKEN")"
		if [ "$del_a_code" = "204" ] && ! echo "$after_del" | grep -q "\"id\":\"$SESSION_A_ID\""; then
			pass "DELETE session A with matching ?project=A → 204, session removed"
		else
			fail "in-project DELETE: expected 204 + session gone, got code=$del_a_code list=$after_del"
		fi
	fi

	# 8.11. Post-clean: keep the run idempotent (also runs from the EXIT trap).
	info "Cleanup: removing test workspaces, session dirs and registry entries"
	e2e_workspace_cleanup
fi

# =========================================================================
section "9. Phase 2 — Workspace UX (F-2.14-E2E): multi-project work + queue"
# =========================================================================
# E2E SCOPE DECISION (documented; the roadmap TCs assume a live LLM, which
# this stack deliberately does not have — no API keys in the container):
#
#  (a) WS sendMessage path — E2E-TESTABLE, checked here (9.3/9.4).
#      Connect → welcome frame → ping/pong → sendMessage. The engine is
#      IDLE (nothing streams without an LLM), so the dispatcher takes the
#      direct-dispatch branch: sessionAdapter.sendMessage() → runtime
#      .prompt() throws synchronously at provider validation
#      (agent-session.ts: "No API key found …" / "No model selected")
#      BEFORE any agent event is emitted. The only observable is therefore
#      server-side: the dispatcher's .catch logs
#      "[ws-handler] sendMessage failed for session <id>" (teed into
#      /data/logs/app.log, F-0.10). Receiving that log line proves the
#      full public WS path: upgrade + token auth + frame parse +
#      dispatcher routing + adapter dispatch + provider stage reached.
#      The expected failure is the provider error — a protocol/dispatch
#      failure would never reach the adapter.
#
#  (b) Queue branches (queued / queue_full / dequeue) — NOT E2E-testable
#      here, BY DESIGN. The dispatcher only enqueues when
#      isExecuting()=true, and the engine can never become busy without an
#      LLM (prompt() throws before streaming starts). These branches are
#      covered at the vitest integration level with a mock busy adapter:
#      packages/api-gateway/src/__tests__/ws-handler.test.ts
#      (TC-F-2.5-1 queued+position, positions 1..N, global-FIFO dequeue on
#      agent_end/finally, TC-F-2.15-2 queue_full QUEUE_OVERFLOW).
#
#  (c) Multi-project REST workflow + ?project= isolation — covered by
#      section 8 (8.6/8.7 filter checks, 8.8 cross-project 403) and NOT
#      duplicated here; 9.2.5 only re-verifies the filtered list cheaply
#      as part of the timing measurement.
#
#  (d) 3-project switching performance (TC-F-2.14-E2E-2 approximation) —
#      checked here (9.2). Public-API approximation of "switch project":
#      timed POST /api/sessions {cwd} across A → B → C → A (each POST
#      performs the runtime session switch) + one timed GET. Assert
#      curl time_total < 2s per operation; measured values are reported
#      (honest timing, cold switches included — ServiceRegistry is a
#      standalone cache not wired into the runtime).
#
#  (e) Dashboard components (project-switcher, session tree, queue
#      indicator) — vitest level only; there is no browser in this stack.
PHASE2_SESSION_ID=""
if [ -z "$TOKEN" ]; then
	fail "phase 2 checks skipped — no token (see check 3)"
else
	# 9.0. Pre-clean: wipe leftovers from a crashed previous run (volumes persist).
	e2e_workspace_cleanup

	# 9.1. Three test workspaces in the container (A/B/C).
	if MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" mkdir -p "$PROJ_A" "$PROJ_B" "$PROJ_C" 2>/dev/null; then
		pass "three test workspaces created ($PROJ_A, $PROJ_B, $PROJ_C)"
	else
		fail "failed to create phase-2 test workspace directories in container"
	fi

	# 9.2. TC-F-2.14-E2E-2 (approximation): timed project switches A→B→C→A.
	# Each POST /api/sessions {cwd} performs the runtime switch; assert
	# time_total < 2s per operation and the returned cwd matches.
	for target in "$PROJ_A" "$PROJ_B" "$PROJ_C" "$PROJ_A"; do		resp="$(timed_post_session "$target")"
		t="$(echo "$resp" | tail -1)"
		code="$(echo "$resp" | tail -2 | head -1)"
		body="$(echo "$resp" | head -n -2)"
		resp_cwd="$(echo "$body" | grep -o '"cwd"[: ]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
		if [ "$code" = "201" ] && [ "$resp_cwd" = "$target" ] && lt2 "$t"; then
			pass "switch to $target: POST /api/sessions → 201 in ${t}s (< 2s)"
			# Remember the session id of the final switch (back to A) for the WS test.
			if [ "$target" = "$PROJ_A" ]; then
				PHASE2_SESSION_ID="$(echo "$body" | grep -o '"id"[: ]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
			fi
		else
			fail "switch to $target: code=$code cwd=${resp_cwd:-<none>} time=${t}s (expected 201 + cwd + < 2s)"
		fi
	done

	# 9.2.5. Timed GET on the filtered list (isolation itself is section 8
	# territory — here we only re-verify shape + measure the read path).
	get_resp="$(curl -s --max-time 15 -w '\n%{http_code}\n%{time_total}' "$BASE_URL/api/sessions?project=$PROJ_A" \
		-H "Authorization: Bearer $TOKEN")"
	get_t="$(echo "$get_resp" | tail -1)"
	get_code="$(echo "$get_resp" | tail -2 | head -1)"
	get_body="$(echo "$get_resp" | head -n -2)"
	if [ "$get_code" = "200" ] && echo "$get_body" | grep -q '"sessions"' && lt2 "$get_t"; then
		pass "GET /api/sessions?project=A → 200 in ${get_t}s (< 2s; isolation checks: see 8.6/8.7)"
	else
		fail "GET /api/sessions?project=A: code=$get_code time=${get_t}s body=$get_body"
	fi

	# 9.3. WS sendMessage protocol end-to-end (scope item a): connect to the
	# active session A, expect welcome frame + pong, send sendMessage and
	# confirm NO queue frames arrive (engine idle → direct dispatch, F-2.5).
	if [ -z "$PHASE2_SESSION_ID" ]; then
		fail "WS sendMessage check skipped — no phase-2 session id (see 9.2)"
	elif ! command -v bun >/dev/null 2>&1; then
		skip "WS sendMessage check skipped — bun not available on host (wscat cannot assert frame sequence)"
	else
		ws_out="$(E2E_WS_URL="ws://127.0.0.1:3456/api/ws/$PHASE2_SESSION_ID?token=$TOKEN" bun -e '
const url = process.env.E2E_WS_URL;
const result = { connected: false, pong: false, queueFrame: false, frames: [] };
const timer = setTimeout(() => { console.log(JSON.stringify(result)); process.exit(0); }, 8000);
try {
	const ws = new WebSocket(url);
	ws.onmessage = (e) => {
		try {
			const msg = JSON.parse(e.data);
			result.frames.push(msg.type);
			if (msg.type === "connected") {
				result.connected = true;
				ws.send(JSON.stringify({ type: "ping" }));
				ws.send(JSON.stringify({ type: "sendMessage", content: "e2e phase2 ws probe" }));
			} else if (msg.type === "pong") {
				result.pong = true;
			} else if (msg.type === "queued" || msg.type === "queue_full") {
				result.queueFrame = true;
			}
		} catch { /* ignore non-JSON frames */ }
	};
	ws.onerror = () => { clearTimeout(timer); console.log("WS_ERROR"); process.exit(1); };
} catch { clearTimeout(timer); console.log("WS_THROW"); process.exit(1); }
' 2>/dev/null || true)"
		info "WS frames: ${ws_out:-<none>}"
		if echo "$ws_out" | grep -q '"connected":true' && echo "$ws_out" | grep -q '"pong":true' \
			&& echo "$ws_out" | grep -q '"queueFrame":false'; then
			pass "WS sendMessage: connected + pong received, no queued/queue_full (engine idle → direct dispatch, F-2.5)"
		else
			fail "WS sendMessage: expected connected+pong without queue frames, got ${ws_out:-no output}"
		fi

		# 9.4. Server-side evidence: the dispatch reached the adapter and failed
		# at the provider stage (no LLM keys in the container — expected). The
		# dispatcher logs the failure; console output is teed to app.log (F-0.10).
		sleep 2
		log_hit="$(MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" \
			grep -F "sendMessage failed for session $PHASE2_SESSION_ID" /data/logs/app.log 2>/dev/null || true)"
		if [ -z "$log_hit" ]; then
			log_hit="$($COMPOSE logs --since 120s fan 2>/dev/null | grep -F "sendMessage failed for session $PHASE2_SESSION_ID" || true)"
		fi
		if [ -n "$log_hit" ]; then
			pass "server log confirms dispatch → provider error for session $PHASE2_SESSION_ID (WS path end-to-end)"
			info "log: $(echo "$log_hit" | head -1 | cut -c1-160)"
		else
			fail "server log: no 'sendMessage failed for session $PHASE2_SESSION_ID' entry (dispatch never reached the adapter)"
		fi
	fi

	# 9.5. Post-clean: keep the run idempotent (also runs from the EXIT trap).
	info "Cleanup: removing phase-2 test workspaces, session dirs and registry entries"
	e2e_workspace_cleanup
fi

# =========================================================================
section "10. Phase 3 — Universal Tasks (F-3.11-E2E, part 1): research workspace"
# =========================================================================
# Covers the non-LLM part of TC-F-3.11-E2E-1 against the live container:
#   POST /api/projects (template=research, F-3.5) → disk structure (F-3.4)
#   → registry entry type=research (F-3.1/F-3.2) → prompt default + override
#   (F-3.6, executed against the REAL dist build in the container) → manual
#   type change round-trip (F-3.10) → idempotent re-POST.
#
# DOCUMENTED CONSTRAINTS — LLM-dependent steps are a MANUAL checklist:
#   TC-F-3.11-E2E-1 steps 5–8 (`/idea-lab:analyze` → SWOT doc in
#   docs/research/) and all of TC-F-3.11-E2E-2 (`/research-spec:generate`)
#   require a live LLM, which this stack deliberately does not have (no API
#   keys in the container — same boundary as section 9). A slash command is
#   just prompt text for the agent; without a model there is nothing to
#   assert. Manual checklist (run on a deployment WITH a configured model):
#     1. Create project from the «Research Lab» template (dashboard dialog).
#     2. Chat: /idea-lab:analyze "AI-powered code review tool"
#     3. Assert docs/research/ contains a non-empty SWOT markdown doc.
#     4. Chat: /research-spec:generate "Distributed task queue architecture"
#     5. Assert the generated spec has TOC + architecture sections.
#   Everything BEFORE the LLM boundary is checked here (10.1–10.8).
#
# SKILLS IN THE CONTAINER (investigated, documented): the runtime image
# contains only package.json + dist/ per package (Dockerfile /deploy stage)
# — the repo `skills/` sources are NOT baked in. At runtime skills are
# discovered from <agentDir>/skills (= /data/.fan/agent/skills, the fan-data
# volume; resource-loader.ts) and <cwd>/.fan/skills, populated via
# `fan store install`. Check 10.8 therefore verifies the skill SOURCES
# host-side (prerequisite for the manual scenario) instead of executing
# LLM-bound skills in the container.
if [ -z "$TOKEN" ]; then
	fail "phase 3 checks skipped — no token (see check 3)"
else
	# 10.0. Pre-clean: wipe leftovers from a crashed previous run (volumes persist).
	e2e_workspace_cleanup

	# 10.1. TC-F-3.5-2: unknown template is rejected with 400 BEFORE any fs write.
	bad_tmpl_resp="$(curl -s --max-time 15 -w '\n%{http_code}' -X POST "$BASE_URL/api/projects" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" \
		-d "{\"name\": \"$RESEARCH_PROJ_NAME\", \"template\": \"nonexistent\", \"rootPath\": \"/data/repos\"}")"
	bad_tmpl_code="${bad_tmpl_resp##*$'\n'}"
	bad_tmpl_body="${bad_tmpl_resp%$'\n'*}"
	if [ "$bad_tmpl_code" = "400" ] && echo "$bad_tmpl_body" | grep -q "Unknown template: nonexistent"; then
		pass "POST /api/projects with unknown template → 400 'Unknown template' (F-3.5, TC-F-3.5-2)"
	else
		fail "unknown template: expected 400 + 'Unknown template: nonexistent', got code=$bad_tmpl_code body=$bad_tmpl_body"
	fi

	# 10.2. TC-F-3.5-1/3 + TC-F-3.11-E2E-1 steps 1+3: create the research
	# workspace via the API → 201 with type+template=research (auto-detected
	# from the template-created docs/research/, F-3.2).
	create_resp="$(curl -s --max-time 15 -w '\n%{http_code}' -X POST "$BASE_URL/api/projects" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" \
		-d "{\"name\": \"$RESEARCH_PROJ_NAME\", \"template\": \"research\", \"rootPath\": \"/data/repos\"}")"
	create_code="${create_resp##*$'\n'}"
	create_body="${create_resp%$'\n'*}"
	info "POST /api/projects {name: $RESEARCH_PROJ_NAME, template: research} → $create_code: $create_body"
	if [ "$create_code" = "201" ] && echo "$create_body" | grep -q "\"path\":\"$RESEARCH_PROJ\"" \
		&& echo "$create_body" | grep -q "\"type\":\"research\"" && echo "$create_body" | grep -q "\"template\":\"research\""; then
		pass "research project created via API (HTTP 201, type=research auto-detected, template=research)"
	else
		fail "POST /api/projects research: expected 201 + path/type/template=research, got code=$create_code body=$create_body"
	fi

	# 10.3. TC-F-3.4-1 / TC-F-3.11-E2E-1 step 2: template directory structure
	# materialized on disk (inside the container).
	if MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" test -d "$RESEARCH_PROJ/.fan/prompts" \
		&& MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" test -d "$RESEARCH_PROJ/docs/research" \
		&& MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" test -d "$RESEARCH_PROJ/data" \
		&& MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" test -d "$RESEARCH_PROJ/reports" \
		&& MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" test -f "$RESEARCH_PROJ/.fan/settings.json"; then
		pass "research template structure on disk: .fan/prompts, docs/research, data, reports, .fan/settings.json (F-3.4)"
	else
		fail "research template structure incomplete under $RESEARCH_PROJ"
	fi

	# 10.4. GET /api/projects → registry entry with type=research (F-3.1).
	projects_body="$(curl -s --max-time 10 "$BASE_URL/api/projects" -H "Authorization: Bearer $TOKEN")"
	if echo "$projects_body" | grep -q "\"path\":\"$RESEARCH_PROJ\",\"name\":\"$RESEARCH_PROJ_NAME\",\"type\":\"research\""; then
		pass "GET /api/projects: $RESEARCH_PROJ_NAME registered with type=research (F-3.1/F-3.2)"
	else
		fail "GET /api/projects: expected $RESEARCH_PROJ with type=research, got $projects_body"
	fi

	# 10.5. F-3.6 default prompt, executed against the REAL dist build inside
	# the container (prompt-loader.js imports only node builtins + the sibling
	# detector.js — verified): the research base prompt names the role and
	# the docs/research output path, with variables substituted.
	default_prompt="$(MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" bun -e "
import { loadSystemPrompt } from \"$PROMPT_LOADER_DIST\";
console.log(loadSystemPrompt(\"/data/repos/e2e-research-lab\"));
" 2>/dev/null || true)"
	if echo "$default_prompt" | grep -q "research assistant" \
		&& echo "$default_prompt" | grep -q "$RESEARCH_PROJ/docs/research" \
		&& echo "$default_prompt" | grep -q "e2e-research-lab"; then
		pass "loadSystemPrompt (dist, in-container): research default prompt mentions docs/research + substituted variables (F-3.6)"
	else
		fail "loadSystemPrompt default: expected 'research assistant' + '$RESEARCH_PROJ/docs/research', got: $(echo "$default_prompt" | head -3)"
	fi

	# 10.6. F-3.6 custom override (TC-F-3.6-2 at container level): write
	# .fan/prompts/system.md → the loader returns the custom content INSTEAD
	# of the research template (full replacement, no merge).
	write_out="$(MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" bun -e '
import { writeFileSync } from "node:fs";
writeFileSync("/data/repos/e2e-research-lab/.fan/prompts/system.md", "E2E_CUSTOM_PROMPT_OVERRIDE_MARKER for {project_name}\n");
console.log("WROTE");
' 2>/dev/null || true)"
	override_prompt="$(MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" bun -e "
import { loadSystemPrompt } from \"$PROMPT_LOADER_DIST\";
console.log(loadSystemPrompt(\"/data/repos/e2e-research-lab\"));
" 2>/dev/null || true)"
	if [ "$write_out" = "WROTE" ] \
		&& MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" test -f "$RESEARCH_PROJ/.fan/prompts/system.md" \
		&& echo "$override_prompt" | grep -q "E2E_CUSTOM_PROMPT_OVERRIDE_MARKER for e2e-research-lab" \
		&& ! echo "$override_prompt" | grep -q "research assistant"; then
		pass ".fan/prompts/system.md override respected: custom prompt replaces template, variables substituted (F-3.6, TC-F-3.6-2)"
	else
		fail "prompt override: write_out=$write_out, loader returned: $(echo "$override_prompt" | head -3)"
	fi

	# 10.7. F-3.10 (TC-F-3.10-1): manual type change round-trip via
	# PUT /api/projects?path= — research → automation → back to research.
	put_auto_resp="$(curl -s --max-time 15 -w '\n%{http_code}' -X PUT "$BASE_URL/api/projects?path=$RESEARCH_PROJ" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" -d '{"type": "automation"}')"
	put_auto_code="${put_auto_resp##*$'\n'}"
	put_auto_body="${put_auto_resp%$'\n'*}"
	put_back_resp="$(curl -s --max-time 15 -w '\n%{http_code}' -X PUT "$BASE_URL/api/projects?path=$RESEARCH_PROJ" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" -d '{"type": "research"}')"
	put_back_code="${put_back_resp##*$'\n'}"
	put_back_body="${put_back_resp%$'\n'*}"
	final_type="$(curl -s --max-time 10 "$BASE_URL/api/projects" -H "Authorization: Bearer $TOKEN" \
		| grep -o "\"path\":\"$RESEARCH_PROJ\",\"name\":\"$RESEARCH_PROJ_NAME\",\"type\":\"[a-z]*\"" \
		| sed 's/.*"type":"\([a-z]*\)"/\1/' || true)"
	if [ "$put_auto_code" = "200" ] && echo "$put_auto_body" | grep -q "\"type\":\"automation\"" \
		&& [ "$put_back_code" = "200" ] && echo "$put_back_body" | grep -q "\"type\":\"research\"" \
		&& [ "$final_type" = "research" ]; then
		pass "PUT /api/projects?path= type round-trip: research → automation → research, registry confirms (F-3.10)"
	else
		fail "type round-trip: auto=$put_auto_code/$put_auto_body back=$put_back_code/$put_back_body final=$final_type"
	fi

	# 10.8. Idempotency: re-POST the same project → 200 (registry dedup,
	# created=false); applyTemplate never overwrites — the custom prompt
	# override from 10.6 survives.
	repost_resp="$(curl -s --max-time 15 -w '\n%{http_code}' -X POST "$BASE_URL/api/projects" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" \
		-d "{\"name\": \"$RESEARCH_PROJ_NAME\", \"template\": \"research\", \"rootPath\": \"/data/repos\"}")"
	repost_code="${repost_resp##*$'\n'}"
	repost_body="${repost_resp%$'\n'*}"
	if [ "$repost_code" = "200" ] && echo "$repost_body" | grep -q "\"type\":\"research\"" \
		&& MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" \
			grep -q "E2E_CUSTOM_PROMPT_OVERRIDE_MARKER" "$RESEARCH_PROJ/.fan/prompts/system.md"; then
		pass "re-POST same project → 200 (idempotent), existing files NOT overwritten (override survived)"
	else
		fail "idempotent re-POST: expected 200 + intact override, got code=$repost_code body=$repost_body"
	fi

	# 10.9. Skill sources for the manual LLM scenario exist host-side
	# (idea-lab + research-spec-generator, shipped in skills/; installable via
	# FAN Store). The container image does not bundle them — see section
	# header. Skill EXECUTION is the manual checklist (LLM required).
	if [ -f "$REPO_ROOT/skills/idea-lab/SKILL.md" ] && [ -f "$REPO_ROOT/skills/research-spec-generator/SKILL.md" ]; then
		pass "skill sources present (skills/idea-lab, skills/research-spec-generator) — prerequisite for manual TC-F-3.11-E2E-1/2"
		info "MANUAL (needs LLM): /idea-lab:analyze → SWOT doc in docs/research/; /research-spec:generate → spec doc"
	else
		fail "skill sources missing under $REPO_ROOT/skills (idea-lab / research-spec-generator)"
	fi

	# 10.10. Post-clean: keep the run idempotent (also runs from the EXIT trap).
	info "Cleanup: removing research test workspace and registry entry"
	e2e_workspace_cleanup
fi

# =========================================================================
section "11. Phase 3 — Universal Tasks (F-3.12-E2E): multi-type lifecycle"
# =========================================================================
# Covers TC-F-3.12-E2E-1 (non-LLM part) + TC-F-3.12-E2E-2 against the live
# container — 38 checks:
#   11.1  POST /api/projects ×3 (code/research/automation → 201 + correct
#         type/template, F-3.5)                                        [3]
#   11.2  per-template disk structures (F-3.3/F-3.4)                   [16]
#   11.3  GET /api/projects registry types (F-3.1/F-3.2)                [4]
#   11.4  one session per project (POST /api/sessions {cwd} ×3)         [3]
#   11.5  lazy-JSONL seed per project (same workaround as section 8)    [3]
#   11.6  ?project= isolation: each filter returns ONLY its own session [3]
#   11.7  return-to-project: switch back → seeded data still in place   [3]
#   11.8  per-type system prompts via loadSystemPrompt from the REAL dist
#         build in the container (F-3.6, TC-F-3.12-E2E-2)               [3]
#
# DOCUMENTED CONSTRAINT — LLM-dependent steps are a MANUAL checklist
# (same boundary as sections 9/10: no API keys in the container).
# TC-F-3.12-E2E-1 steps 4–6 (agent tasks inside each project) need a live
# model. Manual checklist (run on a deployment WITH a configured model):
#   1. backend-api: chat «Add user authentication» → src/auth.ts created
#      (with tests under tests/).
#   2. competitor-analysis: /idea-lab:analyze "Enterprise AI platform" →
#      non-empty markdown doc under docs/research/.
#   3. backup-pipeline: chat «Create daily backup script» → executable
#      scripts/daily-backup.sh.
#   4. Switch back to each project → the created files are still there
#      (context isolation; complements the REST-level checks 11.6/11.7).
# Everything BEFORE the LLM boundary is checked here.
#
# .GIT NOTE (check 11.8): the code template deliberately ships no .git
# (the user runs `git init` when ready — templates/index.ts), while the
# F-3.2 detector requires .git for type=code. The REGISTRY type falls back
# to the template name (createProject), but loadSystemPrompt() re-detects
# from disk — so we simulate `git init` (mkdir .git) before asserting the
# code prompt. Research/automation detect from the template layout alone.

# assert_dir / assert_file: per-entry template structure checks (11.2).
assert_dir() { # <container-path> <label>
	if MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" test -d "$1"; then
		pass "$2"
	else
		fail "$2 (missing directory $1)"
	fi
}
assert_file() { # <container-path> <label>
	if MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" test -f "$1"; then
		pass "$2"
	else
		fail "$2 (missing file $1)"
	fi
}

# seed_session_jsonl <session-dir> <session-id> <cwd> — prints SEEDED on
# success. Writes exactly the v3 header SessionManager.newSession() would
# write (lazy-JSONL workaround, see section 8 header).
seed_session_jsonl() {
	MSYS2_ARG_CONV_EXCL="*" docker exec \
		-e E2E_SID="$2" -e E2E_DIR="$1" -e E2E_CWD="$3" "$CONTAINER_NAME" bun -e '
import { mkdirSync, writeFileSync } from "node:fs";
const id = process.env.E2E_SID;
const ts = new Date().toISOString();
mkdirSync(process.env.E2E_DIR, { recursive: true });
const file = `${process.env.E2E_DIR}/${ts.replace(/[:.]/g, "-")}_${id}.jsonl`;
const header = { type: "session", version: 3, id, timestamp: ts, cwd: process.env.E2E_CWD };
writeFileSync(file, JSON.stringify(header) + "\n");
console.log("SEEDED");
' 2>/dev/null || true
}

# load_prompt <cwd> — run loadSystemPrompt() from the real dist build in
# the container (same approach as check 10.5).
load_prompt() {
	MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" bun -e "
import { loadSystemPrompt } from \"$PROMPT_LOADER_DIST\";
console.log(loadSystemPrompt(\"$1\"));
" 2>/dev/null || true
}

SID_P3_CODE=""
SID_P3_RESEARCH=""
SID_P3_AUTO=""
if [ -z "$TOKEN" ]; then
	fail "phase 3 multi-type checks skipped — no token (see check 3)"
else
	# 11.0. Pre-clean: wipe leftovers from a crashed previous run (volumes persist).
	e2e_workspace_cleanup

	# 11.1. TC-F-3.12-E2E-1 steps 1–3: create the three projects via the API.
	# Each POST must return 201 with the resolved path, the auto-detected
	# type (F-3.2, with the documented template-name fallback for code) and
	# the applied template (F-3.5, TC-F-3.5-1/3).
	for spec in \
		"code|$P3_CODE_NAME|$P3_CODE" \
		"research|$P3_RESEARCH_NAME|$P3_RESEARCH" \
		"automation|$P3_AUTO_NAME|$P3_AUTO"; do
		tmpl="${spec%%|*}"; rest="${spec#*|}"; pname="${rest%%|*}"; ppath="${rest#*|}"
		resp="$(curl -s --max-time 15 -w '\n%{http_code}' -X POST "$BASE_URL/api/projects" \
			-H "Authorization: Bearer $TOKEN" \
			-H "Content-Type: application/json" \
			-d "{\"name\": \"$pname\", \"template\": \"$tmpl\", \"rootPath\": \"/data/repos\"}")"
		code="${resp##*$'\n'}"
		body="${resp%$'\n'*}"
		info "POST /api/projects {name: $pname, template: $tmpl} → $code: $body"
		if [ "$code" = "201" ] && echo "$body" | grep -q "\"path\":\"$ppath\"" \
			&& echo "$body" | grep -q "\"type\":\"$tmpl\"" && echo "$body" | grep -q "\"template\":\"$tmpl\""; then
			pass "project $pname created via API (HTTP 201, type=$tmpl, template=$tmpl)"
		else
			fail "POST /api/projects $pname: expected 201 + path/type/template=$tmpl, got code=$code body=$body"
		fi
	done

	# 11.2. TC-F-3.12-E2E-1 (structure): template layouts materialized on
	# disk inside the container (F-3.3 code, F-3.4 research/automation).
	assert_dir  "$P3_CODE/src"                "code template: src/ exists (F-3.3)"
	assert_dir  "$P3_CODE/tests"              "code template: tests/ exists (F-3.3)"
	assert_dir  "$P3_CODE/docs"               "code template: docs/ exists (F-3.3)"
	assert_file "$P3_CODE/package.json"       "code template: package.json exists (F-3.3)"
	assert_file "$P3_CODE/.fan/settings.json" "code template: .fan/settings.json exists (F-3.3)"
	assert_dir  "$P3_RESEARCH/.fan/prompts"   "research template: .fan/prompts/ exists (F-3.4)"
	assert_file "$P3_RESEARCH/.fan/settings.json" "research template: .fan/settings.json exists (F-3.4)"
	assert_dir  "$P3_RESEARCH/docs/research"  "research template: docs/research/ exists (F-3.4)"
	assert_dir  "$P3_RESEARCH/data"           "research template: data/ exists (F-3.4)"
	assert_dir  "$P3_RESEARCH/reports"        "research template: reports/ exists (F-3.4)"
	assert_file "$P3_AUTO/.fan/settings.json" "automation template: .fan/settings.json exists (F-3.4)"
	assert_dir  "$P3_AUTO/scripts"            "automation template: scripts/ exists (F-3.4)"
	assert_dir  "$P3_AUTO/config"             "automation template: config/ exists (F-3.4)"
	assert_dir  "$P3_AUTO/output"             "automation template: output/ exists (F-3.4)"
	assert_dir  "$P3_AUTO/logs"               "automation template: logs/ exists (F-3.4)"
	if MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" \
		grep -q '^#!/usr/bin/env bash' "$P3_AUTO/scripts/example.sh"; then
		pass "automation template: scripts/example.sh exists with bash shebang (F-3.4, detection placeholder)"
	else
		fail "automation template: scripts/example.sh missing or without shebang under $P3_AUTO"
	fi

	# 11.3. GET /api/projects → all three registered with auto-detected
	# types (F-3.1/F-3.2; code via the documented template-name fallback).
	projects_body="$(curl -s --max-time 10 "$BASE_URL/api/projects" -H "Authorization: Bearer $TOKEN")"
	if echo "$projects_body" | grep -q "\"path\":\"$P3_CODE\"" \
		&& echo "$projects_body" | grep -q "\"path\":\"$P3_RESEARCH\"" \
		&& echo "$projects_body" | grep -q "\"path\":\"$P3_AUTO\""; then
		pass "GET /api/projects: all three projects present in the registry"
	else
		fail "GET /api/projects: expected all three projects, got $projects_body"
	fi
	if echo "$projects_body" | grep -q "\"path\":\"$P3_CODE\",\"name\":\"$P3_CODE_NAME\",\"type\":\"code\""; then
		pass "registry entry $P3_CODE_NAME: type=code"
	else
		fail "registry entry $P3_CODE_NAME: expected type=code, got $projects_body"
	fi
	if echo "$projects_body" | grep -q "\"path\":\"$P3_RESEARCH\",\"name\":\"$P3_RESEARCH_NAME\",\"type\":\"research\""; then
		pass "registry entry $P3_RESEARCH_NAME: type=research"
	else
		fail "registry entry $P3_RESEARCH_NAME: expected type=research, got $projects_body"
	fi
	if echo "$projects_body" | grep -q "\"path\":\"$P3_AUTO\",\"name\":\"$P3_AUTO_NAME\",\"type\":\"automation\""; then
		pass "registry entry $P3_AUTO_NAME: type=automation"
	else
		fail "registry entry $P3_AUTO_NAME: expected type=automation, got $projects_body"
	fi

	# 11.4. One session per project (POST /api/sessions {cwd} ×3 → 201 +
	# response.cwd). Each POST performs the runtime switch; after the loop
	# the automation session is the active one.
	for spec in \
		"SID_P3_CODE|$P3_CODE" \
		"SID_P3_RESEARCH|$P3_RESEARCH" \
		"SID_P3_AUTO|$P3_AUTO"; do
		var="${spec%%|*}"; ppath="${spec#*|}"
		resp="$(curl -s --max-time 15 -w '\n%{http_code}' -X POST "$BASE_URL/api/sessions" \
			-H "Authorization: Bearer $TOKEN" \
			-H "Content-Type: application/json" -d "{\"cwd\": \"$ppath\"}")"
		code="${resp##*$'\n'}"
		body="${resp%$'\n'*}"
		sid="$(echo "$body" | grep -o '"id"[: ]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
		resp_cwd="$(echo "$body" | grep -o '"cwd"[: ]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
		info "POST /api/sessions {cwd: $ppath} → $code, id: ${sid:-<none>}"
		if [ "$code" = "201" ] && [ -n "$sid" ] && [ "$resp_cwd" = "$ppath" ]; then
			pass "session created in $ppath (HTTP 201, response.cwd correct)"
			printf -v "$var" '%s' "$sid"
		else
			fail "POST session $ppath: expected 201 + cwd, got code=$code body=$body"
		fi
	done

	if [ -z "$SID_P3_CODE" ] || [ -z "$SID_P3_RESEARCH" ] || [ -z "$SID_P3_AUTO" ]; then
		fail "multi-type isolation checks aborted — session ids missing (see 11.4)"
		# Keep the declared 38-check shape: the remaining 12 checks of 11.5–11.8
		# cannot run without session ids.
		for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do fail "skipped — no session ids (see 11.4)"; done
	else
		# 11.5. Lazy-JSONL seed per project (same workaround as section 8.4:
		# without an LLM no first assistant response persists the session, so
		# we seed the v3 header SessionManager.newSession() would write).
		for spec in \
			"$SESS_DIR_P3_CODE|$SID_P3_CODE|$P3_CODE" \
			"$SESS_DIR_P3_RESEARCH|$SID_P3_RESEARCH|$P3_RESEARCH" \
			"$SESS_DIR_P3_AUTO|$SID_P3_AUTO|$P3_AUTO"; do
			sdir="${spec%%|*}"; rest="${spec#*|}"; sid="${rest%%|*}"; ppath="${rest#*|}"
			if [ "$(seed_session_jsonl "$sdir" "$sid" "$ppath")" = "SEEDED" ]; then
				pass "session $sid persisted to disk in $ppath (manual JSONL seed)"
			else
				fail "session JSONL seed failed for $ppath (docker exec)"
			fi
		done

		# 11.6. Isolation: GET /api/sessions?project=<p> returns ONLY that
		# project's session (own id + correct cwd present, foreign ids absent).
		for spec in \
			"$P3_CODE|$SID_P3_CODE|$SID_P3_RESEARCH|$SID_P3_AUTO" \
			"$P3_RESEARCH|$SID_P3_RESEARCH|$SID_P3_CODE|$SID_P3_AUTO" \
			"$P3_AUTO|$SID_P3_AUTO|$SID_P3_CODE|$SID_P3_RESEARCH"; do
			ppath="${spec%%|*}"; rest="${spec#*|}"; own="${rest%%|*}"; rest="${rest#*|}"
			other1="${rest%%|*}"; other2="${rest#*|}"
			resp="$(curl -s --max-time 10 -w '\n%{http_code}' "$BASE_URL/api/sessions?project=$ppath" \
				-H "Authorization: Bearer $TOKEN")"
			code="${resp##*$'\n'}"
			body="${resp%$'\n'*}"
			if [ "$code" = "200" ] && echo "$body" | grep -q "\"id\":\"$own\"" \
				&& echo "$body" | grep -q "\"cwd\":\"$ppath\"" \
				&& ! echo "$body" | grep -q "\"id\":\"$other1\"" \
				&& ! echo "$body" | grep -q "\"id\":\"$other2\""; then
				pass "GET /api/sessions?project=$ppath: only own session listed (isolation F-1.2)"
			else
				fail "isolation ?project=$ppath: expected only session $own, got code=$code body=$body"
			fi
		done

		# 11.7. TC-F-3.12-E2E-1 steps 7–9 (REST level): return to each project
		# (POST /api/sessions switches the runtime back) → the previously
		# seeded session data is still in place.
		for spec in \
			"$P3_CODE|$SID_P3_CODE" \
			"$P3_RESEARCH|$SID_P3_RESEARCH" \
			"$P3_AUTO|$SID_P3_AUTO"; do
			ppath="${spec%%|*}"; sid="${spec#*|}"
			switch_code="$(http_status -X POST "$BASE_URL/api/sessions" \
				-H "Authorization: Bearer $TOKEN" \
				-H "Content-Type: application/json" -d "{\"cwd\": \"$ppath\"}")"
			body="$(curl -s --max-time 10 "$BASE_URL/api/sessions?project=$ppath" \
				-H "Authorization: Bearer $TOKEN")"
			if [ "$switch_code" = "201" ] && echo "$body" | grep -q "\"id\":\"$sid\"" \
				&& echo "$body" | grep -q "\"cwd\":\"$ppath\""; then
				pass "return to $ppath: switch OK (201), session $sid data still in place"
			else
				fail "return to $ppath: switch=$switch_code, session $sid presence: $body"
			fi
		done

		# 11.8. TC-F-3.12-E2E-2: per-type system prompts via loadSystemPrompt
		# from the real dist build in the container (F-3.6). The code project
		# gets a simulated `git init` first — the F-3.2 detector requires .git
		# for type=code and the template deliberately ships none (see header).
		MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" mkdir -p "$P3_CODE/.git" 2>/dev/null || true
		code_prompt="$(load_prompt "$P3_CODE")"
		if echo "$code_prompt" | grep -q "coding assistant" \
			&& echo "$code_prompt" | grep -q "src/" && echo "$code_prompt" | grep -q "tests/" \
			&& echo "$code_prompt" | grep -q "$P3_CODE"; then
			pass "system prompt (code): 'coding assistant' role + src//tests/ references + substituted path (F-3.6)"
		else
			fail "system prompt (code): expected coding-assistant prompt, got: $(echo "$code_prompt" | head -3)"
		fi
		research_prompt="$(load_prompt "$P3_RESEARCH")"
		if echo "$research_prompt" | grep -q "research assistant" \
			&& echo "$research_prompt" | grep -q "$P3_RESEARCH/docs/research" \
			&& echo "$research_prompt" | grep -q "$P3_RESEARCH_NAME"; then
			pass "system prompt (research): 'research assistant' role + docs/research output path (F-3.6)"
		else
			fail "system prompt (research): expected research prompt, got: $(echo "$research_prompt" | head -3)"
		fi
		auto_prompt="$(load_prompt "$P3_AUTO")"
		if echo "$auto_prompt" | grep -q "automation assistant" \
			&& echo "$auto_prompt" | grep -q "$P3_AUTO/scripts" \
			&& echo "$auto_prompt" | grep -q "$P3_AUTO_NAME"; then
			pass "system prompt (automation): 'automation assistant' role + scripts/ path (F-3.6)"
		else
			fail "system prompt (automation): expected automation prompt, got: $(echo "$auto_prompt" | head -3)"
		fi
	fi

	# 11.9. Manual checklist for the LLM-bound steps (see section header).
	info "MANUAL (needs LLM): backend-api 'Add user authentication' → src/auth.ts;"
	info "  competitor-analysis /idea-lab:analyze → docs/research/*.md;"
	info "  backup-pipeline 'Create daily backup script' → scripts/daily-backup.sh"

	# 11.10. Post-clean: keep the run idempotent (also runs from the EXIT trap).
	info "Cleanup: removing multi-type test workspaces, session dirs and registry entries"
	e2e_workspace_cleanup
fi

# =========================================================================
section "12. Phase 4 — Autonomy (F-4.16-E2E): scheduler full cycle + budget"
# =========================================================================
# ARCHITECTURE (decision for the phase-4 spec): the scheduler runs INSIDE
# the docker contour as the compose service `fan-scheduler` — same image as
# `fan`, different command
# (bun tools/fan-scheduler/dist/scheduler.js /data/scheduler/config.yaml;
# the Dockerfile builds tools/fan-scheduler and ships its dist). Env wiring:
#   FAN_API_URL=http://fan:3456     (compose DNS; no published port needed)
#   FAN_API_TOKEN=$FAN_SCHEDULER_TOKEN (operator-provisioned ClientToken —
#     here: the bootstrap token from check 3, passed at service start)
#   FAN_CODING_AGENT_DIR=/data/.fan/agent (fan-data volume → the F-4.13
#     persistent queue scheduler-pending.json survives recreation)
#   FAN_SCHEDULER_CONTROL_HOST=0.0.0.0 (control server reachable from the
#     `fan` container for the /api/scheduler/health proxy; the port is NOT
#     published to the host)
# The gateway proxies GET /api/scheduler/health → FAN_SCHEDULER_URL
# (http://fan-scheduler:3457, compose env on the `fan` service, F-4.14).
#
# NO-LLM BOUNDARY (same as sections 9/10): the container has no API keys,
# so the task prompt fails at provider validation ("No model selected" /
# "No API key found" → HTTP 500). For the scheduler pipeline this is the
# EXPECTED terminal state: createSession (201) → budget cap set →
# sendMessage → 500 → retry with exponential backoff (3 attempts, F-4.10)
# → status "failed". Every stage BEFORE the provider is asserted here;
# a live LLM would turn the same pipeline into "completed".
#
# TC MAPPING:
#   TC-F-4.16-E2E-1 (full cycle → git → PR): the git/PR/LLM-dependent steps
#     are the MANUAL checklist below; everything up to the provider
#     boundary is automated (12.1–12.16).
#   TC-F-4.16-E2E-2 (budget alarm): the cap wiring is automated
#     (budget_cap_set BEFORE sendMessage; cap persisted and served by
#     GET /api/budget?project=, 12.14). Actual budget_exceeded needs real
#     token burn (LLM) → unit-tested (executor.test.ts TC-F-4.9-2) + manual.
#   TC-F-4.16-E2E-3 (two cron tasks, serialization): automated — two tasks
#     on the SAME cron trigger: one runs while the other waits pending on
#     disk (F-4.13 file); pause-while-running holds the pending task
#     (F-4.12); resume → strict FIFO completion (12.9–12.13).
#
# MANUAL CHECKLIST (deployment WITH a configured model + GITHUB_TOKEN):
#   1. config.yaml with daily-code-review on a real repo workspace.
#   2. Wait for the trigger → the scheduler creates a session and the agent
#      runs to completion (lastTaskStatus "completed" via
#      /api/scheduler/health).
#   3. Workspace: branch fan-auto/*-YYYYMMDD-* created, changes committed
#      and pushed; PR opened via gh (URL in the scheduler logs).
#   4. Set budget_limit to a minimal value → the task stops with
#      lastTaskStatus "budget_exceeded" and log "stopped: budget exceeded";
#      the pending queue is unaffected.

# sched_ctl <METHOD> <path> — call the scheduler control server from inside
# its container (prints the response body, empty on failure).
sched_ctl() {
	MSYS2_ARG_CONV_EXCL="*" docker exec "$SCHED_CONTAINER" bun -e "
const r = await fetch('http://127.0.0.1:3457$2', { method: '$1' });
console.log(await r.text());
" 2>/dev/null || true
}

if [ -z "$TOKEN" ]; then
	fail "phase 4 checks skipped — no token (see check 3)"
else
	# 12.0. Pre-clean: wipe leftovers from a crashed previous run (volumes persist).
	e2e_workspace_cleanup

	# 12.1. The scheduler is part of the image (Dockerfile ships
	# tools/fan-scheduler/dist next to the package dists — checked via the
	# already-running `fan` container, same image).
	if MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" test -f /app/tools/fan-scheduler/dist/scheduler.js; then
		pass "scheduler shipped in the image (/app/tools/fan-scheduler/dist/scheduler.js)"
	else
		fail "scheduler dist missing in the image (Dockerfile does not ship tools/fan-scheduler)"
	fi

	# 12.2. Test workspace for the cron tasks (.git + src/ → realistic code
	# workspace, same detector convention as section 8).
	if MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" mkdir -p "$SCHED_PROJ/.git" "$SCHED_PROJ/src" 2>/dev/null; then
		pass "scheduler test workspace created ($SCHED_PROJ)"
	else
		fail "failed to create scheduler test workspace in container"
	fi

	# 12.3. Generate the E2E cron config: two tasks on the SAME trigger
	# (TC-F-4.16-E2E-3 setup), scheduled 2 minutes from now (UTC — the
	# container clock). Task A carries a budget cap (F-4.9 wiring), task B
	# uses the defaults (budget_limit null). Written into the repo so the
	# compose bind mount (relative path) resolves on any host OS.
	read -r CRON_M CRON_H CRON_D CRON_MO <<< "$(date -u -d '+2 minutes' '+%-M %-H %-d %-m')"
	cat > "$REPO_ROOT/$SCHED_E2E_CONFIG" <<EOF
tasks:
  - name: $SCHED_TASK_A
    schedule: "$CRON_M $CRON_H $CRON_D $CRON_MO *"
    workspace: $SCHED_PROJ
    message: "e2e scheduler probe A"
    budget_limit: $SCHED_BUDGET_LIMIT
    timeout: 120
  - name: $SCHED_TASK_B
    schedule: "$CRON_M $CRON_H $CRON_D $CRON_MO *"
    workspace: $SCHED_PROJ
    message: "e2e scheduler probe B"
    timeout: 120
EOF
	info "E2E scheduler config: cron \"$CRON_M $CRON_H $CRON_D $CRON_MO *\" (UTC, +2min), tasks $SCHED_TASK_A/$SCHED_TASK_B"

	# 12.4. Start the scheduler service with the bootstrap token and the E2E
	# config (it was deliberately NOT started in section 0 — no token existed).
	FAN_SCHEDULER_TOKEN="$TOKEN" FAN_SCHEDULER_CONFIG="./$SCHED_E2E_CONFIG" \
		$COMPOSE up -d fan-scheduler >/dev/null 2>&1 || true
	sched_running="$(docker inspect -f '{{.State.Running}}' "$SCHED_CONTAINER" 2>/dev/null || true)"
	if [ "$sched_running" = "true" ]; then
		pass "fan-scheduler compose service started (same image, scheduler command)"
	else
		fail "fan-scheduler container not running (State.Running=$sched_running)"
	fi

	# 12.5. Control server readiness (F-4.12): poll /health from inside the
	# scheduler container until it answers 200.
	ctl_ready=0
	deadline=$(( $(date +%s) + 30 ))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		if MSYS2_ARG_CONV_EXCL="*" docker exec "$SCHED_CONTAINER" bun -e \
			"fetch('http://127.0.0.1:3457/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
			>/dev/null 2>&1; then
			ctl_ready=1
			break
		fi
		sleep 1
	done
	if [ "$ctl_ready" = "1" ]; then
		pass "scheduler control server up (GET /health → 200 inside the container)"
	else
		fail "scheduler control server did not become ready within 30s"
	fi

	# 12.6. Cross-container reachability: the `fan` container resolves and
	# reaches http://fan-scheduler:3457 — the exact path the gateway proxy
	# uses (proves the 0.0.0.0 bind + compose DNS).
	x_status="$(MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" bun -e \
		"fetch('http://fan-scheduler:3457/health').then(r => console.log(r.status)).catch(() => console.log('ERR'))" \
		2>/dev/null || true)"
	if [ "$x_status" = "200" ]; then
		pass "control server reachable from the fan container (http://fan-scheduler:3457 → 200)"
	else
		fail "control server from fan container: expected 200, got ${x_status:-no output}"
	fi

	# 12.7. Gateway proxy (F-4.14): GET /api/scheduler/health → 200 with the
	# scheduler's payload (status/running/pendingCount/queueVersion).
	proxy_body="$(curl -s --max-time 10 "$BASE_URL/api/scheduler/health")"
	proxy_code="$(http_status "$BASE_URL/api/scheduler/health")"
	info "GET /api/scheduler/health → $proxy_code: $proxy_body"
	if [ "$proxy_code" = "200" ] && echo "$proxy_body" | grep -q '"status":"ok"'; then
		pass "gateway proxy /api/scheduler/health → 200, status ok (scheduler reachable)"
	else
		fail "gateway proxy /api/scheduler/health: expected 200 + status ok, got code=$proxy_code body=$proxy_body"
	fi
	if echo "$proxy_body" | grep -q '"queueVersion":1' \
		&& echo "$proxy_body" | grep -q '"running":false' \
		&& echo "$proxy_body" | grep -q '"pendingCount":0'; then
		pass "proxy payload shape: queueVersion=1, running=false, pendingCount=0 (fresh queue)"
	else
		fail "proxy payload shape: expected queueVersion=1 + idle queue, got $proxy_body"
	fi

	# 12.8. Startup logs (F-4.11 JSON lines): scheduler_started with 2 tasks
	# loaded from the mounted config + per-task task_scheduled entries.
	sched_logs="$($COMPOSE logs fan-scheduler 2>/dev/null || true)"
	if echo "$sched_logs" | grep -q '"event":"scheduler_started"' \
		&& echo "$sched_logs" | grep -q '"taskCount":2'; then
		pass "config.yaml loaded by the scheduler (scheduler_started, taskCount=2)"
	else
		fail "scheduler_started log with taskCount=2 not found (config not loaded?)"
	fi
	if echo "$sched_logs" | grep -q "\"event\":\"task_scheduled\"" \
		&& echo "$sched_logs" | grep -q "$SCHED_TASK_A" && echo "$sched_logs" | grep -q "$SCHED_TASK_B"; then
		pass "both cron tasks scheduled (task_scheduled for $SCHED_TASK_A and $SCHED_TASK_B)"
	else
		fail "task_scheduled log entries missing for the E2E tasks"
	fi

	# 12.9. Wait for the cron trigger (config fires ~2 minutes after
	# generation; generous timeout for slow container starts).
	triggered=0
	deadline=$(( $(date +%s) + 170 ))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		if $COMPOSE logs fan-scheduler 2>/dev/null | grep -q '"event":"task_triggered"'; then
			triggered=1
			break
		fi
		sleep 2
	done
	if [ "$triggered" = "1" ]; then
		pass "cron trigger fired (task_triggered log, F-4.5)"
	else
		fail "cron trigger did not fire within 170s (cron loop broken?)"
	fi

	# 12.10. TC-F-4.16-E2E-3 (serialization, part 1): both same-minute
	# triggers enqueue; the queue runs ONE task at a time — the first
	# enqueued (FIFO; croner does not guarantee config order for
	# same-minute jobs, so the names are discovered, not assumed) while
	# the other waits pending. Observe the running task within its
	# execution window (~15s with retries — no LLM).
	FIRST_TASK=""
	cur=""
	deadline=$(( $(date +%s) + 30 ))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		cur="$(sched_ctl GET /state)"
		if echo "$cur" | grep -q "\"currentTask\":\"$SCHED_TASK_A\""; then FIRST_TASK="$SCHED_TASK_A"; break; fi
		if echo "$cur" | grep -q "\"currentTask\":\"$SCHED_TASK_B\""; then FIRST_TASK="$SCHED_TASK_B"; break; fi
		sleep 0.5
	done
	SECOND_TASK="$SCHED_TASK_B"
	[ "$FIRST_TASK" = "$SCHED_TASK_B" ] && SECOND_TASK="$SCHED_TASK_A"
	if [ -n "$FIRST_TASK" ] && echo "$cur" | grep -q '"pendingCount":1'; then
		pass "single-consumer serialization: $FIRST_TASK running, $SECOND_TASK pending (pendingCount=1)"
	else
		fail "serialization: expected one running + one pending, got ${cur:-no output}"
	fi

	# 12.11. F-4.12 pause WHILE running + F-4.13 durability: POST /pause →
	# the in-flight task settles but the pending one does NOT auto-start;
	# it stays durable on disk in the fan-data volume the whole time.
	pause_resp="$(sched_ctl POST /pause)"
	if echo "$pause_resp" | grep -q '"state":"paused"'; then
		pass "POST /pause while running → state paused (control server, F-4.12)"
	else
		fail "POST /pause: expected state paused, got ${pause_resp:-no output}"
	fi
	# Wait for the in-flight task to settle (lastResult appears).
	settled=0
	deadline=$(( $(date +%s) + 60 ))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		cur="$(sched_ctl GET /state)"
		if echo "$cur" | grep -q '"lastResult":{"taskName"'; then settled=1; break; fi
		sleep 1
	done
	if [ "$settled" = "1" ] && echo "$cur" | grep -q "\"taskName\":\"$FIRST_TASK\"" \
		&& echo "$cur" | grep -q '"state":"paused"' && echo "$cur" | grep -q '"pendingCount":1'; then
		pass "pause held: $FIRST_TASK settled, $SECOND_TASK did NOT auto-start (paused, pendingCount=1)"
	else
		fail "pause semantics: expected settled $FIRST_TASK + paused + pendingCount=1, got ${cur:-no output}"
	fi
	pending_file="$(MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" cat "$SCHED_PENDING_FILE" 2>/dev/null || true)"
	if echo "$pending_file" | grep -qE '"version": *1' && echo "$pending_file" | grep -q "$SECOND_TASK" \
		&& ! echo "$pending_file" | grep -q "$FIRST_TASK"; then
		pass "persistent queue file: $SECOND_TASK pending on disk while paused ($SCHED_PENDING_FILE, version 1)"
	else
		fail "persistent queue file: expected only $SECOND_TASK, got ${pending_file:-<missing>}"
	fi

	# 12.12. Resume → the pending task starts (FIFO: it runs strictly
	# AFTER the first one settled — serialization, TC-F-4.16-E2E-3).
	resume_resp="$(sched_ctl POST /resume)"
	fifo_ok=0
	deadline=$(( $(date +%s) + 15 ))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		cur="$(sched_ctl GET /state)"
		if echo "$cur" | grep -q "\"currentTask\":\"$SECOND_TASK\""; then fifo_ok=1; break; fi
		sleep 0.5
	done
	if echo "$resume_resp" | grep -q '"ok":true' && [ "$fifo_ok" = "1" ]; then
		pass "POST /resume → $SECOND_TASK started after $FIRST_TASK settled (strict FIFO, no task lost)"
	else
		fail "resume/FIFO: resume=${resume_resp:-no output}, currentTask observed=${cur:-no output}"
	fi

	# 12.13. Both tasks run to their (expected) terminal state serially:
	# lastResult = the second task, queue drained, runner idle. Each task
	# fails at the provider boundary after 3 attempts (~15s — no LLM).
	done_ok=0
	deadline=$(( $(date +%s) + 120 ))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		cur="$(sched_ctl GET /state)"
		if echo "$cur" | grep -q "\"taskName\":\"$SECOND_TASK\"" \
			&& echo "$cur" | grep -q '"pendingCount":0' \
			&& echo "$cur" | grep -q '"isRunning":false'; then
			done_ok=1
			break
		fi
		sleep 2
	done
	if [ "$done_ok" = "1" ]; then
		pass "both tasks executed serially to completion (order $FIRST_TASK → $SECOND_TASK, queue drained, idle)"
	else
		fail "serial execution did not settle within 120s (last state: ${cur:-no output})"
	fi
	# The pending file survives as an empty durable queue (write-on-change).
	pending_final="$(MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" cat "$SCHED_PENDING_FILE" 2>/dev/null || true)"
	if echo "$pending_final" | grep -qE '"tasks": *\[\]'; then
		pass "persistent queue drained on disk after execution (tasks: [])"
	else
		fail "persistent queue after execution: expected tasks: [], got ${pending_final:-<missing>}"
	fi

	# 12.14. Pipeline evidence in the scheduler logs (F-4.11):
	#  - both tasks terminally failed at the provider boundary (expected —
	#    no LLM; proves config→cron→queue→session→message chain),
	#  - retry/backoff ran (attempts=3, task_retry events, F-4.10),
	#  - the budget cap was set BEFORE the prompt (budget_cap_set, F-4.9).
	sched_logs="$($COMPOSE logs fan-scheduler 2>/dev/null || true)"
	if echo "$sched_logs" | grep -q "\"event\":\"task_failed\"" \
		&& echo "$sched_logs" | grep '"event":"task_result"' | grep -q "$SCHED_TASK_A" \
		&& echo "$sched_logs" | grep '"event":"task_result"' | grep -q "$SCHED_TASK_B" \
		&& echo "$sched_logs" | grep '"event":"task_result"' | grep -q '"status":"failed"'; then
		pass "both tasks reached the provider boundary (task_result status=failed ×2 — expected without LLM)"
	else
		fail "task_result logs: expected status=failed for both tasks"
	fi
	if echo "$sched_logs" | grep '"event":"task_result"' | grep -q '"attempts":3' \
		&& echo "$sched_logs" | grep -q '"event":"task_retry"'; then
		pass "retry with exponential backoff ran (attempts=3, task_retry events, F-4.10)"
	else
		fail "retry evidence missing (expected attempts=3 + task_retry events)"
	fi
	if echo "$sched_logs" | grep -q '"event":"budget_cap_set"' \
		&& echo "$sched_logs" | grep '"event":"budget_cap_set"' | grep -q "$SCHED_PROJ"; then
		pass "budget cap set before the prompt (budget_cap_set $SCHED_BUDGET_LIMIT for $SCHED_PROJ, F-4.9)"
	else
		fail "budget_cap_set log missing (cap not wired before sendMessage)"
	fi

	# 12.15. Gateway-side evidence (app.log, F-0.10): the scheduler's REST
	# calls hit the gateway (POST /api/sessions) and the failure happened at
	# provider validation — not in transport, auth or dispatch.
	gw_sessions="$(MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" \
		grep -c "POST /api/sessions" /data/logs/app.log 2>/dev/null || true)"
	gw_provider="$(MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" \
		grep -E "No model selected|No API key found" /data/logs/app.log 2>/dev/null | head -1 || true)"
	if [ -n "$gw_sessions" ] && [ "$gw_sessions" -ge 1 ] 2>/dev/null; then
		pass "gateway served the scheduler's session creations (POST /api/sessions ×$gw_sessions in app.log)"
	else
		fail "app.log: no POST /api/sessions entries (scheduler never reached the gateway?)"
	fi
	if [ -n "$gw_provider" ]; then
		pass "gateway error log confirms the provider boundary (no API key/model — expected without LLM)"
		info "log: $(echo "$gw_provider" | cut -c1-140)"
	else
		fail "app.log: no provider-validation error (unexpected failure stage?)"
	fi

	# 12.16. Budget API (F-4.9 part A): the cap the executor pushed is
	# served back by GET /api/budget?project=; direct PUT/GET round-trip;
	# validation; durable storage in the fan-data volume.
	budget_body="$(curl -s --max-time 10 "$BASE_URL/api/budget?project=$SCHED_PROJ" -H "Authorization: Bearer $TOKEN")"
	info "GET /api/budget?project=$SCHED_PROJ → $budget_body"
	if echo "$budget_body" | grep -q "\"limit\":$SCHED_BUDGET_LIMIT" && echo "$budget_body" | grep -q '"used":0'; then
		pass "GET /api/budget?project= serves the executor-pushed cap (limit=$SCHED_BUDGET_LIMIT, used=0 — no LLM spend)"
	else
		fail "GET /api/budget?project=: expected limit=$SCHED_BUDGET_LIMIT + used=0, got $budget_body"
	fi
	put_resp="$(curl -s --max-time 10 -w '\n%{http_code}' -X PUT "$BASE_URL/api/budget" \
		-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
		-d "{\"project\": \"$SCHED_PROJ\", \"tokenLimit\": 12345}")"
	put_code="${put_resp##*$'\n'}"
	put_body="${put_resp%$'\n'*}"
	get_after_put="$(curl -s --max-time 10 "$BASE_URL/api/budget?project=$SCHED_PROJ" -H "Authorization: Bearer $TOKEN")"
	if [ "$put_code" = "200" ] && echo "$put_body" | grep -q '"limit":12345' \
		&& echo "$get_after_put" | grep -q '"limit":12345'; then
		pass "PUT /api/budget {project, tokenLimit} → 200, cap persisted and served back (12345)"
	else
		fail "budget PUT/GET round-trip: put=$put_code/$put_body get=$get_after_put"
	fi
	bad_put_code="$(http_status -X PUT "$BASE_URL/api/budget" \
		-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
		-d "{\"project\": \"$SCHED_PROJ\", \"tokenLimit\": -5}")"
	if [ "$bad_put_code" = "400" ]; then
		pass "PUT /api/budget with negative tokenLimit → 400 (validation)"
	else
		fail "negative tokenLimit: expected 400, got $bad_put_code"
	fi
	if MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" test -f "$SCHED_BUDGET_FILE" \
		&& MSYS2_ARG_CONV_EXCL="*" docker exec "$CONTAINER_NAME" grep -q "e2e-sched-project" "$SCHED_BUDGET_FILE"; then
		pass "budget store durable in the fan-data volume ($SCHED_BUDGET_FILE — survives container recreation)"
	else
		fail "budget store missing from the fan-data volume ($SCHED_BUDGET_FILE)"
	fi

	# 12.17. Terminal state visible through the gateway proxy (F-4.14).
	proxy_final="$(curl -s --max-time 10 "$BASE_URL/api/scheduler/health")"
	if echo "$proxy_final" | grep -q '"lastTaskStatus":"failed"' && echo "$proxy_final" | grep -q '"running":false'; then
		pass "proxy /api/scheduler/health reflects the terminal state (lastTaskStatus=failed, running=false)"
	else
		fail "proxy terminal state: expected lastTaskStatus=failed + idle, got $proxy_final"
	fi

	# 12.18. Manual checklist for the LLM/GitHub-bound steps (see section header).
	info "MANUAL (needs LLM + GITHUB_TOKEN): full cycle → branch fan-auto/* → commit/push → PR via gh;"
	info "  minimal budget_limit → lastTaskStatus budget_exceeded + 'stopped: budget exceeded' log"

	# 12.19. Post-clean: keep the run idempotent (also runs from the EXIT trap).
	info "Cleanup: removing scheduler test workspace, queue/budget artifacts and the E2E config"
	e2e_workspace_cleanup
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
