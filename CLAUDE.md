# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the web dashboard + REST API (port 3838)
KB_PASSWORD=yourpass kb start

# Start MCP stdio server (used by AI tools)
kb mcp

# Register MCP with Claude Code (~/.claude.json)
kb register

# Ingest a file or directory
kb ingest ~/obsidian-vault

# Search from terminal
kb search "docker networking"

# Delete a document by ID
kb delete 42

# Delete multiple documents
kb delete 1 2 3 4 5 6

# Show stats and server status
kb status

# Auto-classify vault notes (--dry-run to preview)
kb classify --dry-run

# Add AI summaries to unsummarized docs (--limit=N to cap)
kb summarize --limit=10

# Install the memory spine: SessionStart auto-loads a brief, Stop auto-consolidates the transcript
kb spine install        # status | print (preview) | uninstall
kb brief                # print the session-start brief (--hook = SessionStart hook JSON)

# Consolidate a work session into durable memories (continuous learning; file or stdin)
kb consolidate session-notes.md --dry-run
cat transcript.txt | kb consolidate --project=kaiba

# One-time: lift legacy documents-based memories into the memories table (idempotent)
kb migrate-memories

# Export / import the shared brain as NDJSON (untrusted import re-enters review, dedupes on content)
kb memory-export brain.ndjson --project=kaiba
kb memory-import brain.ndjson

# Reindex Obsidian vault
kb vault reindex

# Interactive setup wizard
kb setup
# Agent-driven (no prompts):
kb setup --auto --password=yourpass --vault=~/obsidian-vault --agents=claude --deploy=systemd

# Capture X/Twitter bookmarks
kb capture-x ~/path/to/x_bookmarks.md

