# Pages MCP Server

A self-hosted MCP server for deploying and managing static websites. Deploy HTML pages or entire folders and get shareable public URLs.

## Quick Start

### Via npx

```bash
# Start as server
npx github:<owner>/pages-mcp-server server --port 3000 --domain https://mysite.com

# Start as stdio MCP client (for AI assistants)
npx github:<owner>/pages-mcp-server client --url https://mysite.com --auth-token my-secret

# Interactive client mode
npx github:<owner>/pages-mcp-server client --url https://mysite.com --interactive
```

### Via Docker

```bash
docker compose up -d
```

### Via Source

```bash
git clone https://github.com/<owner>/pages-mcp-server
cd pages-mcp-server
npm install && npm run build

# Start server
node dist/server/index.js

# Start client (stdio mode)
node dist/client/src/cli.js client --url http://localhost:3000
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      Server                               │
│                                                          │
│  /mcp              → MCP JSON-RPC endpoint (Bearer auth) │
│  /api/deploy/html  → Deploy HTML string                  │
│  /api/deploy/folder→ Deploy zip archive                  │
│  /api/admin/*      → Admin CRUD API (Basic auth)         │
│  /admin            → Admin Dashboard (HTML UI)           │
│  /s/:shareId       → Public static page serving          │
│  /health           → Health check                        │
│                                                          │
│  SQLite DB + File Storage                                │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                      Client                               │
│                                                          │
│  Mode 1: HTTP MCP Client                                 │
│    → Connects directly to /mcp endpoint                  │
│                                                          │
│  Mode 2: Stdio MCP Server                                │
│    → Runs locally, proxies to remote /mcp                │
│    → For AI assistants (Cursor, Claude Desktop, etc.)    │
│                                                          │
│  Mode 3: Interactive CLI                                 │
│    → Manual deploy/list/delete commands                  │
└──────────────────────────────────────────────────────────┘
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `deploy_html` | Deploy an HTML string as a public page |
| `deploy_folder` | Deploy a local folder (must contain index.html) |
| `list_pages` | List all deployed pages |
| `delete_page` | Delete a page by ID |

## API Endpoints

### Deploy HTML
```bash
curl -X POST https://mysite.com/api/deploy/html \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"value": "<html><body><h1>Hello</h1></body></html>", "name": "My Page"}'
```

### Deploy Folder
```bash
# Zip the folder first, then base64 encode
base64 -w0 site.zip > site.b64
curl -X POST https://mysite.com/api/deploy/folder \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{\"zipBase64\": \"$(cat site.b64)\", \"name\": \"My Site\"}"
```

### MCP Client Config (for Cursor / Claude Desktop)

```json
{
  "mcpServers": {
    "pages-mcp": {
      "command": "npx",
      "args": [
        "pages-mcp-server",
        "client",
        "--url", "https://mysite.com",
        "--auth-token", "my-secret-token"
      ]
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `DOMAIN` | http://localhost:3000 | Base domain for share URLs |
| `ADMIN_USERNAME` | admin | Admin panel username |
| `ADMIN_PASSWORD` | admin123 | Admin panel password |
| `AUTH_TOKEN` | my-secret-token | Bearer token for API auth |
| `DB_PATH` | ~/.pages-mcp/pages.db | SQLite database path |
| `STORAGE_PATH` | ~/.pages-mcp/storage | File storage path |
