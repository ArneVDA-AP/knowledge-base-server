# Kaiba

**A shared brain for you and your AI agents.**

Kaiba is a self-hosted knowledge base *and* a two-way memory **spine** between you and Claude. It gives stateless
AI agents persistent, trustworthy memory: everything you ingest (notes, code, captures) is searchable through
MCP and REST, and — the part that makes it different — **you and the agent build one evolving memory together**,
with provenance, confidence, and recency, so a new session starts like a colleague who's already been on the
project for months rather than one starting from zero.

The memory isn't a store the agent *can* query — it's the spine the session loads from and saves to. With one
command (`kb spine install`), a small high-signal **brief auto-loads at the start of every session** and the
session **auto-consolidates into durable memories at the end**. Recall is cued; capture is ambient.

Runs on Node.js with SQLite. No external database, no cloud dependency, no API keys required for core search.

---

## Why

LLMs are stateless by design — every session restarts from nothing. The usual results:

- re-explaining your codebase, architecture, and preferences every time;
- agents confidently "improving" a past decision because they were never told *why* it was made;
- hard-won debugging insights lost the moment the session ends;
- multiple agents that can't share what any one of them learned.

The bottleneck isn't model intelligence — it's **context**. Kaiba is the external, durable context layer, and it
treats that layer as a genuine *bridge* between two parties (you and the agent), not a one-way file the agent reads.

---

## Two layers

```
                ┌──────────────────────────────────────────────┐
   you  ───────▶│  Dashboard (cookie auth)   ·   CLI (`kb …`)   │
                └───────────────┬──────────────────────────────┘
                                │
  Claude / agents ─ MCP (stdio + HTTP) ─ REST (/api/v1, X-API-Key / OAuth)
                                │
                ┌───────────────▼──────────────────────────────┐
                │                 Kaiba server (Express :3838)   │
                │   ┌────────────────────┐  ┌──────────────────┐ │
                │   │  Document KB        │  │  Memory spine    │ │
                │   │  FTS5 + embeddings  │  │  provenance ·    │ │
                │   │  capture/classify/  │  │  trust · recency │ │
                │   │  synthesise         │  │  · review queue  │ │
                │   └────────────────────┘  └──────────────────┘ │
                └───────────────┬──────────────────────────────┘
                                │
                     SQLite (~/.knowledge-base/kb.db) — FTS5 + Float32 embeddings
```

1. **The document knowledge base** — ingest notes/code/captures, auto-classify and summarise, full-text +
   semantic search, token-efficient briefings. The retrieval layer that makes your knowledge AI-ready.
2. **The two-way memory spine** — a shared store where you *and* the agent contribute durable memories, each
   tagged with who wrote it and how trustworthy it is, that the session loads from at the start and saves to at
   the end, gets sharper with use, and forgets what stops earning its place.

---

## The two-way memory spine

This is what sets Kaiba apart from a search index. Full design and the adversarially-validated research behind
every decision live in [`docs/memory-bridge/`](docs/memory-bridge/) (`01` validation → `06` review →
`07` first-principles rebuild).

**Memory is a first-class entity.** Memories live in their own `memories` table with one taxonomy — `episodic`
(what happened) · `semantic` (durable facts/decisions/preferences) · `procedural` (how-to/skills) — not a pile
of nullable columns bolted onto documents. Ingested documents are a *source* that can feed memories, not the
memory store itself.

**The session is bracketed by memory.** `kb spine install` wires two Claude Code hooks: **SessionStart** injects
a small brief (`kb brief`) as context — the load-bearing CORE (highest-importance accepted memories:
prohibitions, decisions, preferences) plus recently-used memories and a count of what's awaiting your review;
**Stop** runs `kb consolidate` over the transcript, distilling the session into durable memories. Loading and
saving are *ambient*, not opt-in tool calls. (`kb spine status` / `kb spine print` to preview without writing.)

**Provenance and trust on every memory.** Each memory carries `created_by` (`user` / `agent`), a `confidence`
level (`verified` / `asserted` / `inferred` / `unverified`), and the **reasoning** behind it (the *why*, so it
transfers to new situations instead of being misapplied). Provenance is decided by *where a write comes from* —
agents cannot forge `user` provenance or self-declare `verified`; those come only from you.

**Propose / dispose.** The agent *proposes* memories (they enter a review queue as `pending`); **you dispose** —
accept or reject from the dashboard **Memory** tab or via `kb_memory_review`. The human stays in the loop on
what's authoritative, which the research found to be load-bearing, not optional.

