# Pages MCP Server

Self-hosted MCP server for deploying and managing static websites. Deploy HTML pages or entire folders via MCP tools or REST API, and get shareable public URLs like `https://domain.com/s/hdhdjsjhsguh`.

## Features

- **Deploy HTML strings** — send raw HTML, get a public URL
- **Deploy folders** — zip a local site folder, deploy all files (CSS, JS, images…)
- **Public page serving** — all deployed pages accessible at `/s/:shareId`, no auth required
- **MCP protocol** — 4 tools: `deploy_html`, `deploy_folder`, `list_pages`, `delete_page`
- **Multi-token auth** — create/revoke API tokens from the admin dashboard
- **Admin dashboard** — web UI at `/` for managing pages, tokens, and 2FA settings
- **Two-factor authentication (2FA)** — optional TOTP-based 2FA for admin access (Google Authenticator compatible)
- **Docker support** — multi-arch images on GHCR, multi-stage build, non-root user
- **npx runnable** — no install needed, run directly from GitHub

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

After starting, access the **admin dashboard** at `https://mysite.com:3000/`. Log in with the admin username/password you set. From there you can:
- Create & manage API tokens
- View & delete deployed pages
- Enable 2FA (TOTP) for admin access

**Start stdio MCP client** (for AI assistants like Cursor, Claude Desktop):
```bash
npx github:ptbsare/pages-mcp-server client \
  --url https://mysite.com:3000 \
  --auth-token your-api-token
```

**Interactive CLI mode:**
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

#### Docker Port Mapping

When using Docker port mapping, the container's internal port and the external host port may differ. Use `OUT_PORT` to specify the external port that users will access:

```bash
# Container runs on 3000, exposed to host as 38300
docker run -d \
  --name pages-mcp \
  -p 38300:3000 \
  -e PORT=3000 \
  -e OUT_PORT=38300 \
  -e DOMAIN=https://mysite.com \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=secret \
  -v pages-data:/data \
  ghcr.io/ptbsare/pages-mcp-server/pages-mcp-server:latest
```

| Scenario | PORT | OUT_PORT | Public URL |
|----------|------|----------|-----------|
| Direct (no Docker) | 3000 | 3000 (default) | `http://domain:3000` |
| Docker (same port) | 3000 | 3000 | `http://domain:3000` |
| Docker (mapped) | 3000 | 38300 | `http://domain:38300` |
| Standard HTTPS | 443 | 443 | `https://domain` (port omitted) |
| Standard HTTP | 80 | 80 | `http://domain` (port omitted) |

> **Note:** Standard ports (80 for HTTP, 443 for HTTPS) are automatically omitted from generated URLs.

#### Docker Volume Mounts

All persistent data lives under `/data` inside the container. **You must mount this volume** or data will be lost on container restart:

| Container Path | Description | Mount Recommendation |
|----------------|-------------|---------------------|
| `/data/db/pages.db` | SQLite database (pages, tokens, OTP settings) | **Required** |
| `/data/storage/` | Deployed static files (all `/s/:shareId` content) | **Required** |

**Named volume (recommended):**
```bash
docker run -d \
  --name pages-mcp \
  -p 3000:3000 \
  -e DOMAIN=https://mysite.com \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=secret \
  -v pages-data:/data \
  ghcr.io/ptbsare/pages-mcp-server/pages-mcp-server:latest
```

**Bind mount (for custom paths):**
```bash
docker run -d \
  --name pages-mcp \
  -p 3000:3000 \
  -e DOMAIN=https://mysite.com \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=secret \
  -e DB_PATH=/data/db/pages.db \
  -e STORAGE_PATH=/data/storage \
  -v /opt/pages-mcp/data:/data \
  ghcr.io/ptbsare/pages-mcp-server/pages-mcp-server:latest
```

### Via Docker Compose

