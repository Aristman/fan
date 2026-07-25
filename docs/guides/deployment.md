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
| `docs/guides/deployment.md` | This guide |

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

## 4. Obtain the TLS certificate (before enabling the nginx block)

The 443 server block references
`/etc/letsencrypt/live/agent.sea-agents.ru/…` — nginx will fail `nginx -t`
until the certificate exists. Issue it first (F-0.8):

```bash
ssh root@185.219.41.46

certbot certonly --nginx -d agent.sea-agents.ru
```

Certbot spins up a temporary ACME challenge block on port 80 (FAN Store is
unaffected). Verify:

```bash
openssl x509 -in /etc/letsencrypt/live/agent.sea-agents.ru/fullchain.pem -noout -dates
```

Auto-renewal uses the existing certbot systemd timer (already present for
fan.sea-agents.ru):

```bash
systemctl status certbot.timer
certbot renew --dry-run
```

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
  # create a token on the VPS inside the container
  ssh root@185.219.41.46 "docker exec fan-agent bun dist/index.js token create"

  TOKEN=<token>
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

## 7. Updates (re-deploy)

```bash
rsync -avz --delete --exclude node_modules --exclude .git --exclude dist \
  ./ root@185.219.41.46:/opt/fan-agent/
ssh root@185.219.41.46 "cd /opt/fan-agent && docker compose up -d --build"
```

Data (SQLite `fan.db`, JSONL sessions, tokens) persists in the named
volumes `fan-data` / `fan-repos` across rebuilds.

## 8. Rollback

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

## 9. Security notes

- **Single auth layer:** FAN ClientToken (Bearer token / `?token=` for WS),
  enforced by `FAN_PUBLIC=1` in `docker-compose.yml`. HTTP Basic Auth at the
  nginx level was considered and **rejected** for v2; the commented
  `auth_basic` lines in the nginx config document how to add it if the
  decision is ever revisited.
- **CORS** is restricted to `https://agent.sea-agents.ru` via
  `ALLOWED_ORIGINS` (F-0.4).
- The API gateway never binds to a public interface — `127.0.0.1:3456` only.
