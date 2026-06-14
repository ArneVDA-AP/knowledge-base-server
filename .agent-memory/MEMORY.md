# MEMORY.md — knowledge-base-server (Kaiba)

> **Projectnaam: Kaiba** — de officiële bijnaam voor de knowledge-base-server. Gekozen door de originele architect (Opus). KB = Kaiba. Gebruik altijd "Kaiba" als je naar dit project verwijst.

## Status
**Claude Web UI MCP koppeling is LIVE.** (herstel: 2026-04-07)

Tailscale Funnel: `https://laptop.tail0411df.ts.net` → `:3838`
MCP endpoint: `https://laptop.tail0411df.ts.net/mcp`
Auth: OAuth 2.1 via Better Auth (user: `arnevandenabbeele@gmail.com`)
Alternatief: `X-API-Key` header met `KB_API_KEY_CLAUDE`

**.env locatie:** `~/.knowledge-base/.env` (niet repo-root)

**Open bug (laag prioriteit):** `src/cli/setup.js` appendt `KB_API_KEY_*` elke run zonder duplicate check.

**Fase 0 + Extension (Fase 1+2+3) VOLLEDIG OP MASTER (2026-05-26).** Worktree `worktree-shiny-giggling-alpaca` verwijderd en gemerged.

**Firefox/Zen WebExtension:** `C:\Users\Arne\My Drive\DBV4\claude_code\kb\claude-sessions-ext\` — Load via `about:debugging` → This Firefox → Load Temporary Add-on → `manifest.json`. Werkt: session capture, KB sync, summarize, search overlay.

**Extension flow:** Extension captuert session-metadata (titel, UUID, project, berichtencount). Gebruiker voegt notes toe in drawer. Sync + Summarize → 4-line status (WORKING ON / STOPPED AT / NEXT STEP / BLOCKER). Summaries zijn gebaseerd op de notes — zonder notes = "insufficient data".

## Twee-weg Geheugen-SPINE (Claude ⇄ User) — REBUILD 2026-06-14
Kaiba's memory is **de spine die de sessie laadt en opslaat**, niet enkel een store die de agent KAN bevragen.
First-principles rebuild-contract + status: `docs/memory-bridge/07-spine-rebuild.md` (history: `01`→`06`).
Detail van de rebuild-sessie: zie `progress.md` (bovenste entry).

**Memory is een first-class entiteit:** eigen **`memories`** tabel (schema in `db.js` initSchema, **ops in
`src/memory/store.js`**) — NIET ~20 kolommen op `documents`. Eén taxonomie: `kind`
{episodic,semantic,procedural} (`working`=ephemeral, nooit persistent). Kolommen: kind, content, reasoning,
created_by (user|agent), confidence (verified|asserted|inferred|unverified), importance, project, source(JSON),
outcome, use_count, last_used_at, superseded_by, supersession_reason, review_status (pending|accepted|rejected),
content_hash, embedding, created_at, updated_at. `memories_fts` external-content; memories **born indexed**
(nooit UPDATE op pre-FTS rij → vermijdt `SQLITE_CORRUPT_VTAB`).

**De spine (`src/memory/spine.js`):** `kb spine install` → 2 Claude Code hooks (idempotente merge, back-up
`.bak-kaiba`): **SessionStart** → `kb brief` als additionalContext (auto-LOAD); **Stop** →
`kb consolidate --from-transcript` (auto-SAVE; `extractTranscriptText` parset de transcript-JSONL). Ambient.

**Eén salience-formule** (live, niets vervallends opgeslagen): `relevance × (0.4·recency + 0.6·importance) ×
confidenceWeight × outcomeMult`; recency = Ebbinghaus half-life per kind (epi 24h, sem 720h, proc 4320h).
Strengthen-on-recall bumpt `use_count`+`last_used_at`. Demote-don't-delete via `supersede`. Burn verlaagt
confidence één stap. Relevance = semantische cosine (Xenova/all-MiniLM-L6-v2) met FTS rank-fallback.

**MCP memory-tools (7):** `kb_remember`, `kb_recall`, `kb_memory_outcome`, `kb_supersede`, `kb_session_brief`,
`kb_memory_review` (admin), `kb_consolidate` (admin). REST: agent `/api/v1/memory/*` (created_by=agent), user
`/api/memory/*` (cookie-auth, created_by=user). **Provenance op call-site, nooit client-supplied** — een caller
kan geen 'user' faken of 'verified' self-declaren. Review-queue is provenance-agnostisch (alles pending). CLI:
`kb spine`, `kb brief`, `kb consolidate`, `kb migrate-memories`, `kb memory-export/import`. Tool-suite **24** (17 base + 7 memory).

**GECUT in de rebuild (restraint; blijft in git-history op master):** FSRS storage-strength, PE-TD
predicted-outcome, MMR diversity, temperature/seed sampling, prioritised replay, `workspace` blackboard
(`kb_workspace`), deps-hash staleness, conflict-surfacing (`kb_memory_conflicts`). `src/consolidate.js` +
het dode documents-memory blok in `db.js` (~579 regels) verwijderd. Reden: mechanisme liep voor op het bewijs.

**Dashboard "Memory" tab** (`src/public/`): semantische recall (trust-badges) + review-queue (Accept/Reject);
kaart toont nu `kind` i.p.v. titel (memories hebben geen titel meer).

**Validatie-kernpunt (blijft gelden):** de oorspronkelijke gecoinde termen (constraint-store versioning,
reasoning-hash, decay-by-outcome) waren **UNVERIFIED** → aangepast/hernoemd. "ai-self-maintenance ~90%
hands-off" = **FALSE** → human-audit loop is load-bearing. Fundament (LLMs stateless → externe memory) = TRUE.
Migratie naar `memories`: `kb migrate-memories` (idempotent, dedupe op content-hash).

## Active Features
- MCP stdio server (`kb mcp`) — full 24-tool suite via `src/tools.js` (17 base + 7 memory spine)
- MCP HTTP server — zelfde tools over StreamableHTTP at `POST /mcp`
- REST API v1 at `/api/v1/` — externe toegang met API key of OAuth Bearer
- Web dashboard at `:3838` — cookie-auth SPA
- Obsidian vault incremental indexer — hash-based, markdown only
- Semantic search — lokaal HuggingFace `Xenova/all-MiniLM-L6-v2`
- AI classification pipeline (`kb classify`)
- `kb_delete` — document verwijderen via MCP (admin-only), CLI, REST
- `kb token-compare` — raw doc tokens vs KB summary tokens vergelijken (--all, --top=N)
- `formatYamlTags` utility — Obsidian-compatibele block-list tag format
- Test suite — `npm test` via `node --test tests/*.test.js`
- `POST /api/v1/documents/:id/summarize?profile=&force=` — on-demand summarization
- `PUT /api/v1/documents/:id` — document update (invalidates summary on content change)
- `GET /api/v1/documents?source=claude-web-ui:%` — source prefix filter (LIKE query)
- `src/utils/claude.js` — gedeelde `runClaude()` helper
- Firefox/Zen WebExtension `../claude-sessions-ext/` — sidebar dashboard + KB sync

## Critical Conventions
- **Pure ESM**: `"type": "module"` — imports met `.js` extensie, geen CommonJS
- **No build step**: draait direct met Node ≥20, `kb` CLI via `npm link`
- **Paths**: altijd importeren van `src/paths.js` — exporteert `KB_DIR`, `ENV_PATH`, `DB_PATH` etc.; laadt .env uit `~/.knowledge-base/.env`
- **Tools**: `src/tools.js` is single source voor alle MCP tool definities
- **DB singleton**: `getDb()` in `src/db.js`
- **Middleware order in server.js**: Wildcard CORS EERST → Better Auth VOOR `express.json()` → SPA fallback LAATSTE
- **Duplicate detection**: content-hash (SHA-256, 32 chars) in `documents.content_hash`; `insertDocument` doet `INSERT OR IGNORE` en retourneert bestaand doc bij conflict
- **Test DB injectie**: `_setTestDb(db)` + `_resetDb()` geëxporteerd uit `src/db.js` — gebruik altijd `after(() => _resetDb())` na `_setTestDb` om singleton te resetten

## Known Pitfalls
- `kb setup` appendt `KB_API_KEY_*` elke run zonder duplicate check — `.env` kan meerdere entries krijgen; dotenv pakt de LAATSTE
- Embedding model lazy load: eerste `kb_search_smart` duurt 10-30s
- `vault/indexer.js` heeft globale mutex — concurrent reindex = silent no-op
- ~~`src/auth.js` importeren raakt DB direct bij module-load~~ — OPGELOST: sessions zijn nu in-memory Map
- Better Auth handler MOET vóór `express.json()` staan in server.js
- Dashboard auth routes zitten onder `/api/session/*` (login, logout, check, password) — niet `/api/login` etc.
- **`auth.db` verwijderen** wist alle OAuth users — `src/auth-oauth.js` detecteert dit nu bij startup en runt automatisch `npx @better-auth/cli migrate -y`. Daarna opnieuw sign-up via `POST /api/auth/sign-up/email`.
- **`.env` canonical locatie** is `~/.knowledge-base/.env` (niet repo-root) — server laadt ALLEEN van daar.
- **`kb register`** registreert alleen de lokale stdio MCP in `.claude.json` — staat los van de OAuth Web UI koppeling.
- **Windows spawn ENOENT**: `spawn('claude')` faalt op Windows omdat npm globals `.cmd`-bestanden zijn. Fix: `shell: process.platform === 'win32'` in `src/utils/claude.js` (al gefixt). Als het toch faalt, stel `CLAUDE_PATH` in op het volledige pad naar `claude.cmd`.
- **Claude.ai API v2**: conversations endpoint heet nu `chat_conversations_v2` (niet `chat_conversations`). Extension `background.js` gebruikt `/chat_conversations[^/]*/` regex om beide te matchen.
- **Extension optional_permissions**: `browser.permissions.request({ origins: ["<all_urls>"] })` toont geen popup in Firefox options_ui tabs. Gebruik static host permissions in `manifest.json` (`permissions: ["http://*/*", "https://*/*"]`) — geen runtime grant nodig.
- **Extension exportFunction**: `window.wrappedJSObject.fetch = exportFunction(...)` breekt claude.ai (streaming responses, AbortSignal, credential headers falen door Xray boundary). Gebruik script-injectie via `web_accessible_resources` in place context.

## Key File Map
```
bin/kb.js              CLI entry point — laadt .env via `import '../src/paths.js'`
src/server.js          Express server (dashboard + REST + MCP HTTP + wildcard CORS)
src/mcp.js             MCP stdio server
src/tools.js           Alle MCP tool definities (gedeeld)
src/db.js              SQLite singleton, schema (incl. memories table), documents FTS5 search
src/memory/store.js    Memory domein: memories-entiteit, salience, recall, brief, review, consolidate
src/memory/spine.js    Wiring van SessionStart(brief)+Stop(consolidate) Claude Code hooks (de spine)
src/ingest.js          File/directory ingest, gitignore-aware
src/paths.js           Path constants + .env loader uit ~/.knowledge-base/.env
src/auth.js            Dashboard auth (bcrypt, in-memory sessions)
src/auth-oauth.js      OAuth 2.1 via better-auth
src/mcp-http.js        MCP over HTTP (StreamableHTTP)
src/routes/session-routes.js  Dashboard auth routes (/api/session/*)
src/routes/v1.js       Externe REST API + DELETE/PUT/summarize endpoints
src/middleware/api-key.js  API key auth (X-API-Key header)
src/utils/claude.js    Shared runClaude() helper — spawn claude CLI subprocess (shell:true op Windows)
src/cli/setup.js       Setup wizard (BUG: appendt API keys zonder duplicate check)
src/cli/delete-cli.js  CLI delete command (multi-ID support)
src/cli/token-compare.js  Token vergelijking raw docs vs summaries
src/utils/frontmatter.js   Obsidian-compatible YAML tag formatter

../claude-sessions-ext/          Firefox/Zen WebExtension (sibling dir, niet in repo)
  manifest.json                  MV2, static host permissions, sidebar_action, options_ui
  interceptor.js                 Page-context fetch patch (web_accessible_resources)
  content.js                     Relay: page postMessage → runtime.sendMessage
  background.js                  Normalize + storage + KB sync + chat_conversations_v2 routing
  lib/kb-client.js               KbClient class voor Kaiba REST API
  settings/                      Options UI (KB URL, API key, test connection)
  sidebar/                       Tmux-style panel (HTML + CSS + JS)
```