```yaml
version: "3.8"

services:
  pages-mcp:
    image: ghcr.io/ptbsare/pages-mcp-server/pages-mcp-server:latest
    container_name: pages-mcp
    ports:
      # "HOST_PORT:CONTAINER_PORT"
      - "3000:3000"
    environment:
      - PORT=3000
      # OUT_PORT: external port for public URLs. Defaults to PORT if not set.
      # For Docker port mapping, set to the HOST port. Standard ports (80/443) auto-omitted.
      # - OUT_PORT=3000
      - DOMAIN=http://localhost:3000
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=changeme
      - DB_PATH=/data/db/pages.db
      - STORAGE_PATH=/data/storage
    volumes:
      - pages-data:/data
    restart: unless-stopped

volumes:
  pages-data:
    driver: local
```

Save as `docker-compose.yml` and run:

```bash
docker compose up -d
docker compose logs -f
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
┌──────────────────────────────────────────────────────────┐
│                      Server (Express)                     │
│                                                          │
│  /                  → Admin Dashboard (Basic auth + 2FA) │
│  /mcp               → MCP JSON-RPC (Bearer token auth)   │
│  /api/deploy/html   → Deploy HTML string                 │
│  /api/deploy/folder → Deploy zip archive (base64)        │
│  /api/admin/pages   → CRUD pages (Basic auth + 2FA)      │
│  /api/admin/tokens  → CRUD API tokens (Basic auth + 2FA) │
│  /api/admin/otp/*   → OTP setup/verify/disable           │
│  /s/:shareId        → Public static page (no auth)       │
│  /health            → Health check                       │
│                                                          │
│  sql.js (SQLite) + File Storage                          │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                      Client                               │
│                                                          │
│  Mode 1: HTTP MCP Client (direct /mcp calls)             │
│  Mode 2: Stdio MCP Server (proxy to remote, for AI)      │
│  Mode 3: Interactive CLI (manual commands)               │
└──────────────────────────────────────────────────────────┘
```

## API Reference

### Authentication

| Layer | Method | Used For |
|-------|--------|----------|
| **Admin** | HTTP Basic (`username:password`) + optional TOTP 2FA | Admin dashboard, token management, page CRUD |
| **API/MCP** | Bearer token (`Authorization: Bearer <token>`) | MCP endpoint, deploy API |

API tokens can be managed at `/` dashboard or via `/api/admin/tokens` REST API.

### Admin 2FA (TOTP)

The admin panel supports optional two-factor authentication using TOTP (Google Authenticator, Authy, etc.).

**Setup flow:**
1. Go to admin dashboard → click "🔐 2FA" → click "Setup 2FA"
2. Scan the QR code with your authenticator app
3. Enter the 6-digit code to verify and enable 2FA
4. Once enabled, all admin requests require a valid TOTP code

**Disable:** Click "🔐 2FA" → "Disable 2FA" → enter current code to confirm

### REST Endpoints

#### Deploy HTML
```bash
curl -X POST https://mysite.com/api/deploy/html \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"value": "<html><body><h1>Hello</h1></body></html>", "name": "My Page"}'
```
Response:
```json
{
  "id": "abc123",
  "shareId": "hdhdjsjhsguh",
  "url": "https://mysite.com/s/hdhdjsjhsguh",
  "name": "My Page",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

#### Deploy Folder (zip)
```bash
base64 -w0 site.zip | xargs -I{} curl -X POST https://mysite.com/api/deploy/folder \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"zipBase64": "{}", "name": "My Site"}'
```

#### Token Management
```bash
# List tokens
curl -u admin:password https://mysite.com/api/admin/tokens

# Create token
curl -X POST -u admin:password https://mysite.com/api/admin/tokens \
  -H "Content-Type: application/json" \
  -d '{"name": "CI/CD Token"}'

# Delete token
curl -X DELETE -u admin:password https://mysite.com/api/admin/tokens/<id>
```

#### Page Management
```bash
# List pages
curl -u admin:password https://mysite.com/api/admin/pages

