# Deployment Guide — FAN Runtime on VPS

Production deployment of the FAN API gateway behind nginx with TLS on
**agent.sea-agents.ru** (VPS `185.219.41.46`).

```
Internet ──HTTPS/443──► nginx (TLS termination, WS upgrade)
                            │ proxy_pass
                            ▼
                     http://127.0.0.1:3456  (loopback only)
                            │
                            ▼
                Docker container `fan-agent` (docker-compose.yml)
```

The same VPS already runs **FAN Store** (`fan.sea-agents.ru`, static files +
htpasswd basic auth) on the same nginx instance. FAN runtime coexists with it:

- nginx owns ports 80/443; virtual hosts are split by `server_name` (SNI) —
  no port conflicts.
- FAN Store files, its server block and `/etc/nginx/.fan-htpasswd` are
  **not touched** by this deployment.
- The FAN API gateway binds to `127.0.0.1:3456` (loopback only, see
  `docker-compose.yml`) and is reachable exclusively through nginx.

---

## 1. Requirements

On the VPS (`root@185.219.41.46`, Ubuntu):

| Component | Check | Install |
|-----------|-------|---------|
| Docker | `docker --version` | [docs.docker.com/engine/install/ubuntu](https://docs.docker.com/engine/install/ubuntu/) |
| Compose plugin | `docker compose version` | `apt-get install docker-compose-plugin` |
| nginx | `nginx -v` | already installed (FAN Store) |
| certbot | `certbot --version` | `apt-get install certbot python3-certbot-nginx` |
| DNS | A-record `agent.sea-agents.ru → 185.219.41.46` | registrar / DNS provider panel |

Verify DNS before continuing:

```bash
dig +short agent.sea-agents.ru
# expected: 185.219.41.46
```

## 2. Files involved (in this repo)

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build → slim runtime image |
| `docker-compose.yml` | Service `fan`, loopback port binding, volumes, env |
| `deploy/nginx/agent.sea-agents.ru.conf` | nginx server block (443 + 80→443 redirect, WS upgrade) |
| `deploy/scripts/setup-tls.sh` | Idempotent certbot setup/verification script (F-0.8), run on the VPS |
| `deploy/scripts/e2e-local.sh` | Automated E2E smoke test on local Docker / VPS loopback (F-0.11-E2E, section 7; 107 checks incl. phase 5 concurrency — section 13) |
| `docs/guides/deployment.md` | This guide |
| `deploy/scheduler/config.yaml` | Default scheduler task config (mounted into `fan-scheduler`, F-4.16) |
| `deploy/scripts/backup-db.sh` | Daily SQLite backup script with rotation (F-4.15) |

## 3. Copy files to the VPS

From the local repo checkout:

```bash
# App sources (build happens on the VPS inside Docker)
rsync -avz --delete \
  --exclude node_modules --exclude .git --exclude dist \
  ./ root@185.219.41.46:/opt/fan-agent/

# nginx config
scp deploy/nginx/agent.sea-agents.ru.conf \
  root@185.219.41.46:/etc/nginx/sites-available/agent.sea-agents.ru.conf
```

> **Note:** copying the whole repo is the simplest path (Dockerfile builds
> from the repo root). A leaner alternative is a git clone on the VPS —
> what matters is that `Dockerfile` and `docker-compose.yml` end up in the
> same directory (e.g. `/opt/fan-agent/`).

## 4. TLS certificate — certbot (F-0.8)

The 443 server block references
`/etc/letsencrypt/live/agent.sea-agents.ru/…` — nginx will fail `nginx -t`
until the certificate exists. Issue it **before** enabling the nginx block.

### 4.1 Automated: `deploy/scripts/setup-tls.sh` (preferred)

The script covers TC-F-0.8-1 / TC-F-0.8-2 end to end and is **idempotent**
(safe to re-run — an existing valid certificate is never re-issued):

```bash
ssh root@185.219.41.46
cd /opt/fan-agent
bash deploy/scripts/setup-tls.sh
# or fully non-interactive:
CERTBOT_EMAIL=admin@sea-agents.ru bash deploy/scripts/setup-tls.sh
```

Steps performed by the script:

1. DNS check — `agent.sea-agents.ru` must resolve to `185.219.41.46`
   (aborts early if the A record is missing/wrong).
2. certbot installation check (installs `certbot python3-certbot-nginx`
   via apt if missing).
3. `certbot certonly --nginx -d agent.sea-agents.ru` — skipped if
   `/etc/letsencrypt/live/agent.sea-agents.ru/fullchain.pem` already exists.
4. certbot renewal timer check — enables `certbot.timer` if not active.
5. `certbot renew --dry-run` — verifies renewal works.
6. Prints certificate subject/issuer/dates + days left until expiry.

### 4.2 Manual fallback

If you prefer to run the steps by hand:

```bash
ssh root@185.219.41.46

# prerequisite: DNS A record agent.sea-agents.ru → 185.219.41.46
dig +short agent.sea-agents.ru

certbot certonly --nginx -d agent.sea-agents.ru

openssl x509 -in /etc/letsencrypt/live/agent.sea-agents.ru/fullchain.pem -noout -dates
```

Certbot spins up a temporary ACME challenge block on port 80 (FAN Store is
unaffected).

### 4.3 Where the certificates live

| Path | Content |
|------|---------|
| `/etc/letsencrypt/live/agent.sea-agents.ru/fullchain.pem` | Cert + chain (symlink → `../../archive/…`), referenced by nginx `ssl_certificate` |
| `/etc/letsencrypt/live/agent.sea-agents.ru/privkey.pem` | Private key, referenced by nginx `ssl_certificate_key` |
| `/etc/letsencrypt/archive/agent.sea-agents.ru/` | All historical cert versions |
| `/etc/letsencrypt/renewal/agent.sea-agents.ru.conf` | Renewal params (authenticator = nginx) |

Both nginx and certbot must keep access to these paths — do not move them.

### 4.4 Automatic renewal

The certbot apt package ships a **systemd timer** that runs
`certbot renew` twice daily; certificates are renewed when <30 days remain
(Let's Encrypt issues 90-day certs). The same timer already serves
`fan.sea-agents.ru` (FAN Store) — one timer handles all domains on the host.

```bash
systemctl status certbot.timer   # expected: active (waiting), enabled
certbot renew --dry-run          # expected: exit 0, "Congratulations, all simulated renewals succeeded"
```

The nginx authenticator performs the HTTP-01 challenge through nginx itself
(port 80 must stay reachable from the Internet for renewals to work — the
`location /.well-known/acme-challenge/` block in the nginx config also
supports the webroot flow).

### 4.5 If the certificate expires or renewal fails

Symptoms: browsers show `NET::ERR_CERT_DATE_INVALID`, curl fails with
`certificate has expired`, `openssl x509 … -enddate` shows a past date.

1. Re-run the setup script — it re-checks DNS, re-issues if the live cert
   is missing, and reports days left:
   `bash /opt/fan-agent/deploy/scripts/setup-tls.sh`
2. Inspect renewal errors: `certbot renew --dry-run` and
   `journalctl -u certbot.timer` / `less /var/log/letsencrypt/letsencrypt.log`.
3. Common causes: DNS record changed/removed, port 80 blocked by a firewall,
   nginx not running (the nginx authenticator needs it), or rate limits
   (Let's Encrypt: 5 duplicate certs per domain per week — use
   `--dry-run`/staging for experiments).
4. Force re-issue if needed: `certbot certonly --nginx -d agent.sea-agents.ru --force-renewal`
   then `systemctl reload nginx`.

## 5. Start the stack

Order matters: container first (so the proxy target exists), then nginx.

```bash
# 1. Build & start FAN runtime
cd /opt/fan-agent
docker compose up -d --build

# 2. Wait for the healthcheck
docker compose ps            # status: (healthy)
docker compose logs -f fan   # Ctrl-C to exit

# 3. Enable the nginx server block
ln -s /etc/nginx/sites-available/agent.sea-agents.ru.conf \
      /etc/nginx/sites-enabled/agent.sea-agents.ru.conf

# 4. Validate & reload (existing fan.sea-agents.ru keeps running)
nginx -t
systemctl reload nginx
```

> **If `nginx -t` fails with “duplicate map $connection_upgrade”:** another
> config on the host already defines that map. Remove the `map` block from
> `agent.sea-agents.ru.conf` (it is defined exactly once per nginx instance)
> and re-run `nginx -t`.

## 6. Post-deploy verification checklist

TC-F-0.7-1 / TC-F-0.7-2 and the auth smoke checks. Run from any machine
(or from the VPS itself):

- [ ] **TC-F-0.7-1 — Health endpoint over HTTPS**

  ```bash
  curl -s https://agent.sea-agents.ru/api/health
  ```
  Expected: HTTP 200, JSON body with `"status": "ok"`.
  (`/api/health` is exempt from auth.)

- [ ] **Auth enforced — 401 without a token** (FAN_PUBLIC=1)

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" https://agent.sea-agents.ru/api/sessions
  ```
  Expected: `401`.

- [ ] **Authorized request works**

  ```bash
  # Bootstrap: POST /api/tokens is itself token-protected and there is no
  # `fan token create` CLI — create the first token directly in the DB
  # inside the container via the app's own @fan/db Prisma layer
  # (see "Token bootstrap" in section 7):
  TOKEN=$(ssh root@185.219.41.46 "docker exec -w /app/packages/coding-agent fan-agent bun -e '
import { getPrismaClient } from \"@fan/db\";
import { randomBytes, randomUUID } from \"node:crypto\";
const p = getPrismaClient();
const t = randomBytes(32).toString(\"hex\");
await p.clientToken.create({ data: { id: randomUUID(), name: \"manual\", token: t } });
await p.\$disconnect();
console.log(t);'" | grep -oE '[0-9a-f]{64}')

  curl -s -X POST https://agent.sea-agents.ru/api/sessions \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{}'
  ```
  Expected: HTTP 201 with the created session.

- [ ] **TC-F-0.7-2 — WebSocket upgrade**

  ```bash
  # wscat: npm i -g wscat
  wscat -c "wss://agent.sea-agents.ru/api/ws/<sessionId>?token=$TOKEN"
  ```
  Expected: `Connected (press CTRL+C to quit)` — the server answered
  `101 Switching Protocols`.

  Negative check (no token → 401):

  ```bash
  wscat -c "wss://agent.sea-agents.ru/api/ws/<sessionId>"
  ```
  Expected: connection rejected (`error: Unexpected server response: 401`).

- [ ] **FAN Store still works**

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" https://fan.sea-agents.ru/fan/index.json
  ```
  Expected: `401` (htpasswd prompt) or `200` with credentials — unchanged behavior.

- [ ] **Direct port access is impossible** (loopback bind)

  ```bash
  curl -s --max-time 3 http://185.219.41.46:3456/api/health
  ```
  Expected: connection refused / timeout.

## 7. E2E verification after deploy (F-0.11-E2E)

Two layers: an **automated script** for the full local-Docker cycle (also
runnable on the VPS against the loopback port) and a **manual checklist**
for the VPS-specific parts the script cannot cover (HTTPS/TLS through
nginx, `wss://`, certbot).

### 7.1 Automated: `deploy/scripts/e2e-local.sh`

Runs the whole stack locally exactly as on the VPS (same Dockerfile,
docker-compose.yml, `FAN_PUBLIC=1`, `ALLOWED_ORIGINS`) and verifies the
contour end to end:

```bash
bash deploy/scripts/e2e-local.sh
```

What it does:

1. `docker compose up -d --build`, then polls `GET /api/health` until 200
   (timeout `E2E_HEALTH_TIMEOUT`, default 180s).
2. **Health** — 200 + `db:"up"` in the body.
3. **Auth enforced** — `GET /api/sessions` without a token → 401
   (proves `FAN_PUBLIC=1` keeps auth on, F-0.3).
4. **Token bootstrap** — creates a token inside the container (see 7.2).
5. **Sessions** — `POST /api/sessions` with the token → 201; the session is
   retrievable via `GET /api/sessions/<id>` and reported as active by
   `/api/health`; `GET /api/sessions` → 200 with a sessions array.
   (A new session appears in the *list* only after its first assistant
   message is persisted — SessionManager creates the JSONL file on the
   first assistant response by design.)
6. **CORS** — `Origin: https://evil.com` gets no
   `Access-Control-Allow-Origin`; `https://agent.sea-agents.ru` does (F-0.4).
7. **File logging** — `/data/logs/app.log` exists and is non-empty (F-0.10).
8. **WebSocket** (optional — needs `bun` or `wscat` on the host) — upgrade
   to `/api/ws/<sessionId>?token=…` succeeds and the `connected` welcome
   frame arrives.
9. `docker compose down` via `trap` on exit (volumes are kept).

Exit code is 0 only when every check passes; each check prints a colored
`[PASS]`/`[FAIL]`/`[SKIP]` line.

**On the VPS after deploy:** the API is bound to `127.0.0.1:3456`, so the
same script works unchanged over SSH:

```bash
ssh root@185.219.41.46 "cd /opt/fan-agent && bash deploy/scripts/e2e-local.sh"
```

### 7.2 Token bootstrap (first token with auth enabled)

`POST /api/tokens` is protected by the same `tokenAuth` middleware as every
other `/api/*` route, and there is no `fan token create` CLI command — so
the first token cannot be created over HTTP (chicken-and-egg). The working
path is operator-side provisioning directly into the SQLite DB inside the
container, using the app's own `@fan/db` Prisma layer (this does **not**
weaken runtime auth — it is the equivalent of inserting a row into the
`ClientToken` table by hand):

```bash
docker exec -w /app/packages/coding-agent fan-agent bun -e '
import { getPrismaClient } from "@fan/db";
import { randomBytes, randomUUID } from "node:crypto";
const prisma = getPrismaClient();
const token = randomBytes(32).toString("hex");
await prisma.clientToken.create({ data: { id: randomUUID(), name: "bootstrap", token } });
await prisma.$disconnect();
console.log(token);
'
```

Notes:

- `-w /app/packages/coding-agent` is required: bun's isolated install links
  workspace packages into the consuming package's `node_modules`, so
  `@fan/db` does not resolve from the `/app` cwd.
- The DB lives at `/data/.fan/agent/filin.db` (volume `fan-data`).
- `e2e-local.sh` performs this step automatically (check 3).

### 7.3 VPS manual checklist (TC-F-0.11-E2E-1/2/3)

The script covers HTTP on loopback; the following must be verified by hand
on the VPS because they involve nginx + TLS:

- [ ] **TC-F-0.11-E2E-1 — stack up**: `docker ps` shows `fan-agent`
  `(healthy)`; `ss -tlnp | grep -E ':(80|443)\b'` shows nginx;
  `nginx -t` is clean.
- [ ] **TC-F-0.11-E2E-2 — HTTPS health**: `curl -sk https://agent.sea-agents.ru/api/health`
  → 200 with `db:"up"` (valid certificate, no `-k` needed from outside).
- [ ] **TC-F-0.11-E2E-2 — WebSocket over TLS**: `wscat -c "wss://agent.sea-agents.ru/api/ws/<sessionId>?token=$TOKEN"`
  → `Connected`; a `{"type":"connected",...}` welcome frame arrives.
  Negative: without `?token=` → `Unexpected server response: 401`.
- [ ] **TC-F-0.11-E2E-2 — session over HTTPS**: `curl -sk -X POST https://agent.sea-agents.ru/api/sessions -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'`
  → 201; `curl -sk https://agent.sea-agents.ru/api/sessions/<id> -H "Authorization: Bearer $TOKEN"` → 200.
- [ ] **TC-F-0.11-E2E-3 — auth cannot be disabled**: with `FAN_PUBLIC=1`
  (and even `FAN_NO_AUTH=1` set), `curl -sk https://agent.sea-agents.ru/api/sessions`
  → 401.
- [ ] **Certificate validity** (TC-F-0.8-1):
  `openssl x509 -in /etc/letsencrypt/live/agent.sea-agents.ru/fullchain.pem -noout -dates`
  → `notAfter` in the future (90-day LE cert); re-check anytime with
  `bash /opt/fan-agent/deploy/scripts/setup-tls.sh` (prints days left).
- [ ] **Renewal works** (TC-F-0.8-2): `systemctl status certbot.timer`
  → active; `certbot renew --dry-run` → exit 0.

## 8. Updates (re-deploy)

```bash
rsync -avz --delete --exclude node_modules --exclude .git --exclude dist \
  ./ root@185.219.41.46:/opt/fan-agent/
ssh root@185.219.41.46 "cd /opt/fan-agent && docker compose up -d --build"
```

Data (SQLite `filin.db`, JSONL sessions, tokens, scheduler pending queue)
persists in the named volumes `fan-data` / `fan-repos` across rebuilds.

### 8.1 Workspaces — multi-project support (Phase 1)

The container treats `/data/repos` as the **workspace root**
(`FAN_WORKSPACE_ROOT=/data/repos` in `docker-compose.yml`, backed by the
`fan-repos` volume). All agent projects should live under this directory.

- **Whitelist protection (F-1.13):** `POST /api/sessions` accepts a `cwd`
  only inside the workspace root. Paths outside it — including symlink
  escapes — are rejected with HTTP 403 and written to the audit log
  (`[api-gateway][audit] cwd rejected ...` in `/data/logs/app.log`).
- **Project registry:** registered workspaces are tracked in
  `/data/.fan/agent/projects.json` (inside the `fan-data` volume).
  `GET /api/projects` exposes the registry with per-project session counts.
- **Auto-registration (F-1.7):** the first session created in a workspace
  registers it automatically — `.git` present → type `"code"`, `docs/`
  present → `"research"`, otherwise `"unknown"`.
- **Manual registration** (rarely needed — auto-registration covers the
  common case), inside the container:

  ```bash
  docker exec -w /app fan-agent bun packages/coding-agent/dist/cli.js project register /data/repos/my-project
  docker exec -w /app fan-agent bun packages/coding-agent/dist/cli.js project list
  ```

  Or via any `fan` binary on the host: `fan project register /data/repos/my-project`,
  `fan project list`.

### 8.2 Message queue when the engine is busy (Phase 2)

The runtime executes one session at a time. When the engine is busy and a
`sendMessage` arrives for another session (e.g. a second browser tab working
in a different project), the WebSocket dispatcher enqueues it per session
(FIFO, cap 50 messages) and acknowledges the client with
`{ type: "queued", position: N }`; beyond the cap the message is rejected
with `{ type: "queue_full", error: "QUEUE_OVERFLOW", limit: 50 }`. After
each turn completes, the globally-oldest queued message is dispatched
automatically. The queue is **in-memory only** — pending messages are lost
on `docker compose restart`, so clients should re-send after reconnect if
they never received an `agent_event` for a queued message. Registry cleanup
for deleted workspaces: `DELETE /api/projects?path=` (removes the entry
from `projects.json` only — sessions and files are never touched).

### 8.3 Workspace types and templates (Phase 3)

Workspaces under `/data/repos` are classified by **type** — `code`,
`research`, `automation` or `unknown` — stored in the project registry
(`/data/.fan/agent/projects.json`). Types drive the dashboard icons and the
type-aware system prompts.

- **Auto-detection (F-3.2)** runs at registration and at project creation:
  priority `code > research > automation > unknown`. Criteria: `code` =
  `.git` + (`src/` or `package.json`); `research` = `docs/research/` or
  `.fan/prompts/`; `automation` = script files (`*.sh`/`*.py` in root or
  `scripts/`) + config (`config/` dir or root-level `*.yaml`/`*.yml`/`*.toml`/
  `*.ini`/`*.cfg`); otherwise `unknown`.
- **Creation from templates (F-3.5):** `POST /api/projects` with
  `{ "name", "template": "code"|"research"|"automation", "rootPath": "/data/repos" }`
  materializes the directory structure inside the workspace root and
  registers the project (see the [API reference](api-reference.md#create-project)
  for the full contract). The dashboard offers the same flow via the create
  project dialog.
- **Manual override:** when detection misclassifies a project,
  `PUT /api/projects?path= { "type": ... }` fixes the registry entry
  (dashboard: per-project type editor in the switcher).
- **Per-type system prompts (F-3.6, standalone):**
  `packages/coding-agent/src/workspace/prompt-loader.ts` resolves a base
  prompt per type, with `<cwd>/.fan/prompts/system.md` as a full override
  and `{workspace_path}` / `{project_name}` variable substitution. The
  module is NOT wired into the runtime yet — integration into
  `AgentSession._rebuildSystemPrompt()` is a documented future phase.
- The `code` template deliberately does not run `git init` — without
  `.git` the detector would return `unknown`, so the template name is used
  as the declared type fallback. Run `git init` inside the new project when
  ready.

### 8.4 Autonomous tasks — fan-scheduler service (Phase 4)

`docker-compose.yml` ships a second service, **`fan-scheduler`** — the
autonomous cron-based task runner (`tools/fan-scheduler`, same image as
`fan`, command `bun tools/fan-scheduler/dist/scheduler.js
/data/scheduler/config.yaml`). It reads a YAML task config, enqueues tasks
on cron triggers and executes them through the gateway API (one task at a
time, FIFO). Full guide: [scheduler.md](scheduler.md).

- **`FAN_SCHEDULER_TOKEN` (required for task execution).** The scheduler
  authenticates against the gateway with a regular ClientToken. Provision
  one via the token bootstrap (section 7.2) and put it into `.env`:
  `FAN_SCHEDULER_TOKEN=<64-hex>`. Without it the service still starts
  (control/health server work) but every task fails with
  `"FAN API token is not configured"`.
- **Task config** is an operator artifact mounted read-only:
  `./deploy/scheduler/config.yaml → /data/scheduler/config.yaml` (override
  the mount source via `FAN_SCHEDULER_CONFIG` in `.env`). `workspace` paths
  are **container paths** under `/data/repos` (the `fan-repos` volume).
  The scheduler hot-reloads the file on change (mtime watcher) — edit on
  the host, no restart needed.
- **Networking:** the scheduler reaches the gateway over the internal
  compose network (`FAN_API_URL=http://fan:3456`); its control server
  (port 3457) is bound to `0.0.0.0` inside the network so the gateway can
  proxy `GET /api/scheduler/health` (`FAN_SCHEDULER_URL=http://fan-scheduler:3457`
  on the `fan` service). **Port 3457 is never published to the host.**
- **Persistence:** the pending queue (`scheduler-pending.json`, F-4.13)
  lives in the shared `fan-data` volume — pending tasks survive container
  recreation.
- **`GITHUB_TOKEN` (optional):** PAT of a dedicated bot account for
  autonomous git/PR actions (branches `fan-auto/*`, `gh pr create`). Set in
  `.env`; when unset, git/PR actions are marked unavailable
  (`gitEnabled=false`) and the scheduler keeps running. Recommended:
  GitHub branch protection on `main`/`master` (see scheduler.md).
- **Health:** `curl http://127.0.0.1:3456/api/scheduler/health` →
  `{"status":"ok","running":false,"pendingCount":0,...}`; `503
  scheduler:"down"` when the scheduler container is unreachable.

```bash
docker compose up -d --build        # starts fan + fan-scheduler
docker compose logs -f fan-scheduler  # JSONL structured logs
docker compose ps                    # both services (healthy)
```

#### DB backup cron (F-4.15)

Daily SQLite backup via `deploy/scripts/backup-db.sh` + system cron on the
VPS (keeps the last 7 copies, `chmod 600` per copy / `chmod 700` on the
backup dir; uses `sqlite3 .backup` when available — safe for the live DB):

```cron
# FAN DB backup — daily at 03:00 (F-4.15)
0 3 * * * /opt/fan-agent/deploy/scripts/backup-db.sh >> /var/log/fan-backup.log 2>&1
```

Backups are written to `$FAN_AGENT_DIR/backups/` (in Docker: inside the
`fan-data` volume). See [scheduler.md — DB Backup](scheduler.md) for env
vars (`DB_PATH`, `BACKUP_DIR`, `KEEP`), the docker exec variant and
off-site encryption notes.

### 8.5 Concurrency — persistent queue and per-project tokens (Phase 5)

- **Persistent message queue (F-5.5/F-5.6).** In server mode the WS
  dispatcher queue is persistent by default: queued client messages live as
  JSONL files under `/data/.fan/agent/queues` (inside the **`fan-data`
  volume**, since compose sets `FAN_CODING_AGENT_DIR=/data/.fan/agent`) and
  survive container restarts/recreation. On startup the server restores
  pending queues and notifies WS clients (`queues_restored` frame).
  Delivery is at-least-once (a crash mid-dispatch may redeliver a message).
  The E2E cleanup wipes the queue dir for idempotency — do the same after a
  crashed deploy if stale entries accumulate:
  `docker exec fan-agent rm -rf /data/.fan/agent/queues`.
- **Per-project tokens (F-5.7).** For multi-tenant setups you can issue
  tokens restricted to a single project:
  `POST /api/tokens { "name": "...", "projectScope": "/data/repos/<project>" }`.
  A scoped token can only access its own project (sessions, budget), manage
  only its own tokens, and gets `403` on global mutations (model settings,
  provider budget, project registry changes). Existing tokens stay
  full-access. Details: [api-reference.md — Project Scope](api-reference.md#project-scope-f-57).
- **No `process.chdir()` in the runtime (F-5.4):** parallel sessions of
  different projects are fully cwd-isolated; `/proc/1/cwd` of the container
  never changes (verified in E2E section 13).

## 9. Rollback

nginx layer (takes agent.sea-agents.ru offline, FAN Store unaffected):

```bash
rm /etc/nginx/sites-enabled/agent.sea-agents.ru.conf
nginx -t && systemctl reload nginx
```

Container layer:

```bash
cd /opt/fan-agent
docker compose down            # volumes are kept; add -v to also wipe data
```

Full rollback = both steps. Certificates and `/etc/letsencrypt` do not need
to be removed — they simply become unused.

## 10. Security notes

- **Single auth layer:** FAN ClientToken (Bearer token / `?token=` for WS),
  enforced by `FAN_PUBLIC=1` in `docker-compose.yml`. HTTP Basic Auth at the
  nginx level was considered and **rejected** for v2; the commented
  `auth_basic` lines in the nginx config document how to add it if the
  decision is ever revisited.
- **CORS** is restricted to `https://agent.sea-agents.ru` via
  `ALLOWED_ORIGINS` (F-0.4).
- The API gateway never binds to a public interface — `127.0.0.1:3456` only.
- **Query-string tokens in logs:** the application logger scrubs the value
  of any `?token=` / `&token=` parameter before it reaches
  `/data/logs/app.log` or `docker logs`. nginx `access_log`, however, still
  records the full request URI by default. On the VPS, avoid leaking tokens
  into nginx logs by using a `log_format` that omits the query string
  (for example log `$uri` instead of `$request_uri`) or by rotating/cleaning
  access logs regularly.
- **Workspace whitelist (F-1.13):** session `cwd` is confined to
  `FAN_WORKSPACE_ROOT` (`/data/repos`). Out-of-whitelist and symlink-escape
  attempts return 403 and are audit-logged — watch for
  `cwd rejected by workspace whitelist` entries in `/data/logs/app.log`.