**Recall that compounds.** Retrieval ranks by one salience formula — relevance × (recency + importance) ×
confidence × outcome — using semantic similarity (local embeddings) with a full-text fallback. Recency is an
Ebbinghaus-style half-life that differs by kind (episodic decays fastest, procedural slowest), computed *live*
at recall so nothing decaying is ever stored. Recalling a memory **strengthens** it ("pays rent"); stale advice
is **demoted, not deleted** (supersession stays queryable so a corrected belief is remembered *as corrected*);
and you can record whether acting on a memory **helped or burned** you (`kb_memory_outcome`) — a burn lowers its
confidence one notch — to calibrate trust over time.

**Built with restraint.** An earlier iteration explored a larger brain-inspired mechanism set (`docs/memory-bridge/05`):
a two-strength FSRS model, reward-prediction-error outcomes, MMR-diverse and temperature-sampled recall, a
prioritised-replay pass, a transparent agent "blackboard", and dependency-hash staleness. The first-principles
rebuild (`07`) **deliberately cut all of it** — mechanism had front-run the evidence, and the goal is *automatic,
trusted, compounding use*, not raw capability. Those mechanisms remain in git history and can return when real
recall data shows they pay rent. What ships is the minimal core that earns its place.

---

## The document knowledge base

- **Capture from anywhere** — Markdown, code, PDFs, text (20+ types); Obsidian vault (incremental, hash-based
  sync); web articles; YouTube transcripts; X/Twitter bookmarks; terminal sessions and bug fixes.
- **Classify** — `kb classify` assigns type, tags, project, a retrieval-optimised summary, key topics, and a
  confidence score.
- **Promote & synthesise** — refine raw captures into structured knowledge (`kb_promote`) and connect themes
  across sources (`kb_synthesize`).
- **Search** — FTS5 with BM25 (title weighted 10×, tags 5×, content 1×), AND-first for precision with OR
  fallback for recall; hybrid keyword + semantic search (`kb_search_smart`); semantic search via local
  `Xenova/all-MiniLM-L6-v2` embeddings — **no API key needed**.
- **Token-efficient retrieval** — `kb_context` returns summaries/metadata only (90%+ token savings) so an agent
  decides what's worth reading *before* loading full content with `kb_read`.
- **Dedup & safety** — content-hash deduplication; `kb_safety_check` reviews destructive actions against history.

---

## Quickstart

**Prerequisites:** Node.js ≥ 20. That's it — no Docker, no external DB, no cloud.

```bash
git clone https://github.com/ArneVDA-AP/knowledge-base-server.git
cd knowledge-base-server
npm install
npm link        # makes the `kb` CLI available globally
```

**Interactive setup (recommended):**

```bash
kb setup        # detects your environment, configures, runs first ingest (~60s)
```

Agent-driven (no prompts):

```bash
kb setup --auto --password=yourpass --vault=~/obsidian-vault --agents=claude --deploy=systemd
```

**Or manually:**

```bash
KB_PASSWORD=yourpass kb start    # start dashboard + API on :3838
kb register                      # register the MCP server with Claude Code (~/.claude.json)
kb ingest ~/obsidian-vault       # ingest your knowledge
kb search "docker networking"    # search from the terminal
kb status                        # stats + server status
```

After `kb register`, Claude Code has every Kaiba tool available. Ask it to *"recall what we know about X"* or
*"search the knowledge base for recent fixes."*

To make the memory **ambient** — auto-loaded at the start of every session and auto-saved at the end — install
the spine:

```bash
kb spine install     # wires SessionStart (brief) + Stop (consolidate) hooks into ~/.claude/settings.json
kb spine status      # verify; `kb spine print` previews the change without writing
```

It merges into your existing hooks (backing the file up first) and is idempotent. Migrating from an older Kaiba?
`kb migrate-memories` lifts legacy documents-based memories into the new `memories` table (one-time, idempotent).

---

## MCP tools (24)

All tools are served over MCP (stdio for local, StreamableHTTP at `POST /mcp` for remote) and shared by both
transports from a single source (`src/tools.js`). Admin-only tools are available over stdio and the dashboard
but **excluded from the HTTP transport**.

**Knowledge base**

| Tool | Purpose |
|------|---------|
| `kb_search` | Full-text search (BM25, highlighted snippets) |
| `kb_search_smart` | Hybrid keyword + semantic search for conceptual queries |
| `kb_context` | Token-efficient briefing — summaries only; use before `kb_read` |
| `kb_read` | Read a full document by ID |
| `kb_list` | List documents, filter by type/tag |
| `kb_write` | Write a note to the Obsidian vault |
| `kb_ingest` | Ingest raw text directly |
| `kb_vault_status` | Vault indexing stats by type/project |
| `kb_capture_session` | Record a debugging/coding session (goal, what worked/failed, lessons) |
| `kb_capture_fix` | Record a bug fix (symptom, cause, resolution) |
| `kb_capture_web` | Capture a web article with metadata |
| `kb_capture_youtube` *(admin)* | Capture a YouTube transcript |
| `kb_classify` *(admin)* | Auto-classify unprocessed notes |
| `kb_promote` *(admin)* | Promote a raw source into structured knowledge |
| `kb_synthesize` *(admin)* | Cross-source synthesis of recent knowledge |
| `kb_safety_check` *(admin)* | Review a destructive action against history |
| `kb_delete` *(admin)* | Delete a document by ID |

