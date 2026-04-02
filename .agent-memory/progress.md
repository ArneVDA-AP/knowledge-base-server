# progress.md — newest on top

## 2026-04-02 — Branch cleanup, upstream sync, token-compare feature
- **Branch opgeruimd** (`feature/dedup-and-delete`):
  - Windows/Google Drive duplicaat-bestanden verwijderd (`tests/**(1).test.js`)
  - Uncommitted feature work gecommit (test infra: npm test script, DB test helpers, CRUD/dedup/delete/tools tests)
  - Flaky auth integration tests verwijderd (upstream deed hetzelfde)
- **Upstream vergelijking** met `willynikes2/knowledge-base-server`:
  - 11 commits achter sinds divergentiepunt `c44b837`
  - Overgenomen: `formatYamlTags` utility — fixte Obsidian-incompatibel YAML tag format (`[tag1, tag2]` → `- tag`)
  - Alle 8 callsites bijgewerkt (capture/*, promotion, sync, synthesis, tools)
  - Bewust overgeslagen: session-routes rename (cosmetisch, conflicteert met onze auth-fixes), npx support (niet nodig), .env path change (breekt onze setup), token-compare dangling reference (bestand ontbreekt in upstream!)
- **`kb token-compare` geïmplementeerd** — vergelijkt raw doc tokens vs KB summary tokens
  - Per-document breakdown + aggregate besparingen + kostenschatting (~$3/M tokens)
  - Flags: `--all`, `--top=N`
  - Tests toegevoegd (2 tests)
- **Alle tests groen** — frontmatter (7), db (11), tools-handlers (7), token-compare (2), v1 API tests
- Gepusht naar `origin/feature/dedup-and-delete`
- `kb summarize` + `kb token-compare --all` nog te draaien op machine met Obsidian vault

## 2026-03-27 — Test suite uitbreiding (61 tests, 0 fail)
- Projectnaam **Kaiba** officieel vastgelegd (KB = Kaiba, keuze van Opus) — opgeslagen in MEMORY.md, KB, en auto-memory
- Kaiba beoordeeld: 7/10, solide fundament, test-suite als voornaamste gap
- Test suite gepland (plan mode + Opus review) en geïmplementeerd:
  - `package.json`: `npm test` script toegevoegd
  - `src/db.js`: `_setTestDb()` + `_resetDb()` exports toegevoegd voor test-isolatie
  - `tests/db.test.js`: +8 tests (CRUD, search, dedup, stop words, edge cases)
  - `tests/v1.test.js`: +4 tests (DELETE endpoint, dedup via HTTP, search met echte data)
  - `tests/tools-handlers.test.js`: nieuw — 7 tests voor kb_list, kb_ingest, kb_search, kb_read, kb_delete handlers
- Resultaat: 61/61 tests groen; pre-existing flaky auth test (bcrypt parallelisme) geïdentificeerd maar niet gefixed

## 2026-03-22 — Branch + PR: feature/dedup-and-delete
- Sessie-context opgehaald uit KB (16 session captures gevonden)
- Branch `feature/dedup-and-delete` aangemaakt met 4 commits:
  1. Content-hash dedup + gitignore-aware ingestion (db.js, ingest.js)
  2. kb_delete feature op MCP, CLI, REST (tools.js, bin/kb.js, delete-cli.js, v1.js, openapi.json)
  3. CLAUDE.md project instructies
  4. Untrack `.claude/settings.local.json`
- Fout gecorrigeerd: eerdere PR was naar willynikes2 (upstream) i.p.v. ArneVDA-AP — nieuwe PR #8 op juiste repo
- Uncommitted changes opgelost via `.git/info/exclude` (niet `.gitignore`, want die wordt gelezen door `collectFiles()` in de ingester)
- PR: https://github.com/ArneVDA-AP/knowledge-base-server/pull/8

## 2026-03-21 — Bug fixes: duplicaten + kb_context datumvelden
- Root cause analyse: `kb_ingest` (MCP) en vault-indexer zijn twee onafhankelijke write-paden zonder cross-check → zelfde inhoud kon twee keer worden opgeslagen met verschillende `doc_type`
- Fix 1: `src/db.js` — `content_hash` kolom + conditionele UNIQUE index + migration + `insertDocument` doet nu `INSERT OR IGNORE` en retourneert bestaand doc bij conflict
- Fix 2: `src/db.js` + `src/tools.js` — `updated_at` toegevoegd aan `searchDocuments` SELECT; `created_at`/`updated_at` doorgezet in `kb_context` briefings (FTS-pad + filter-pad met LEFT JOIN)
- Bugfix tijdens testen: UNIQUE index stond in eerste `db.exec()` blok vóór migration → verschoven naar ná `ALTER TABLE`
- Getest en gevalideerd via Node smoke tests: dedup werkt (zelfde ID terug), datumvelden aanwezig in FTS resultaten

## 2026-03-21 — Claude Web UI MCP koppeling LIVE
- Tailscale Funnel geconfigureerd: `https://laptop.tail0411df.ts.net` → `:3838`
- MCP HTTP endpoint getest via curl (initialize → 200 OK)
- OAuth analyse: code was compleet, maar `BETTER_AUTH_URL` ontbrak in `.env` en DB migratie was nooit uitgevoerd
- Better Auth DB migratie gedraaid via `npx @better-auth/cli migrate --config src/auth-oauth.js -y` → 7 tabellen aangemaakt
- OAuth user aangemaakt: `arnevandenabbeele@gmail.com`
- Server herstart, discovery doc geverifieerd (alle URLs wijzen naar Tailscale URL)
- Claude Web UI MCP connector succesvol verbonden

## 2026-03-20 — Session: Memory protocol + SessionStart hook
- Uitgelegd hoe Session Start/End Protocol werkt en hoe te verifiëren
- `UserPromptSubmit` hook geïmplementeerd in `~/.claude/settings.json` die MEMORY.md auto-injecteert
- Omgezet naar `SessionStart` (efficiënter: eenmalig per sessie i.p.v. elk bericht)
- Beslissing: `SessionStart` hook als primaire afdwinging; CLAUDE.md als backup
- Main task (claude.ai MCP koppeling) uitgesteld naar volgende sessie

## 2026-03-20 — Debug sessie: Invalid API key
- Root cause gevonden: duplicate `KB_API_KEY_CLAUDE` in `.env` (setup wizard appendt elke run)
- Fix: eerste duplicate verwijderd, tweede key behouden
- Ontdekt: Claude Code gebruikt stdio MCP (geen key nodig); Claude Web UI vereist HTTP MCP + API key
- Open: setup.js bug (duplicate key append) nog niet gefixt
- Open: Claude Web UI MCP koppeling nog niet geconfigureerd
- Sessie vastgelegd in KB via kb_capture_session

## 2026-03-20 — Session: CLAUDE.md + agent memory setup
- Created `CLAUDE.md` met commands, architectuur, auth model, environment variables, en constraints
- Agent memory opgezet: MEMORY.md, conventions.md, architecture-decisions.md, environment.md, debugging-patterns.md, progress.md
- Bestaande uncommitted wijzigingen geanalyseerd:
  - `bin/kb.js`: dotenv laadt nu expliciet via `__dirname` (fix voor CWD-afhankelijkheid)
  - `src/ingest.js`: `collectFiles()` nu gitignore-aware met `IGNORE_DIRS` hardcoded set
  - `docs/handboek.md`: untracked, niet geanalyseerd
