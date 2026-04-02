# MEMORY.md — knowledge-base-server (Kaiba)

> **Projectnaam: Kaiba** — de officiële bijnaam voor de knowledge-base-server. Gekozen door de originele architect (Opus). KB = Kaiba. Gebruik altijd "Kaiba" als je naar dit project verwijst.

## Status
**Claude Web UI MCP koppeling is LIVE.** (2026-03-21)

Tailscale Funnel: `https://laptop.tail0411df.ts.net` → `:3838`
MCP endpoint: `https://laptop.tail0411df.ts.net/mcp`
Auth: OAuth 2.1 via Better Auth (user: `arnevandenabbeele@gmail.com`)
Alternatief: `X-API-Key` header met `KB_API_KEY_CLAUDE`

**Open bug (laag prioriteit):** `src/cli/setup.js` appendt `KB_API_KEY_*` elke run zonder duplicate check.

## Active Features
- MCP stdio server (`kb mcp`) — full 16-tool suite via `src/tools.js`
- MCP HTTP server — zelfde tools over StreamableHTTP at `POST /mcp`
- REST API v1 at `/api/v1/` — externe toegang met API key of OAuth Bearer
- Web dashboard at `:3838` — cookie-auth SPA
- Obsidian vault incremental indexer — hash-based, markdown only
- Semantic search — lokaal HuggingFace `Xenova/all-MiniLM-L6-v2`
- AI classification pipeline (`kb classify`)
- `kb_delete` — document verwijderen via MCP (admin-only), CLI, REST
- `kb token-compare` — raw doc tokens vs KB summary tokens vergelijken (--all, --top=N)
- `formatYamlTags` utility — Obsidian-compatibele block-list tag format (geport van upstream)
- Test suite — `npm test` via `node --test tests/*.test.js`

## Critical Conventions
- **Pure ESM**: `"type": "module"` — imports met `.js` extensie, geen CommonJS
- **No build step**: draait direct met Node ≥18, `kb` CLI via `npm link`
- **Paths**: altijd importeren van `src/paths.js`
- **Tools**: `src/tools.js` is single source voor alle MCP tool definities
- **DB singleton**: `getDb()` in `src/db.js`
- **Middleware order in server.js**: Better Auth VOOR `express.json()`, SPA fallback LAATSTE
- **Duplicate detection**: content-hash (SHA-256, 32 chars) in `documents.content_hash`; `insertDocument` doet `INSERT OR IGNORE` en retourneert bestaand doc bij conflict
- **Test DB injectie**: `_setTestDb(db)` + `_resetDb()` geëxporteerd uit `src/db.js` — gebruik altijd `after(() => _resetDb())` na `_setTestDb` om singleton te resetten

## Known Pitfalls
- `kb setup` appendt `KB_API_KEY_*` elke run zonder duplicate check — `.env` kan meerdere entries krijgen; dotenv pakt de LAATSTE
- Embedding model lazy load: eerste `kb_search_smart` duurt 10-30s
- `vault/indexer.js` heeft globale mutex — concurrent reindex = silent no-op
- `src/auth.js` importeren raakt DB direct bij module-load
- Better Auth handler MOET vóór `express.json()` staan in server.js

## Key File Map
```
bin/kb.js              CLI entry point + dotenv loader (expliciete __dirname path)
src/server.js          Express server (dashboard + REST + MCP HTTP)
src/mcp.js             MCP stdio server
src/tools.js           Alle MCP tool definities (gedeeld)
src/db.js              SQLite singleton, schema, FTS5 search
src/ingest.js          File/directory ingest, gitignore-aware
src/paths.js           Path constants (heeft nog import 'dotenv/config' — redundant)
src/auth.js            Dashboard auth (bcrypt, sessions, cookie)
src/auth-oauth.js      OAuth 2.1 via better-auth
src/mcp-http.js        MCP over HTTP (StreamableHTTP)
src/routes/v1.js       Externe REST API + DELETE endpoint
src/middleware/api-key.js  API key auth (X-API-Key header)
src/cli/setup.js       Setup wizard (BUG: appendt API keys zonder duplicate check)
src/cli/delete-cli.js  CLI delete command (multi-ID support)
src/cli/token-compare.js  Token vergelijking raw docs vs summaries
src/utils/frontmatter.js   Obsidian-compatible YAML tag formatter
```
