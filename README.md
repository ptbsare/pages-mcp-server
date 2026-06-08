# Pages MCP Server

Self-hosted MCP server for deploying static websites and sharing files/folders. Deploy HTML pages, entire sites, or individual files via MCP tools or REST API — get shareable public URLs instantly.

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [MCP Tools](#mcp-tools)
- [API Reference](#api-reference)
- [Client Modes](#client-modes)
- [Security](#security)
- [Configuration](#configuration)
- [Docker](#docker)
- [Nginx Reverse Proxy](#nginx-reverse-proxy)
- [License](#license)

## Features

- **Deploy HTML** — send raw HTML string or local `.html` file
- **Deploy Folder** — zip a local site folder (CSS, JS, images…), deploy all files
- **Share Files/Folders** — file listing with preview (text with syntax highlighting, images with HEIC conversion)
- **Public Pages** — all pages at `/s/:shareId`, no auth required
- **File Shares** — files/folders at `/f/:shareId` with directory navigation and zip download
- **MCP Protocol** — 5 tools: `deploy_html`, `deploy_folder`, `deploy_file`, `list_pages`, `delete_page`
- **Admin Dashboard** — web UI for managing pages, API tokens, and 2FA
- **Lock/Unlock** — prevent auto-cleanup of important shares
- **Auto-cleanup** — delete expired shares (configurable via `SHARE_EXPIRE_DAYS`)
- **2FA (TOTP)** — optional two-factor authentication for admin access
- **Docker** — multi-arch images, multi-stage build, non-root user

## Quick Start

### Via npx (recommended)

```bash
# Start server
npx github:ptbsare/pages-mcp-server server \
  --port 3000 \
  --domain https://mysite.com \
  --admin-user admin \
  --admin-pass secret
```

After starting, access the **admin dashboard** at `https://mysite.com:3000/`. Create API tokens from there.

**Stdio MCP client** (for AI assistants):
```bash
npx github:ptbsare/pages-mcp-server client \
  --url https://mysite.com:3000 \
  --auth-token your-api-token
```

**Interactive CLI**:
```bash
npx github:ptbsare/pages-mcp-server client \
  --url https://mysite.com:3000 \
  --interactive
```

### Via Docker

```bash
docker run -d \
  --name pages-mcp \
  -p 3000:3000 \
  -e DOMAIN=https://mysite.com \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=secret \
  -e OUT_PORT=3000 \
  -v pages-data:/data \
  ghcr.io/ptbsare/pages-mcp-server/pages-mcp-server:latest
```

### Via Source

```bash
git clone https://github.com/ptbsare/pages-mcp-server
cd pages-mcp-server
npm install
npm run build
node dist/server/index.js
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Server (Express)                       │
│                                                              │
│  /              → Admin Dashboard (Basic auth + 2FA)         │
│  /mcp           → MCP JSON-RPC (Bearer token auth)           │
│  /api/deploy    → Deploy REST API (Bearer token auth)        │
│  /api/admin     → Admin REST API (Basic auth + 2FA)          │
│  /s/:shareId    → Public static page (no auth)               │
│  /f/:shareId    → File share page (no auth)                  │
│  /f/:shareId/raw/** → Direct file download (no auth)         │
│  /health        → Health check                               │
│                                                              │
│  sql.js (SQLite) + File Storage                              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                        Client                                 │
│                                                              │
│  Mode 1: HTTP MCP Client (direct /mcp JSON-RPC calls)        │
│  Mode 2: Stdio MCP Server (local proxy to remote, for AI)    │
│  Mode 3: Interactive CLI (manual commands)                   │
└──────────────────────────────────────────────────────────────┘
```

## MCP Tools

| Tool | Description | Required Args | Optional Args |
|------|-------------|---------------|---------------|
| `deploy_html` | Deploy HTML string or local file as a public page | `value` (string) or `path` (local .html file) | `name`, `description` |
| `deploy_folder` | Deploy a local folder as a static website (must contain index.html) | `path` (string) | `name`, `description` |
| `deploy_file` | Share a local file or folder | `path` (string) | `name`, `description` |
| `list_pages` | List all deployed pages and shares | — | `limit`, `offset` |
| `delete_page` | Delete a page or share by database ID | `id` (string) | — |

**Client-side path validation** (applies to `deploy_html`, `deploy_folder`, `deploy_file`):

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `DEPLOY_ALLOW_ALL` | — | Set to `"1"` to disable all path restrictions |
| `DEPLOY_ALLOW_PATHS` | — | Comma-separated allowed path prefixes (e.g. `/tmp,/home/user`) |
| `DEPLOY_BLOCK_PATHS` | `/etc,/var,/usr,...` | Comma-separated blocked path prefixes |
| `DEPLOY_BLOCK_ROOT_DIRS` | `/root/.ssh,/root/.gnupg,/root/.aws,...` | Comma-sensitive directories under `/root` to block |

## API Reference

### Authentication

| Layer | Method | Used For |
|-------|--------|----------|
| **Admin** | HTTP Basic + optional TOTP 2FA | Dashboard, token management, page CRUD |
| **API/MCP** | Bearer token (`Authorization: Bearer <token>`) | Deploy, list, delete |

### URL Types

| Pattern | Type | Description |
|---------|------|-------------|
| `/s/:shareId` | Static Page | HTML/CSS/JS website |
| `/s/:shareId/*` | Page Resource | Sub-resources (images, CSS, JS) |
| `/f/:shareId` | File Share | File listing with preview |
| `/f/:shareId/raw/**` | File Download | Direct file access |
| `/f/:shareId/list/**` | Directory API | JSON directory listing |

### REST Endpoints

**Deploy HTML:**
```bash
curl -X POST https://mysite.com/api/deploy/html \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"value": "<html><body><h1>Hello</h1></body></html>", "name": "My Page"}'
```

**Deploy Folder (zip):**
```bash
base64 -w0 site.zip | xargs -I{} curl -X POST https://mysite.com/api/deploy/folder \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"zipBase64": "{}", "name": "My Site"}'
```

**Deploy File:**
```bash
# Single file
curl -X POST "https://mysite.com/api/deploy/file?filename=report.pdf" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @report.pdf

# Folder (zip)
curl -X POST "https://mysite.com/api/deploy/file?filename=my-site.zip&name=My Site" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @my-site.zip
```

**Token Management:**
```bash
curl -u admin:password https://mysite.com/api/admin/tokens                    # List
curl -X POST -u admin:password https://mysite.com/api/admin/tokens -d '{"name": "CI"}'  # Create
curl -X DELETE -u admin:password https://mysite.com/api/admin/tokens/<id>     # Delete
```

**Page Management:**
```bash
curl -u admin:password https://mysite.com/api/admin/pages              # List
curl -X POST -u admin:password https://mysite.com/api/admin/pages/<id>/lock -d '{"locked": true}'
curl -X PUT -u admin:password https://mysite.com/api/admin/pages/<id> -d '{"name": "New Name"}'
curl -X DELETE -u admin:password https://mysite.com/api/admin/pages/<id>
```

## Client Modes

### Mode 1: HTTP MCP Client (direct)

For programmatic use with `fetch`:

```json
{
  "mcpServers": {
    "pages-mcp": {
      "url": "https://mysite.com:3000/mcp",
      "headers": { "Authorization": "Bearer your-api-token" }
    }
  }
}
```

### Mode 2: Stdio MCP Server (for AI assistants)

For Cursor, Claude Desktop, etc. — runs locally, proxies to remote:

```json
{
  "mcpServers": {
    "pages-mcp": {
      "command": "npx",
      "args": [
        "github:ptbsare/pages-mcp-server",
        "client",
        "--url", "https://mysite.com:3000",
        "--auth-token", "your-api-token"
      ]
    }
  }
}
```

### Mode 3: Interactive CLI

```bash
npx github:ptbsare/pages-mcp-server client --url https://mysite.com:3000 --interactive
```

## Security

### Rate Limiting (App Layer)

| Limiter | Threshold | Scope |
|---------|-----------|-------|
| `deployLimiter` | 20 req / 15 min / IP | `/api/deploy/*` |
| `adminLimiter` | 100 req / 15 min / IP | `/api/admin/*` |
| `otpLimiter` | 10 req / 15 min / IP | `/api/admin/otp/verify` |

> **Note:** `/s/` and `/f/` public endpoints have **no rate limiting** by design.

### CORS

Only same-origin requests allowed. No cross-origin API access.

### Path Validation (Client-Side)

Deploy paths validated before upload:
- **Extension**: only `.html` / `.htm` for `deploy_html`
- **Content**: must contain `<html>` tag for `deploy_html`
- **Path whitelist**: `DEPLOY_ALLOW_PATHS`, `DEPLOY_BLOCK_PATHS`, `DEPLOY_BLOCK_ROOT_DIRS`
- **Bypass**: `DEPLOY_ALLOW_ALL=1` disables all checks

### Admin 2FA

Optional TOTP-based two-factor authentication (Google Authenticator, Authy, etc.).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Internal server port |
| `OUT_PORT` | Same as `PORT` | External port for public URLs. Set when using Docker port mapping (e.g. `38300`). Standard ports (80/443) auto-omitted from URLs. |
| `DOMAIN` | `http://localhost:3000` | Base domain without port |
| `ADMIN_USERNAME` | `admin` | Admin dashboard username |
| `ADMIN_PASSWORD` | `admin123` | Admin dashboard password |
| `AUTH_TOKEN` | — | Initial API token(s), comma-separated. Seeded on first startup only. |
| `DB_PATH` | `~/.pages-mcp/pages.db` | SQLite database path |
| `STORAGE_PATH` | `~/.pages-mcp/storage` | File storage path |
| `SHARE_EXPIRE_DAYS` | `0` (disabled) | Auto-delete shares older than N days |

> **Note:** `AUTH_TOKEN` is only for initial seeding. Manage tokens via the admin dashboard after setup.

## Docker

### Images

| Tag | When |
|-----|------|
| `beta` | Every push to `main` |
| `latest` | On version tag push (e.g. `v1.2.3`) |
| `v{version}` | On tag push |
| `v{major}.{minor}` | On tag push |

### Port Mapping

| Scenario | PORT | OUT_PORT | Public URL |
|----------|------|----------|------------|
| Direct (no Docker) | 3000 | 3000 | `http://domain:3000` |
| Docker (same port) | 3000 | 3000 | `http://domain:3000` |
| Docker (mapped) | 3000 | 38300 | `http://domain:38300` |
| Standard HTTPS | 443 | 443 | `https://domain` (port omitted) |

### Volumes

All persistent data lives under `/data` inside the container:

| Path | Description | Required |
|------|-------------|----------|
| `/data/db/pages.db` | SQLite database | **Yes** |
| `/data/storage/` | Deployed files | **Yes** |

### Docker Compose

```yaml
version: "3.8"
services:
  pages-mcp:
    image: ghcr.io/ptbsare/pages-mcp-server/pages-mcp-server:latest
    ports: ["3000:3000"]
    environment:
      - PORT=3000
      - DOMAIN=http://localhost:3000
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=changeme
      - DB_PATH=/data/db/pages.db
      - STORAGE_PATH=/data/storage
    volumes: [pages-data:/data]
    restart: unless-stopped

volumes:
  pages-data:
    driver: local
```

## Nginx Reverse Proxy

Example config included in repo (`nginx.conf`). Key locations:

```nginx
upstream pages_mcp {
    server 127.0.0.1:38300;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name your.domain.com;

    # Strip server CSP, use nginx's
    proxy_hide_header Content-Security-Policy;

    location / { proxy_pass http://pages_mcp; }
    location /api/ { proxy_pass http://pages_mcp; }
    location /api/deploy { proxy_pass http://pages_mcp; client_max_body_size 1000m; }
    location /mcp { proxy_pass http://pages_mcp; }
    location /s/ { proxy_pass http://pages_mcp; }
    location /f/ { proxy_pass http://pages_mcp; client_max_body_size 1000m; }
    location /health { proxy_pass http://pages_mcp; access_log off; }
}
```

**Notes:**
- `proxy_hide_header Content-Security-Policy` — required for CSP per-page in app layer
- `client_max_body_size 1000m` — required on `/api/deploy` and `/f/` for large uploads

## License

[GPL v3](LICENSE)