# Safety check before a destructive action
kb safety-check "drop the documents table"
```

No build step — the codebase runs directly from source (pure ESM). No test runner is configured.

## Architecture

### Data directory: `~/.knowledge-base/`
All runtime state lives outside the repo:
- `kb.db` — SQLite database (documents, FTS5 index, embeddings, vault_files, sessions)
- `files/` — Copies of ingested files with timestamp prefix
- `config.json` — Bcrypt password hash and settings
- `kb.pid` — PID file for `kb stop`

### Entry points
- `bin/kb.js` — CLI dispatcher; loads `.env` from `~/.knowledge-base/.env` (via `src/paths.js`), routes to command modules
- `src/server.js` — Express web server (dashboard + REST API + MCP HTTP)
- `src/mcp.js` — MCP stdio server for AI agent integration

### Request paths

**Dashboard (browser):** Cookie auth via `src/auth.js` → `src/routes/auth-routes.js` + `src/routes/api.js`

**External REST API:** `X-API-Key` header or OAuth Bearer → `src/middleware/api-key.js` + `src/auth-oauth.js` → `src/routes/v1.js`

**MCP stdio:** `kb mcp` → `src/mcp.js` → `src/tools.js` (no auth — local process)

**MCP HTTP:** `POST /mcp` → same `brainAuth` as REST → `src/mcp-http.js` → `src/tools.js`

`src/tools.js` is the single source of truth for all MCP tool definitions — shared by both stdio and HTTP transports.

### Database layer (`src/db.js`)
- Singleton `getDb()` — initializes lazily, runs schema migrations inline on first call
- Owns the **documents/vault/search** domain + defines the `memories` schema; memory *ops* live in
  `src/memory/store.js` (the old documents-bolted-on memory functions were cut in the rebuild — see `07`)
- FTS5 virtual table `documents_fts` with BM25 ranking; title weight 10×, tags 5×, content 1×
- Search strategy: AND-first for precision, OR fallback for recall
- `vault_files` table tracks content hashes for incremental vault re-indexing
- Embeddings stored as Float32Array binary blobs (3× smaller than JSON)
- WAL mode with 5-minute periodic checkpoint

### Key modules
| Module | Responsibility |
|--------|---------------|
| `src/ingest.js` | File → DB; duplicate detection by filename (`source` field) |
| `src/memory/store.js` | The memory domain: `memories` entity, salience, recall, brief, review, consolidation |
| `src/memory/spine.js` | Wires the SessionStart(brief)+Stop(consolidate) Claude Code hooks (the spine) |
| `src/vault/indexer.js` | Obsidian vault incremental indexer (hash-based) |
| `src/embeddings/embed.js` | Local HuggingFace `Xenova/all-MiniLM-L6-v2` embeddings |
| `src/embeddings/search.js` | Hybrid FTS5 + cosine similarity search |
| `src/classify/` | AI auto-classification of vault notes (type, tags, summary) |
| `src/capture/` | Structured capture: YouTube, web, terminal sessions, bug fixes, X bookmarks |
| `src/promotion/` | Promotes raw captures → structured knowledge artifacts |
| `src/synthesis/` | Cross-source synthesis / weekly review |
| `src/safety/review.js` | Multi-model consensus check before destructive actions |
| `src/paths.js` | Centralized path constants — always import paths from here |

### Two-way memory spine (Claude ⇄ User) — `src/memory/`
Kaiba is a **bidirectional shared memory** the session loads from and saves to, not a one-way user tool.
First-principles rebuild contract: `docs/memory-bridge/07-spine-rebuild.md` (history: `01`→`06`).
- **Memory is a first-class entity** — its own `memories` table (schema owned by `db.js` `initSchema`; ops by
  `src/memory/store.js`), NOT columns bolted onto `documents`. One taxonomy: `kind`
  {`episodic`,`semantic`,`procedural`} (`working` = ephemeral, never persisted). Columns: `kind`, `content`,
  `reasoning`, `created_by` (user/agent), `confidence` (verified/asserted/inferred/unverified), `importance`,
  `project`, `source` (JSON), `outcome`, `use_count`, `last_used_at`, `superseded_by`, `supersession_reason`,
  `review_status` (pending/accepted/rejected), `content_hash`, `embedding`, `created_at`, `updated_at`.
  `memories_fts` (external-content FTS5 over content+reasoning) — memories are **born indexed** (never UPDATE a
  pre-FTS row → avoids `SQLITE_CORRUPT_VTAB`).
- **The spine (`src/memory/spine.js`)** — `kb spine install` wires two Claude Code hooks into
  `~/.claude/settings.json` (idempotent merge, backs up to `.bak-kaiba`): **SessionStart** → inject `kb brief`
  as `additionalContext` (auto-LOAD); **Stop** → `kb consolidate --from-transcript` over the transcript JSONL
  (auto-SAVE). `extractTranscriptText` parses the Claude Code transcript. Loading/saving are ambient.
- **Core ops (`store.js`)**: `remember` (agent→pending/capped-below-verified, user→accepted; dedup by
  content_hash; best-effort embed), `recall` (salience-ranked, semantic w/ FTS fallback, strengthen-on-recall),
  `brief` = THE session load (CORE by importance + recently-used + pending count), `review` (accept/reject),
  `supersede` (demote-don't-delete), `recordOutcome` (burn lowers confidence one notch), `consolidate` (LLM
  extract → dedup → pending; `extractResultText` tolerates the `claude` CLI's stream-array envelope),
  `migrateFromDocuments`, `exportNDJSON`/`importNDJSON` (untrusted import → forced pending, confidence capped).
- **One salience formula** (computed live; nothing decaying is stored):
  `relevance × (0.4·recency + 0.6·importance) × confidenceWeight × outcomeMultiplier`; `recency =
  exp(-ln2·Δh/halfLife[kind])` (episodic 24h, semantic 720h, procedural 4320h).
- **MCP tools** (`src/tools.js`, lean set): `kb_remember`, `kb_recall`, `kb_memory_outcome`, `kb_supersede`,
  `kb_session_brief`, `kb_memory_review` (admin), `kb_consolidate` (admin). **REST**: agent side
  `/api/v1/memory/*` (`routes/v1.js`, `created_by=agent`), user side `/api/memory/*` (`routes/api.js`, cookie
  auth, `created_by=user`). **Provenance is set at the call site, never client-supplied** — an MCP/REST caller
  cannot forge `user` or self-declare `verified`. The review queue is provenance-agnostic (anything pending).
- **Cut in the rebuild** (deleted from the core, in git history on `master`): FSRS storage-strength, PE-TD
  predicted-outcome, MMR diversity, temperature/seed sampling, prioritized replay, the `workspace` blackboard
  (`kb_workspace`), deps-hash staleness, conflict surfacing (`kb_memory_conflicts`). Restraint is the point —
  mechanism front-ran the evidence; they return only when real recall data shows they pay rent.

### Auth model
- **Dashboard**: bcrypt password stored in `config.json`; 24h session tokens in SQLite `sessions` table; HttpOnly cookie `kb_session`
- **External API**: Three named API keys (`KB_API_KEY_CLAUDE`, `KB_API_KEY_OPENAI`, `KB_API_KEY_GEMINI`) or OAuth 2.1 Bearer via `better-auth`
- **ADMIN_ONLY_TOOLS**: `kb_classify`, `kb_promote`, `kb_synthesize`, `kb_safety_check`, `kb_capture_youtube`, `kb_delete`, `kb_memory_review`, `kb_consolidate` — gated in the MCP HTTP handler

### Environment variables (`.env` in `~/.knowledge-base/`)
| Variable | Purpose |
|----------|---------|
| `KB_PASSWORD` | Dashboard password (first-run auto-provision) |
| `KB_PORT` | HTTP port (default 3838) |
| `OBSIDIAN_VAULT_PATH` | Vault path for sync and classify commands |
| `KB_API_KEY_CLAUDE` | API key for Claude remote access |
| `KB_API_KEY_OPENAI` | API key for OpenAI/ChatGPT access |
| `KB_API_KEY_GEMINI` | API key for Gemini access |
| `BETTER_AUTH_SECRET` | OAuth token signing secret |
| `BETTER_AUTH_URL` | OAuth issuer URL (for remote deployment) |
| `CLASSIFY_MODEL` | Claude model for AI classification/consolidation (default: claude-haiku-4-5-20251001) |
| `KB_CORS_ORIGINS` | Comma-separated extra CORS origins |
| `CLAUDE_PATH` | Full path to `claude` CLI binary (Windows: set to `claude.cmd` path if spawn fails with ENOENT) |

### Important constraints
- **Pure ESM** (`"type": "module"` in package.json) — all imports must use `.js` extensions
- **No build step** — source runs directly via Node.js ≥18
- **Duplicate detection is by filename** — two different files with the same name will collide in ingestion
- The embedding model (`all-MiniLM-L6-v2`) loads lazily with a 60s timeout and a mutex to prevent concurrent loads
- `src/server.js` registers the Better Auth handler **before** `express.json()` — order matters
- The SPA fallback route (`app.get('*', ...)`) must remain the last route in `server.js`
- **Wildcard CORS** (`Access-Control-Allow-Origin: *`) is set as the first middleware in `server.js` so the Firefox extension (`moz-extension://`) can reach the REST API — keep it before all other routes
- **Windows spawn**: `src/utils/claude.js` uses `shell: process.platform === 'win32'` so Node.js can resolve `claude.cmd` npm globals on Windows without ENOENT

### Firefox extension companion
The browser extension lives at `../claude-sessions-ext/` (sibling directory, **not** inside this repo). It captures Claude.ai session metadata, syncs to Kaiba via the REST API, and generates AI summaries using the `session-status` profile.

Key extension → server API endpoints:
- `GET /api/v1/health` — connectivity check (no auth)
- `POST /api/v1/ingest` — first-time session sync
- `PUT /api/v1/documents/:id` — re-sync (invalidates summary)
- `POST /api/v1/documents/:id/summarize?profile=session-status` — AI summary via claude CLI
- `GET /api/v1/documents?type=session&source=claude-web-ui:%` — pull on sidebar open
- `GET /api/v1/search?q=…&type=session` — KB search from sidebar

Extension install: `about:debugging` → This Firefox → Load Temporary Add-on → select `manifest.json`.
