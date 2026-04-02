---
name: architecture-decisions
description: Key architectural decisions and their rationale for knowledge-base-server
type: project
---

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