**Memory spine** — (the spine also drives `kb_session_brief` + `kb_consolidate` automatically via hooks)

| Tool | Purpose |
|------|---------|
| `kb_remember` | Write a memory to the shared brain, with reasoning (enters review as a proposal) |
| `kb_recall` | Salience-ranked recall with trust signals (provenance, confidence, outcome) |
| `kb_memory_outcome` | Record that a memory helped or burned — calibrates trust |
| `kb_supersede` | Demote-don't-delete: mark a memory superseded by a newer one |
| `kb_session_brief` | Session-start load: CORE (load-bearing) + recently-used + pending count |
| `kb_memory_review` *(admin)* | Review queue: list / accept / reject pending memories |
| `kb_consolidate` *(admin)* | Consolidate a session into durable memories |

---

## CLI

```
kb setup                 Interactive setup wizard (--auto for agent mode)
kb start                 Start the dashboard + API server (default :3838)
kb stop                  Stop the running server
kb mcp                   Start the MCP stdio server (used by AI tools)
kb register              Register the MCP server with Claude Code
kb ingest <path>         Ingest a file or directory
kb search <query>        Search from the terminal
kb delete <id> [...]     Delete document(s) by ID
kb status                Stats and server status
kb classify              Auto-classify unprocessed vault notes (--dry-run)
kb summarize             Generate AI summaries for unsummarised notes (--limit=N)
kb spine <install|status|print|uninstall>   Wire the memory spine into Claude Code (auto-load + auto-save)
kb brief                 Print the session-start memory brief (--hook = SessionStart hook JSON; --project=)
kb consolidate [file]    Distil a session into durable memories (stdin/file; --dry-run, --project=)
kb migrate-memories      One-time: lift legacy documents-based memories into the memories table
kb memory-export [file]  Export memories as NDJSON (--project=)
kb memory-import <file>  Import memories from NDJSON (dedupes; re-enters review)
kb capture-x [path]      Ingest X/Twitter bookmarks from an export
kb token-compare         Compare raw-doc tokens vs KB-summary tokens
kb vault reindex         Reindex the Obsidian vault
kb safety-check <action> Review a planned action against history
```

---

## REST API & ChatGPT

External agents use the REST API at `/api/v1/` with an `X-API-Key` header or OAuth 2.1 Bearer token. The full
spec is in [`openapi.json`](openapi.json) (import it into a ChatGPT Custom GPT to give it KB access).

Knowledge: `GET /search`, `GET /search/smart`, `GET /context`, `GET /documents[/:id]`, `POST /ingest`,
`POST /capture/{session,fix,web}`.

Memory spine (agent side, `created_by=agent`): `POST /memory`, `GET /memory/recall`, `GET /memory/brief`,
`POST /memory/:id/outcome`, `POST /memory/supersede`, `GET|POST /memory/review`.

The dashboard exposes the **user** side of the spine (cookie auth, `created_by=user`) under `/api/memory/*`,
including the review queue — so provenance is decided by *where the write comes from*, never self-declared.

---

## Environment variables

Config lives in **`~/.knowledge-base/.env`** (the canonical location — not the repo root). `kb.db` and `.env`
are gitignored.

| Variable | Default | Purpose |
|----------|---------|---------|
| `KB_PASSWORD` | — | Dashboard password (required on first run) |
| `KB_PORT` | 3838 | HTTP port |
| `OBSIDIAN_VAULT_PATH` | — | Vault path for sync / classify / summarize |
| `KB_API_KEY_CLAUDE` / `_OPENAI` / `_GEMINI` | — | Per-agent REST API keys |
| `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` | — | OAuth 2.1 signing secret / issuer URL |
| `CLASSIFY_MODEL` | claude-haiku-4-5-20251001 | Model for AI classification/summaries/consolidation (`claude` CLI) |
| `KB_CORS_ORIGINS` | — | Comma-separated extra CORS origins |
| `CLAUDE_PATH` | claude | Full path to the `claude` CLI (set to `claude.cmd` on Windows if spawn fails) |

---

## Architecture & internals

- **Pure ESM, no build step** — runs directly on Node ≥ 20; all imports use `.js` extensions.
- **Data directory `~/.knowledge-base/`** — `kb.db` (SQLite), `files/` (ingested copies), `config.json`
  (bcrypt password hash), `.env`.