# Update page
curl -X PUT -u admin:password https://mysite.com/api/admin/pages/<id> \
  -H "Content-Type: application/json" \
  -d '{"name": "New Name", "description": "Updated"}'

# Delete page
curl -X DELETE -u admin:password https://mysite.com/api/admin/pages/<id>
```

### MCP Tools

| Tool | Description | Required |
|------|-------------|----------|
| `deploy_html` | Deploy an HTML string as a public page | `value` (string) |
| `deploy_folder` | Deploy a local folder (must contain index.html) | `path` (string) |
| `list_pages` | List all deployed pages | — |
| `delete_page` | Delete a page by ID | `id` (string) |

All tools accept optional `name` and `description` parameters.

## AI Assistant Configuration

### Cursor / Claude Desktop (stdio mode)

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

**Key points:**
- `--url` specifies the full remote server URL including port
- `--auth-token` is an API token created from the admin dashboard at `/`
- The stdio client runs locally and communicates with the remote server via HTTP

### Remote HTTP mode (direct)

```json
{
  "mcpServers": {
    "pages-mcp": {
      "url": "https://mysite.com:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-api-token"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Internal server port (what the server listens on) |
| `OUT_PORT` | Same as `PORT` | External port for public URLs. Set this when using Docker port mapping. Standard ports (80/443) are auto-omitted from URLs. |
| `DOMAIN` | http://localhost:3000 | Base domain without port (e.g. `https://mysite.com`) |
| `ADMIN_USERNAME` | admin | Admin dashboard username |
| `ADMIN_PASSWORD` | admin123 | Admin dashboard password |
| `AUTH_TOKEN` | *(none)* | Initial API token(s), comma-separated. Seeded into DB on first startup only. |
| `DB_PATH` | ~/.pages-mcp/pages.db | SQLite database path |
| `STORAGE_PATH` | ~/.pages-mcp/storage | File storage path |

> **Note:** `AUTH_TOKEN` is only used for initial seeding. After that, manage tokens via the admin dashboard at `/`. You can create multiple tokens, and revoke them anytime.

## Docker Images

Images are published to GHCR on every push:

| Tag | When |
|-----|------|
| `beta` | Every push to `main` |
| `v{version}` | On tag push (e.g. `v1.2.3`) |
| `v{major}.{minor}}` | On tag push (e.g. `v1.2`) |
| `latest` | On tag push |

```bash
docker pull ghcr.io/ptbsare/pages-mcp-server/pages-mcp-server:latest
```

### Docker Image Features

- **Multi-stage build** — small final image (~100MB), build tools not included
- **Non-root user** — container runs as `pages-mcp` user for security
- **Health check** — built-in health check via `/health` endpoint
- **Multi-arch** — supports `linux/amd64` and `linux/arm64`

## Systemd Service (Linux)

```bash
# Copy the service file
sudo cp pages-mcp-server.service /etc/systemd/system/

# Edit with your actual credentials
sudo systemctl edit pages-mcp-server

# Reload and start
sudo systemctl daemon-reload
sudo systemctl start pages-mcp-server
sudo systemctl enable pages-mcp-server

# Check status
sudo systemctl status pages-mcp-server
sudo journalctl -u pages-mcp-server -f
```

The service file uses `npx github:ptbsare/pages-mcp-server` to run. Data is stored in `/root/.pages-mcp/` by default.

### Security Hardening

The service file includes comments for additional hardening when running as non-root:

```ini
# Create dedicated user:
#   useradd --system --no-create-home --shell /usr/sbin/nologin pages-mcp

# Then in service file:
# User=pages-mcp
# Group=pages-mcp
# NoNewPrivileges=true
# ProtectSystem=strict
# ProtectHome=true
# PrivateTmp=true
# ReadWritePaths=/var/lib/pages-mcp
```

## License

[GPL v3](LICENSE)
