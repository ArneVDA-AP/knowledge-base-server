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

# Consolidate a work session into durable memories (continuous learning; file or stdin)
kb consolidate session-notes.md --dry-run
cat transcript.txt | kb consolidate --project=kaiba

# Export / import the shared brain as NDJSON (provenance-preserving, dedupes on import)
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
- `bin/kb.js` — CLI dispatcher; loads `.env` from repo root, routes to command modules
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
- FTS5 virtual table `documents_fts` with BM25 ranking; title weight 10×, tags 5×, content 1×
- Search strategy: AND-first for precision, OR fallback for recall
- `vault_files` table tracks content hashes for incremental vault re-indexing
- Embeddings stored as Float32Array binary blobs (3× smaller than JSON)
- WAL mode with 5-minute periodic checkpoint

### Key modules
| Module | Responsibility |
|--------|---------------|
| `src/ingest.js` | File → DB; duplicate detection by filename (`source` field) |
| `src/vault/indexer.js` | Obsidian vault incremental indexer (hash-based) |
| `src/embeddings/embed.js` | Local HuggingFace `Xenova/all-MiniLM-L6-v2` embeddings |
| `src/embeddings/search.js` | Hybrid FTS5 + cosine similarity search |
| `src/classify/` | AI auto-classification of vault notes (type, tags, summary) |
| `src/capture/` | Structured capture: YouTube, web, terminal sessions, bug fixes, X bookmarks |
| `src/promotion/` | Promotes raw captures → structured knowledge artifacts |
| `src/synthesis/` | Cross-source synthesis / weekly review |
| `src/safety/review.js` | Multi-model consensus check before destructive actions |
| `src/paths.js` | Centralized path constants — always import paths from here |

### Two-way memory bridge (Claude ⇄ User)
Kaiba is a **bidirectional shared memory** between the user and Claude, not a one-way user tool.
Full design + the adversarial validation it rests on: `docs/memory-bridge/` (`01-theory-validation.md`,
`02-claude-perspective.md`, `03-shared-design.md`).
- **Memories are documents** — bridge memories live in the `documents` table (reusing FTS5/embeddings),
  distinguished by `created_by IN ('user','agent')`. Added columns: `created_by`, `author_detail`,
  `confidence` (verified/asserted/inferred/unverified), `reasoning`, `verified_at`, `importance`,
  `access_count`, `last_accessed_at`, `outcome_score`, `superseded_by`, `supersession_reason`,
  `deps_hash`, `review_status`, `project`. Migration uses **constant defaults only** (SQLite forbids
  non-constant defaults on `ADD COLUMN`); `insertDocument` coalesces in JS.
- **MCP tools** (`src/tools.js`): `kb_remember`, `kb_recall`, `kb_memory_outcome`, `kb_supersede`,
  `kb_memory_review` (admin), `kb_consolidate` (admin), `kb_session_brief` (CORE+DUE spaced re-surfacing),
  `kb_memory_conflicts` (read-only closest-neighbor for human consistency review),
  `kb_workspace` (transparent traced recall — logs each internal agent's vote to the `workspace` blackboard).
  **REST**: agent side `/api/v1/memory/*` (`routes/v1.js`, `created_by=agent`), user side `/api/memory/*`
  (`routes/api.js`, cookie auth, `created_by=user`).
- **Brain-inspired architecture** (`docs/memory-bridge/05-brain-research.md`; "brain-inspired, not brain-proven"):
  `memory_system` {working,episodic,semantic,procedural} with per-system salience weights (semantic = legacy
  defaults; NULL reads as semantic); two-strength model (`storage_strength` stretches the half-life; FSRS
  strengthen-on-recall); reward-prediction-error outcomes (`predicted_outcome`, precision-weighted downgrade);
  CLS consolidation (`consolidateEpisodics` / `kb consolidate --episodics`) — generalises stored episodic
  memories into semantic ones, linking `derived_from` and demoting sources via `consolidated_into`
  (`markConsolidated`); unit-tested with an injectable extractor, real-LLM run uses the same `runClaude` as the
  summarizer (verify on an authenticated machine); transparent `workspace` blackboard;
  bounded non-determinism (`recallMemories` `temperature`/`seed`, Gumbel-top-k, **`T=0` = exact legacy top-k**,
  env `KB_RECALL_TEMPERATURE`).
- **Recall is semantic** (`recallMemories`, async): cosine over per-memory embeddings
  (`Xenova/all-MiniLM-L6-v2`) with FTS rank-position fallback; memories embed on write
  (best-effort) + `backfillMemoryEmbeddings()`. **Continuous learning**: `src/consolidate.js`
  (`kb consolidate` / `kb_consolidate`) extracts durable memories from a session, dedupes via
  `findSimilarMemory`, writes them agent/pending. Auto-trigger = opt-in Claude Code Stop hook.
- **Retention = salience-and-supersession** (`db.js`): `salienceOf` ranks at recall
  (relevance × recency × importance × confidence × outcome); recency is a live Ebbinghaus decay (72h
  half-life) — nothing is stored as a decaying number. Recall bumps `access_count` ("pays rent").
  Supersession **demotes, never deletes** (superseded leaves default `kb_recall` but stays queryable;
  raw `kb_search`/`kb_read` stay exhaustive). Burned outcomes lower confidence + flag, never silent-delete.
- **Contract**: agent writes enter `review_status='pending'` at `'inferred'` confidence (correctness gate);
  the user disposes via `kb_memory_review`/dashboard. **Provenance is set at the call site, not inferred by
  transport** (the shared tool handler can't see transport). Coined handover terms (constraint-store
  versioning / reasoning-hash / decay-by-outcome) were validated as UNVERIFIED and **adapted + renamed**,
  not adopted.

### Auth model
- **Dashboard**: bcrypt password stored in `config.json`; 24h session tokens in SQLite `sessions` table; HttpOnly cookie `kb_session`
- **External API**: Three named API keys (`KB_API_KEY_CLAUDE`, `KB_API_KEY_OPENAI`, `KB_API_KEY_GEMINI`) or OAuth 2.1 Bearer via `better-auth`
- **ADMIN_ONLY_TOOLS**: `kb_classify`, `kb_promote`, `kb_synthesize`, `kb_safety_check`, `kb_capture_youtube`, `kb_delete`, `kb_memory_review`, `kb_consolidate` — gated in the MCP HTTP handler

### Environment variables (`.env` in repo root)
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
| `CLASSIFY_MODEL` | Claude model for AI classification (default: claude-haiku-4-5-20251001) |
| `KB_CORS_ORIGINS` | Comma-separated extra CORS origins |
| `KB_RECALL_TEMPERATURE` | Recall stochasticity (default `0` = deterministic top-k; >0 samples by salience) |
| `KB_RECALL_DIVERSITY` | MMR diversity λ for recall (default `0` = pure salience; 0<λ<1 = complementary results) |
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
