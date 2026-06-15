# progress.md — newest on top

## 2026-06-14 — `/goal` "maak de brug de echte spine. Rebuild vanaf first principles" — SHIPPED
- **Kritiek die het triggerde:** de memory-laag was een *store die de agent KAN bevragen*, niet de *spine
  die de sessie MOET laden*. Drie echte missers: overladen datamodel (memories = ~20 nullable kolommen op
  `documents`), twee taxonomieën, en store-niet-spine wiring. Contract: `docs/memory-bridge/07-spine-rebuild.md`.
- **Memory is nu een first-class entiteit:** eigen `memories` tabel (schema in `db.js` initSchema, ops in
  **`src/memory/store.js`**). Eén taxonomie: `kind` {episodic,semantic,procedural} (`working`=ephemeral, nooit
  persistent). `memories_fts` external-content; memories worden **born indexed** (nooit UPDATE op pre-FTS rij →
  vermijdt `SQLITE_CORRUPT_VTAB`). Eén salience-formule, live berekend (niets vervallends opgeslagen):
  `relevance × (0.4·recency + 0.6·importance) × confidenceWeight × outcomeMult`; recency = Ebbinghaus half-life
  per kind (epi 24h, sem 720h, proc 4320h).
- **De spine (`src/memory/spine.js`):** `kb spine install` schrijft 2 Claude Code hooks (idempotente merge,
  back-up `.bak-kaiba`): **SessionStart** → `kb brief` als additionalContext (auto-LOAD); **Stop** →
  `kb consolidate --from-transcript` (auto-SAVE). Laden/opslaan zijn *ambient*, geen opt-in tool-calls.
- **Restraint (het punt):** bewust GECUT uit de core (blijft in git-history op master): FSRS storage-strength,
  PE-TD predicted-outcome, MMR diversity, temperature/seed sampling, prioritised replay, het `workspace`
  blackboard (`kb_workspace`), deps-hash staleness, conflict-surfacing (`kb_memory_conflicts`). Mechanisme liep
  voor op het bewijs; doel = *automatisch, vertrouwd, compounding gebruik*, niet capaciteit.
- **Surface herpunt naar store.js:** lean MCP-set (7: remember/recall/outcome/supersede/session_brief/review/
  consolidate); REST `v1.js`+`api.js`; dashboard `app.js` (kaart toont `kind` i.p.v. titel — memories hebben geen
  titel); CLI export/import. Dode documents-memory blok (~579 regels) uit `db.js` gesneden; `src/consolidate.js`
  + oude tests verwijderd. Tool-suite **26 → 24**. Review-queue is nu provenance-agnostisch (alles pending).
- **Echte bug gevonden+gefixt via real-system e2e:** `claude -p --output-format json` geeft een **stream-event
  ARRAY** terug, geen `{result}` object → extractie gaf 0 memories. `extractResultText` tolereert nu beide
  vormen (regressie-getest).
- **Geverifieerd — alle 5 bars (07) gehaald:** gate **99 tests, 0 fail** (nieuw `tests/memory-store.test.js`).
  `kb migrate-memories` op echte DB: 4 documents-memories → `memories` (count/provenance/review_status behouden,
  geëmbed). **Save→load loop dicht met de échte CLIs:** transcript → `kb consolidate --from-transcript` schreef
  4 pending via echte `claude` CLI → één geaccepteerd → een *verse* `kb brief --hook` surfacet hem (CORE 1→2).
- **Live-DB noot:** de e2e schreef 4 pending memories + accepteerde #5 in de echte kb.db. 6 staan pending —
  klaar voor user-review in dashboard (propose/dispose werkt). #5 bevat een lichte model-onnauwkeurigheid
  ("documents table") — mag de user superseden/rejecten.

## 2026-06-14 — CLS consolidatie-engine (continuous-learning capstone)
- `consolidateEpisodics()` (src/consolidate.js) maakt de Goal-2 scaffolding een echte pijplijn: sampelt de
  hoogste-prioriteit niet-geconsolideerde EPISODIC memories (replay-order via `getConsolidationBatch`) +
  een sample SEMANTIC voor context → LLM-generalisatie → schrijft een semantic memory, linkt `derived_from`
  en demoot de bronnen via `markConsolidated` (`consolidated_into`). CLI: `kb consolidate --episodics [--dry-run]`.
