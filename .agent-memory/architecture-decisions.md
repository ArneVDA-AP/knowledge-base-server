---
name: architecture-decisions
description: Key architectural decisions and their rationale for knowledge-base-server
type: project
---

## Memory is a first-class entity + the bridge is the session spine (rebuild 2026-06-14)
The memory layer was rebuilt from first principles (`docs/memory-bridge/07`). Three decisions:
1. **Memory is its own `memories` table** (ops in `src/memory/store.js`), not ~20 nullable columns bolted onto
   `documents`. One taxonomy: `kind` {episodic, semantic, procedural}. Ingested documents are a *source* that
   can feed memories, not the memory store. `db.js` defines the schema but owns only the documents domain.
2. **The session is bracketed by memory** (`src/memory/spine.js`): `kb spine install` wires a SessionStart hook
   that auto-loads `kb brief` and a Stop hook that auto-consolidates the transcript. Memory is ambient (loaded
   and saved by the harness), not an opt-in tool call. This is what "the bridge is the spine" means.
3. **Restraint over capability:** the speculative brain-inspired mechanisms (FSRS strength, PE-TD, MMR diversity,
   temperature sampling, replay, the `workspace` blackboard, deps-hash staleness, conflict surfacing) were
   **deleted** from the core — mechanism had front-run the evidence. They stay in git history on `master` and
   return only when real recall data shows they pay rent. Lean tool surface: 24 tools (was 26).
Provenance is decided at the call site (an MCP/REST caller cannot forge `user` or self-declare `verified`).
One salience formula, computed live at recall — nothing decaying is stored.

## Single tools.js for MCP tools (stdio + HTTP)
Both `src/mcp.js` (stdio transport) and `src/mcp-http.js` (StreamableHTTP) import `getToolDefinitions()` from `src/tools.js`. Adding a tool once makes it available on both transports automatically.

## Two separate auth systems
- **Dashboard** (`src/auth.js`): bcrypt + sessions table in SQLite + HttpOnly cookie. Simple, no external deps, works with the SPA.
- **External access** (`src/auth-oauth.js` + `src/middleware/api-key.js`): API keys (three per-agent keys) + OAuth 2.1 via `better-auth`. Needed for ChatGPT Actions, remote Codex, and Gemini access.
- Rationale: dashboard users are humans using a browser; external callers are scripts/agents that need API keys or OAuth.

## FTS5 AND-first with OR fallback
`searchDocuments()` tries an AND query first for precision, falls back to OR if no results. Title matches are boosted 10×, tags 5×. Reason: "docker networking" should find documents about both, not everything mentioning either word.

## Embeddings as binary blobs in SQLite
`Float32Array` stored as raw binary blobs rather than JSON arrays — 3× smaller. The embeddings table lives in the same `kb.db` as documents, avoiding a separate vector store dependency. Trade-off: no ANN index, so semantic search does a full scan (acceptable at <10k documents).

## Hybrid search (FTS5 + cosine similarity)
`kb_search_smart` runs both FTS5 and semantic search, then merges results. Keyword search handles exact matches; semantic handles conceptual queries ("how to fix auth") that may not match keywords.

## Hash-based vault incremental indexing
`vault_files` table stores SHA-256 (first 16 hex chars) of each file's content. On re-index, only changed files are re-processed. This is separate from the `documents` deduplication (which uses filename).

## WAL mode with periodic checkpoint
WAL mode prevents readers from blocking writers. 5-minute periodic `PRAGMA wal_checkpoint(TRUNCATE)` keeps WAL file from growing unbounded. `wal_autocheckpoint = 100` pages provides an additional safety net.

## dotenv loaded at bin entry point only
`bin/kb.js` loads `.env` with an explicit path (`resolve(__dirname, '..', '.env')`). Source modules under `src/` do not call `dotenv` themselves — they read from `process.env` directly. This ensures `.env` is loaded regardless of the CWD when `kb` is called.

## Data directory outside repo (`~/.knowledge-base/`)
All runtime state (DB, file copies, config, PID) lives in the user's home directory, not the repo. This allows multiple repo clones, git operations, and `npm link` without touching live data.

## SessionStart hook voor MEMORY.md auto-injectie
`~/.claude/settings.json` bevat een `SessionStart` hook die `.agent-memory/MEMORY.md` leest en als `additionalContext` injecteert via `hookSpecificOutput`. Dit zorgt dat de project status altijd in context is zonder dat de LLM het zelf moet initiëren.
- `UserPromptSubmit` werd afgewezen: injecteert op elk bericht → redundante context in lang gesprek
- `SessionStart` is eenmalig per sessie (en waarschijnlijk na `/clear`)
- Fallback: CLAUDE.md bevat Session Start Protocol als de hook niet triggert

## Explicit gitignore-aware file collection
`collectFiles()` in `src/ingest.js` reads the root `.gitignore` and applies pattern matching before collecting files. Also hard-codes `IGNORE_DIRS` for common build/env directories. Prevents accidentally ingesting `node_modules`, dist artifacts, etc.

## Two-way memory bridge: memories ARE documents, not a separate store (2026-06-14)
Rather than a new table, bridge memories live in the existing `documents` table with added
provenance/trust/retention columns — so they reuse FTS5, embeddings, and all read paths for free.
A "memory" is just a document with `created_by IN ('user','agent')` (written via `kb_remember`);
legacy/ingested docs default to `created_by='system'` and stay out of `kb_recall`. The single
write chokepoint `insertDocument` carries the new fields, so every ingest path inherits them.
Trade-off accepted: memory-semantic columns sit on all documents (nullable/defaulted) for the
large reuse win. Full rationale: `docs/memory-bridge/03-shared-design.md`.

## Salience computed live, never stored as a decaying number (2026-06-14)
Decay is a function evaluated at recall (`salienceOf` in `db.js`), not a value written to disk:
`relevance × (recency + importance) × confidenceWeight × outcomeMultiplier`, recency = Ebbinghaus
`exp(-ln2·Δh/72h)`. Recall bumps `access_count`/`last_accessed_at` (strengthen-on-recall), so
**time decays and use arrests decay** — the validated causal model, NOT "new items evict old."
This is the honest rename of the handover's coined "constraint-store versioning" (which collided
with the monotonic CCP "constraint store"). Every part traces to a primary source — see
`docs/memory-bridge/01-theory-validation.md`.

## Provenance decided at the call site, not inferred by transport (2026-06-14)
The shared `tools.js` handler only receives parsed args (no `req`/transport), so it cannot tell
stdio vs HTTP vs auth. Therefore `created_by` is set where request context exists: tool/REST `v1.js`
(api-key/OAuth) → `'agent'`; dashboard `api.js` (cookie auth) → `'user'`. The db layer takes
`created_by` as an explicit argument. Agent writes enter `review_status='pending'` at `'inferred'`
confidence (correctness gate); the user disposes via `kb_memory_review` (propose/dispose). This was
the one design-breaking issue caught by the pre-build review before any code was written.
