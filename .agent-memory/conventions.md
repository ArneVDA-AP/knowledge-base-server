---
name: conventions
description: Code conventions and patterns used in knowledge-base-server
type: project
---

## Module system
Pure ESM (`"type": "module"`). All imports must include `.js` extension. No CommonJS (`require`, `module.exports`).

## Path management
All runtime paths (DB, files, config, PID) are defined in `src/paths.js`. Import from there — never hardcode `~/.knowledge-base/` or `homedir()` calls in feature modules.

## Database access
`getDb()` in `src/db.js` returns the singleton connection. Call it inline — don't cache at module level, as the DB may not be ready at import time. Schema migrations are inline in `initSchema()`.

## Tool definitions
All MCP tools live in `src/tools.js` and are registered by both `src/mcp.js` (stdio) and `src/mcp-http.js` (HTTP). When adding a new tool, add it only in `tools.js`.

## Express middleware order (server.js)
1. Better Auth handler (`/api/auth/*`) — BEFORE `express.json()`
2. Well-known OAuth endpoints
3. `express.json()` + `express.static()`
4. Dashboard routes (cookie auth)
5. Authenticated external routes (`/api/v1/`, `/mcp`)
6. SPA fallback (`app.get('*', ...)`) — MUST be last

## Authentication layers
- **Dashboard**: `authMiddleware` from `src/auth.js` — checks `kb_session` HttpOnly cookie
- **External API / MCP HTTP**: `brainAuth` in `server.js` — accepts `X-API-Key` header first (fast path), then OAuth Bearer via better-auth
- **MCP stdio**: no auth — local process, trust implicit

## Error handling
- Route handlers: return `res.status(N).json({ error: msg })` — don't throw
- MCP tool handlers: return `{ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }` on failure
- Server-level: global `unhandledRejection` and `uncaughtException` handlers in `server.js` log but don't crash for rejections; exit with code 1 for uncaught exceptions (systemd restarts)

## Duplicate detection in ingest
`ingestDirectory()` deduplicates by `basename(filePath)` matched against the `source` column. Two files with the same name from different directories will collide. The vault indexer uses SHA-256 content hashing for proper incremental updates.

## Vault indexer conventions
- Only indexes `.md` files
- Skips: `.obsidian`, `.trash`, `.git`, `_assets`, `_system`, `node_modules`, `textgenerator`, `.sync-conflict*` files
- `indexVault()` has a global mutex — concurrent calls are silently ignored (returns zeros)

## Tags storage
Tags are stored as comma-separated strings in the `tags` column, not as arrays. Convert with `tags.split(',').map(t => t.trim())` when reading.

## Embedding storage
`Float32Array` → `Buffer.from(embedding.buffer)` for SQLite BLOB. Read back with `new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)`.