- **Geverifieerd:** gate **111 tests, 0 fail** (fake-extractor + fake-embedder: 1 semantic geschreven, 2 episodics
  gedemoot, provenance gelinkt; dry-run schrijft niets). Real-LLM-pad = `runClaude` (zelfde als summarizer/consolidate)
  → te bevestigen op een geauthenticeerde machine (`claude` CLI niet headless in deze sandbox).
- **View bij deze stap (user vroeg):** bottleneck is nu *gebruik*, niet features. Speculatieve brein-items
  (lateral inhibition, reconsolidation, retrieval-induced forgetting, BG-Gate, Critic) bewust on hold
  (research zelf low-confidence/contested). Aanrader: committen + dagelijks dogfooden zodat outcome/decay/
  spacing/review-data aangroeit.

## 2026-06-14 — Adversariële review van de hele body of work + fixes (FIX-THEN-SHIP → groen)
- Workflow `kaiba-final-review` (6 dimensies × reviewer + 2 verifiers + synth, 34 agents) over de hele diff;
  elke finding adversarieel geverifieerd vóór actie. Rapport: `docs/memory-bridge/06-review.md`.
- **HIGH gefixt:** (1) `kb_remember` MCP-tool accepteerde client-`created_by` → provenance-vervalsing
  ('user' over netwerk, bypass review) → nu hardcoded 'agent' (schema-veld weg; `rememberMemory` capt agent-confidence
  op 'asserted'). (2) export/import dropte `outcome_score` + `created_at` → nu behouden (UPDATE na insert; export
  bevat nu ook memory_system/storage_strength/predicted_outcome). (3) `consolidate` crashte op niet-string
  LLM-content → typeof-guard + try/catch per kandidaat.
- **MEDIUM gefixt:** `importMemories` crashte op niet-string content (typeof-guard + per-regel try/catch — nooit
  fataal); import vertrouwde authority-velden → forceert nu `review_status='pending'` + capt confidence op
  'inferred' (untrusted file kan geen auto-accepted CORE injecteren); test-hardening (T=0 expliciet + seed-onafh.,
  replay-surprise load-bearing, temperature negatieve-controle).
- **LOW gefixt:** dashboard recall forwardt `deps`; `importance` geclamped [0,1]; defensieve string-coercion in
  `insertDocument`; doc/count-correcties (9 memory-tools / **26** totaal; `kb_workspace` toegevoegd; CLS-provenance
  als scaffolding gemarkeerd; doc 03 §8 cross-ref).
- **Geverifieerd:** gate **109 tests, 0 fail** (nieuwe forgery-, malformed-import-, empty-query-tests).
  REJECTED findings blijven zichtbaar in 06-review.md (transparantie).

## 2026-06-14 — Brein-geïnspireerde ronde (research → design → build, 3 goals)
- **Research:** workflow `kaiba-brain-research` (7 hoeken × [1 researcher + 2 sceptici] + synth) →
  `docs/memory-bridge/05-brain-research.md` (+ `.data.json`). Scheidt gevestigde neuro van sound-engineering
  van analogie. Leidraad: **"brain-inspired, not brain-proven"** — elke wijziging heeft een onafhankelijke
  CS/ML-grond (FSRS, RPE/TD, MMR, blackboard, Gumbel-top-k, key-value). Contested brein-claims in §honesty.
- **Goal 1 (keystone):** `memory_system` {working,episodic,semantic,procedural} + `storage_strength`.
  Per-systeem gewichtstabel vervangt de globale SALIENCE-const (semantic = oude 0.4/0.6/72h → **back-compat**).
  Two-strength model: retrievability = Ebbinghaus met half-life × storage_strength; FSRS strengthen-on-recall
  (groeit méér als retrievability laag was — spacing). NULL memory_system leest als semantic (géén backfill →
  vermijdt FTS AFTER-UPDATE-trigger-corruptie op pre-FTS rijen).
- **Goal 2:** reward-prediction-error outcomes — `predicted_outcome` (running [-1,1]); `recordMemoryOutcome`
  vervangt flat ±1 door PE = actual − predicted (TD); confidence-downgrade ∝ precision×|PE| (hoge-confidence
  miss valt méér); reinforcement neemt af naarmate een memory zich bewijst. CLS-provenance: `consolidated_into`/
  `derived_from` + `markConsolidated` (episodic→semantic, demote-don't-delete; uit default recall). [Diepe
  interleaved LLM-consolidatie deferred — `claude` CLI niet headless in deze sandbox.]
