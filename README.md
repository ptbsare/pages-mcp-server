# Pages MCP Server

Self-hosted MCP server for deploying and managing static websites. Deploy HTML pages or entire folders via MCP tools or REST API, and get shareable public URLs like `https://domain.com/s/hdhdjsjhsguh`.

## Features

- **Deploy HTML strings** — send raw HTML, get a public URL
- **Deploy folders** — zip a local site folder, deploy all files (CSS, JS, images…)
- **Public page serving** — all deployed pages accessible at `/s/:shareId`, no auth required
- **MCP protocol** — 4 tools: `deploy_html`, `deploy_folder`, `list_pages`, `delete_page`
- **Multi-token auth** — create/revoke API tokens from the admin dashboard
- **Admin dashboard** — web UI for managing pages and tokens
- **Docker support** — multi-arch images on GHCR
- **npx runnable** — no install needed, run directly from GitHub

## Quick Start

### Via npx (recommended)

```bash
# Start server
npx github:ptbsare/pages-mcp-server server \
  --port 3000 \
  --domain https://mysite.com \
  --admin-user admin \
  --admin-pass secret \
  --auth-token my-secret-token

# Start stdio MCP client (for AI assistants like Cursor, Claude Desktop)
npx github:ptbsare/pages-mcp-server client \
  --url https://mysite.com \
  --auth-token my-secret-token

# Interactive CLI mode
npx github:ptbsare/pages-mcp-server client \
  --url https://mysite.com \
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
  -e AUTH_TOKEN=my-secret-token \
  -v pages-data:/data \
  ghcr.io/ptbsare/pages-mcp-server/pages-mcp-server:latest
```

Or with `docker-compose`:

```yaml
version: "3.8"
services:
  pages-mcp:
    image: ghcr.io/ptbsare/pages-mcp-server/pages-mcp-server:latest
    ports:
      - "3000:3000"
    environment:
      - DOMAIN=https://mysite.com
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=secret
      - AUTH_TOKEN=my-secret-token
    volumes:
      - pages-data:/data
    restart: unless-stopped
volumes:
  pages-data:
```

### Via Source

```bash
git clone https://github.com/ptbsare/pages-mcp-server
cd pages-mcp-server
npm install && npm run build
node dist/server/index.js
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      Server (Express)                     │
│                                                          │
│  /mcp              → MCP JSON-RPC (Bearer token auth)    │
│  /api/deploy/html  → Deploy HTML string                  │
│  /api/deploy/folder→ Deploy zip archive (base64)         │
│  /api/admin/pages  → CRUD pages (Basic auth)             │
│  /api/admin/tokens → CRUD API tokens (Basic auth)        │
│  /admin            → Admin Dashboard (HTML UI)           │
│  /s/:shareId       → Public static page (no auth)        │
│  /health           → Health check                        │
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

Two auth layers:

| Layer | Method | Used For |
|-------|--------|----------|
| **Admin** | HTTP Basic (`username:password`) | Admin dashboard, token management, page CRUD |
| **API/MCP** | Bearer token (`Authorization: Bearer <token>`) | MCP endpoint, deploy API |

API tokens can be managed at `/admin` dashboard or via `/api/admin/tokens` REST API.

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
        "--url", "https://mysite.com",
        "--auth-token", "your-api-token"
      ]
    }
  }
}
```

### Remote HTTP mode (direct)

```json
{
  "mcpServers": {
    "pages-mcp": {
      "url": "https://mysite.com/mcp",
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
| `PORT` | 3000 | Server port |
| `DOMAIN` | http://localhost:3000 | Base domain for share URLs |
| `ADMIN_USERNAME` | admin | Admin dashboard username |
| `ADMIN_PASSWORD` | admin123 | Admin dashboard password |
| `AUTH_TOKEN` | *(none)* | Initial API token(s), comma-separated. Seeded into DB on startup. |
| `DB_PATH` | ~/.pages-mcp/pages.db | SQLite database path |
| `STORAGE_PATH` | ~/.pages-mcp/storage | File storage path |

> **Note:** `AUTH_TOKEN` is only used for initial seeding. After that, manage tokens via the admin dashboard at `/admin`. You can create multiple tokens, and revoke them anytime.

## Docker Images

Images are published to GHCR on every push:

| Tag | When |
|-----|------|
| `beta` | Every push to `main` |
| `v{version}` | On tag push (e.g. `v1.2.3`) |
| `v{major}.{minor}` | On tag push (e.g. `v1.2`) |
| `latest` | On tag push |

```bash
docker pull ghcr.io/ptbsare/pages-mcp-server/pages-mcp-server:latest
```

## License

[GPL v3](LICENSE)