- **Database (`src/db.js`)** — a lazily-initialised singleton with inline, idempotent migrations; FTS5 virtual
  table with BM25 ranking; embeddings stored as Float32 binary blobs (3× smaller than JSON); WAL mode with a
  periodic checkpoint. `db.js` owns the documents/vault/search domain; it also defines the `memories` schema.
- **Memory (`src/memory/`)** — `store.js` is the memory domain (the `memories` entity, one salience formula,
  the review queue, the brief, consolidation); `spine.js` wires the Claude Code SessionStart/Stop hooks. Salience
  is computed *live* at recall — nothing decaying is stored.
- **Tools (`src/tools.js`)** — the single source of truth for all MCP tool definitions, shared by the stdio
  (`src/mcp.js`) and HTTP (`src/mcp-http.js`) transports.
- **Auth** — dashboard: bcrypt + HttpOnly session cookie; external: per-agent API keys (fast path) or OAuth 2.1
  via `better-auth`; MCP stdio is unauthenticated (local, trusted process).
- **Paths (`src/paths.js`)** — centralised path constants; import paths from here, never hardcode.

A fuller map is in [`CODEMAP.md`](CODEMAP.md); deep customisation in [`EXTENDING.md`](EXTENDING.md); a 30-second
agent orientation in [`llms.txt`](llms.txt); the operating contract in [`CLAUDE.md`](CLAUDE.md).

---

## Supported file types

| Category | Extensions |
|----------|-----------|
| Markdown | `.md` |
| Text | `.txt` `.log` `.json` `.yaml` `.yml` `.xml` `.csv` |
| Code | `.js` `.ts` `.jsx` `.tsx` `.py` `.go` `.rs` `.java` `.rb` `.sh` `.c` `.cpp` `.html` `.css` `.sql` |
| PDF | `.pdf` (text extracted) |
| Media | images / audio / video (indexed by metadata) |

---

## Multi-agent setup

**Claude Code (native MCP):** `kb register` writes the server to `~/.claude.json`; all tools become available.

**Other MCP clients:** point at the stdio transport:

```json
{
  "mcpServers": {
    "kaiba": { "command": "node", "args": ["/path/to/knowledge-base-server/bin/kb.js", "mcp"] }
  }
}
```

**ChatGPT / API-key agents:** import `openapi.json`, authenticate with `X-API-Key`.

Every agent reads and writes the same brain. What Claude learns in one session, another agent (or you) can use
in the next — and the memory bridge records *who* contributed each piece and how much to trust it.

---

## Deployment

For always-on use, run behind a process manager or as a systemd service — `kb setup --deploy=systemd`
generates and installs the unit for you (auto-restart on failure; logs via `journalctl -u kb-server -f`).
For remote access, set `BETTER_AUTH_URL` and an API key, and expose the port via your reverse proxy or tunnel.

---

## Development

```bash
npm test     # node --test tests/*.test.js  — ~100 tests, no external deps
```

No build step (pure ESM). The memory spine is covered by unit tests (in-memory SQLite, an injectable embedder
for fast/offline runs) plus real-system end-to-end checks that drive the actual `kb` CLI and prove the
save→load loop closes (consolidate → review → a fresh brief surfaces it). The one path that needs an
authenticated environment is the LLM extraction in `kb consolidate` (it shells out to the `claude` CLI, like
classification/summaries).

Design history and rationale are versioned in [`docs/memory-bridge/`](docs/memory-bridge/) — including the
adversarial review (`06`) whose confirmed findings are already fixed and the first-principles rebuild (`07`).
Contributions: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Honest scope

- The shipped core is **deliberately minimal**. The larger brain-inspired mechanism set (FSRS strength,
  reward-prediction-error, MMR diversity, replay, the agent blackboard) was explored, validated as
  *inspiration-not-proof*, and then **cut** in the rebuild (`docs/memory-bridge/07`); it stays in git history
  to return only when real recall data shows it pays rent.
- The document KB stays as it was; the spine adds the `memories` entity and the SessionStart/Stop hooks.
- Consolidation quality depends on the `claude` CLI extraction; agent-proposed memories are *pending* until you
  accept them, so a bad extraction never silently becomes load-bearing.
- Semantic recall does a brute-force cosine scan — excellent up to a few thousand memories, not tuned for
  millions.

---

## Credits & license

Kaiba began as a fork of [willynikes2/knowledge-base-server](https://github.com/willynikes2/knowledge-base-server)
(the document-KB foundation) and has since grown its own identity — the two-way memory spine was designed and
built in this fork, with [Claude Code](https://claude.com/claude-code) as the development partner. Licensed under
[MIT](LICENSE).