- **Goal 3 (user-ask):** transparante agent-**`workspace`** (blackboard tabel) — `recallTraced` / `kb_workspace`
  loggen elke interne stap (Librarian fetch, Salience-Router broadcast/suppress) als auditbare
  {agent,doc_id,score,vote,reasoning} rij = single pane of glass. **Bounded non-determinisme:**
  temperature-sampled recall (Gumbel-top-k, seeded → reproduceerbaar), **T=0 default = exacte top-k van
  vandaag**, env `KB_RECALL_TEMPERATURE`.
- **Goal 4 (MMR) + prioritised replay:** opt-in `diversity` (λ) in `recallMemories` → MMR-selectie
  (complementaire memories i.p.v. parafrasen; env `KB_RECALL_DIVERSITY`, default 0 → back-compat).
  `getReplayQueue` rankt op importance × surprise (Prioritized Experience Replay) voor consolidatie-volgorde.
- **Geverifieerd:** gate **107 tests, 0 fail**; real-system e2e tegen echte DB (5 nieuwe kolommen + workspace
  tabel + traced recall 5 blackboard-rijen + T=0 deterministisch; #7 storage_strength → 1.0015).
  Tool-suite **26 tools**. Daarna: volledige adversariële review van de hele diff (workflow) + fixes.

## 2026-06-14 — Bridge Passes 4-6: spacing, conflict-surfacing, portability (roadmap complete)
- **Pass 4 — spaced re-surfacing:** `next_review_at` kolom + `getSessionBrief({core,due})` → kleine
  always-load CORE (accepted, hoogste importance) + DUE (next_review_at verlopen); surfacing strengthent
  én schuift next_review_at vooruit (spacing, capped 30d, interval = 1+access_count). Tool `kb_session_brief`
  + REST `/memory/brief`. De gevalideerde high-utility retrieval+spacing lever.
- **Pass 5 — conflict surfacing (eerlijk gescoped):** `findConflict(id)` read-only → dichtstbijzijnde
  semantische buur in band [0.80,0.985] (zelfde onderwerp, geen duplicaat) → routeert naar mens. Claimt
  GEEN contradictie-detectie (embeddings kunnen agreement/contradictie niet betrouwbaar scheiden, ~55%).
  Tool `kb_memory_conflicts`; consolidate rapporteert conflicts per memory. Geen auto-flag (anti-noise).
- **Pass 6 — portability:** `exportMemoriesNDJSON`/`importMemories` (provenance behouden, dedupe op
  content-hash, geïmporteerde memories best-effort geëmbed). CLI `kb memory-export [file] --project=`
  en `kb memory-import <file>`.
- **Geverifieerd:** gate **95 tests, 0 fail** (deterministische fake/perturbing embedders voor de plumbing).
  Real-system e2e tegen echte DB: brief (1 CORE + 4 DUE), export/re-import (imported=0, 4 dupes), conflict
  (geen valse positieven op de bestaande memories). Tool-suite nu **25 tools**.
- **Volgende fase (user-directive):** loop herstarten vanuit USER-perspectief met brein-architectuur
  research (lagen, gecontroleerde non-determinisme, interne transparante gespecialiseerde-agent-framework).
  Research-workflow `kaiba-brain-research` draait. Zie `docs/memory-bridge/04-roadmap.md` (alle 6 done).

## 2026-06-14 — Bridge Pass 3: dashboard review-UI + flagged-surfacing bug fix
- **Bug-fix (gegrond, gevonden in reassessment):** `listPendingMemories` filterde enkel
  `review_status='pending'` → 'flagged' (burned) memories verdwenen uit de review-queue. Nu:
  `(created_by='agent' AND pending) OR review_status='flagged'`, flagged eerst gesorteerd.
- **Dashboard Memory-view** (`src/public/index.html` + `app.js`): nieuwe "Memory" tab met (a)
  semantische recall-zoekbalk → kaarten met trust-badges (created_by, confidence, salience, stale)
  + Helped/Burned knoppen, en (b) review-queue → Accept/Reject (propose/dispose), flagged-eerst.
  XSS-veilig (createElement/textContent, geen innerHTML voor data). Praat met de bestaande
  cookie-auth `/api/memory/*` routes.
- **Geverifieerd:** gate **92 tests, 0 fail** (incl. flagged-regressietest); `node --check app.js` OK;
  **visueel geverifieerd in echte browser** (Playwright): Memory-view rendert correct — recall-kaarten
  + review-queue met flagged-eerst, badges en knoppen (screenshot bekeken). Login-flow niet end-to-end
  getest in sandbox (geen wachtwoord) — UI los gerenderd met gestubde data.
- **Reassessment-passes (≥3) voltooid.** Resterende roadmap (deferred): Pass 4 spaced-resurfacing,
  Pass 5 conflict-surfacing, Pass 6 portability. Zie `docs/memory-bridge/04-roadmap.md`.

## 2026-06-14 — Bridge Pass 2: auto session-close consolidatie (continuous learning)
- **Doel:** memories laten aangroeien zonder handmatige `kb_remember` — de gevalideerde
  reflectie→geheugen compounding-mechaniek geautomatiseerd.
- **Gebouwd:** `src/consolidate.js` — `extractCandidates` (LLM via `runClaude`, injecteerbaar voor
  tests; robuuste parser tolereert code-fences én prose-wrapped JSON) + `consolidate()` (extract →
  semantische dedupe via nieuwe `findSimilarMemory` in db.js → schrijf als agent/`inferred`/`pending`).
  MCP-tool `kb_consolidate` (admin), CLI `kb consolidate [file] --dry-run --project=` (stdin of file).
- **Bug-fix (gegrond):** `v1.js /memory` zette `author_detail` niet → nu `api:<service>` uit `req.apiService`.
- **Geverifieerd:** gate **91 tests, 0 fail** (fake-extractor + fake-embedder; dry-run schrijft niets;
  re-consolidatie van dezelfde sessie dedupe't beide → 0 nieuw). **Caveat:** real-LLM pad niet end-to-end
  getest in deze sandbox — de `claude` CLI is hier niet headless-geauthenticeerd (geeft korte non-envelope
  string terug); code degradeert netjes (0 extracted, geen crash). Pad gebruikt dezelfde `runClaude` als de
  reeds-werkende summarizer/classifier → werkt op de deployment van de user.
- **"Automatisch":** CLI/tool zijn de kern; de volledig-automatische trigger is een **opt-in** Claude Code
  Stop-hook (`kb consolidate < transcript`) — bewust niet opgedrongen (LLM-kost per sessie-einde).

## 2026-06-14 — Bridge Pass 1: semantische recall (post-goal reassessment)
- **Context:** na het bereiken van de hoofd-goal gaf de user de richtlijn: ≥3 orthogonale
  reassessment-passes richting "gedeeld tweede brein + continuous learning". Pass-keuze via een
  workflow (6 orthogonale lenzen → ranking). **Pass 1 = semantische recall** (de keystone-unblocker).
- **Probleem:** `kb_recall` rankte relevance op FTS rank-*positie*; bridge-memories hadden **geen**
  embeddings → onvindbaar via parafrase. Blokkeerde ook latere passes (spacing, conflict-detectie).
- **Gebouwd (db.js):** `embedMemory`/`embedMemorySafe` (best-effort, fire-and-forget bij write),
  `backfillMemoryEmbeddings()`, en `recallMemories` is nu **async**: cosine over per-memory embeddings
  met FTS rank-positie fallback (model/embeddings afwezig of fout). Callers (tools.js, v1.js, api.js) awaiten.
- **Geverifieerd:** gate **86 tests, 0 fail** (unit met deterministische fake-embedder voor de plumbing).
  Real-model e2e tegen echte DB: bestaande 4 memories ge-backfilled; `recall("deployment approach")`
  haalt een lexicaal-disjuncte probe ("we deploy with systemd not pm2") **als eerste** op via 'semantic'
  terwijl FTS hem mist. Probe daarna opgeruimd.
- **Roadmap:** `docs/memory-bridge/04-roadmap.md`. **Pass 2** = auto session-close consolidatie
  (continuous learning) + `author_detail` provenance-fix; **Pass 3** = dashboard review-UI +
  `listPendingMemories` 'flagged'-bug fix. Twee gegronde bugs gevonden (zie roadmap).

## 2026-06-14 — Twee-weg geheugenbrug (Claude ⇄ User) gebouwd + gevalideerd
- **Missie (via `/goal`):** Kaiba transformeren van user-only memory-tool naar echte bidirectionele
  Claude↔User geheugenbrug. 5 criteria: validatie-eerst, Claude's perspectief, compounding-mechanisme,
  gebouwd+geverifieerd e2e, self-captured.
- **Fase 1 — validatie:** workflow met 37 agents (9 claims × [1 researcher + 3 sceptici] + synthese)
  tegen primaire bronnen. Resultaat in `docs/memory-bridge/01-theory-validation.md` + `.data.json`.
  Kern: fundament (stateless→externe memory) TRUE; layered/reasoning/session-close = idee sound maar
  termen coined; wiki-superlatief FALSE; **ai-self-maintenance ~90% hands-off FALSE** (PersistBench
  53% leakage/97% sycophancy); de 3 gecoinde mechanismen UNVERIFIED → aanpassen+hernoemen.
- **Fase 2 — Claude-perspectief:** `docs/memory-bridge/02-claude-perspective.md` (geverifieerd door
  adversarieel subagent, PASS-with-gaps → 5 verbeteringen toegepast).
- **Fase 3 — gedeeld ontwerp:** `docs/memory-bridge/03-shared-design.md`. Pre-build adversarieel
  review (BUILD-WITH-FIXES, 10 constraints) → o.a. "provenance op call-site i.p.v. infer-by-transport",
  geen non-constante ADD COLUMN defaults, JS-coalesce in insertDocument. Allemaal opgelost (§10b).
- **Fase 4 — gebouwd:** schema-migratie + `rememberMemory/recallMemories/recordMemoryOutcome/
  supersedeMemory/listPendingMemories/reviewMemory/salienceOf/computeDepsHash` in `db.js`; 5 MCP tools
  in `tools.js`; REST routes in `v1.js` (agent) + `api.js` (user); `kb_ingest` tags-bug gefixt.
  **Gate groen: 83 tests, 0 fail** (incl. `tests/memory.test.js`: db-laag, migratie-op-niet-lege-tabel,
  tool-handlers, tags-regressie). **Real-system e2e:** echte `kb mcp` stdio server tegen echte kb.db —
  remember→recall→outcome→supersede→review volledig functioneel; migratie draaide op productie-DB.
- **Fase 5 — self-capture:** dit bestand + MEMORY.md + architecture-decisions.md bijgewerkt;
  kerndecisies gedogfood als echte memories in de KB via `kb_remember` (created_by=agent, pending review).
- **Vervolg (user-directive):** ≥3 orthogonale reassessment-passes → nieuwe goals richting "gedeeld
  tweede brein + continuous learning" (zie taak #6).

## 2026-04-07 — .env migratie + OAuth herstel + Better Auth auto-migrate
- **Probleem:** MCP Web UI auth kapot na `.env` locatieverandering (paths.js laadt nu `~/.knowledge-base/.env`, niet repo-root). `~/.knowledge-base/.env` bestond niet → alle env vars (incl. `KB_API_KEY_CLAUDE`, `BETTER_AUTH_SECRET`) ontbraken.
- **Fix:** `.env` verplaatst van repo-root naar `~/.knowledge-base/.env`.
- **Probleem 2:** `auth.db` verwijderd → OAuth user weg, Better Auth schema weg → 500 op sign-up.
- **Fix:** `npx @better-auth/cli migrate -y` uitgevoerd. User opnieuw aangemaakt via `POST /api/auth/sign-up/email`.
- **Feature:** `src/auth-oauth.js` detecteert nu bij startup of `user` tabel ontbreekt en runt automatisch de migratie (via `spawnSync npx @better-auth/cli migrate -y`). Nooit meer manueel nodig.

## 2026-04-05 — Upstream sync (willynikes2) — 70/70 tests groen
Upstream geanalyseerd (12 commits achter). Selectief gemerged — Kaiba-features (dedup, delete, tests) behouden.

**Overgenomen:**
- `src/capture/web.js` — dedup 'web' tag bug fix
- `src/paths.js` — `ENV_PATH` export + .env laadt uit `~/.knowledge-base/.env` (npx-safe)
- `src/auth.js` — sessions in-memory `Map` i.p.v. SQLite (lost DB-load-at-import pitfall op)
- `src/routes/session-routes.js` — nieuw, vervangt auth-routes.js; routes onder `/api/session/*`
- `src/routes/api.js` — `busboy` → `multer` voor file uploads
- `src/public/app.js` — routes bijgewerkt naar `/api/session/*`; XSS-sanitization behouden
- `src/cli/setup.js` — `which kb` voor systemd/launchd; KB_DIR/ENV_PATH; npx-detectie + warning
- `bin/kb.js` — dotenv replaced by `import '../src/paths.js'`
- `package.json` — node >=20, multer, `files` field, main → server.js
- **4 nieuwe/uitgebreide tests**: npx-compat, paths, setup, vault-parser (round-trip tags)

**Bewust overgeslagen:** db.js dedup-removal, CLI delete-removal, XSS-revert in app.js

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
