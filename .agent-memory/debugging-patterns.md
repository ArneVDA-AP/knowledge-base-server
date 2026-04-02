---
name: debugging-patterns
description: Known bugs, pitfalls, and their fixes in knowledge-base-server
type: project
---

## dotenv niet geladen wanneer `kb` buiten de repo-directory wordt uitgevoerd
**Symptom**: Environment variables (KB_PASSWORD, OBSIDIAN_VAULT_PATH, etc.) zijn undefined, ook al staat `.env` in de repo.
**Cause**: `import 'dotenv/config'` laadt `.env` relatief aan de CWD, niet aan `bin/kb.js`.
**Fix**: In `bin/kb.js` — expliciete pad via `__dirname`:
```js
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });
```
**Status**: Fixed (uncommitted as of 2026-03-20).

## `collectFiles()` ingested `node_modules` en build-artifacts
**Symptom**: `kb ingest .` of `kb ingest ~/project` nam tienduizenden bestanden mee van `node_modules`, `dist`, etc.
**Cause**: De originele `collectFiles()` had geen directory-filtering.
**Fix**: `src/ingest.js` — `IGNORE_DIRS` set + `loadGitignorePatterns()` + `isIgnoredByGitignore()`. Respecteert nu `.gitignore` van de root-directory.
**Status**: Fixed (uncommitted as of 2026-03-20).

## Concurrent vault reindex is silent no-op
**Symptom**: `kb vault reindex` geeft 0 resultaten terug als het al loopt.
**Cause**: `indexVault()` heeft een module-level `indexing` boolean mutex.
**Diagnosis**: Controleer of er al een reindex-proces loopt. Wacht tot het klaar is.

## Embeddings model eerste load duurt lang
**Symptom**: Eerste `kb_search_smart` aanroep in een sessie duurt 10-30 seconden.
**Cause**: `Xenova/all-MiniLM-L6-v2` wordt lazy geladen bij eerste gebruik.
**Normal behavior**: Model wordt gecached na eerste load. Volgende aanroepen zijn snel.

## Dashboard login werkt niet na wachtwoord-reset
**Symptom**: Login mislukt met correct wachtwoord.
**Cause**: `config.json` corrupt of `passwordHash` veld ontbreekt.
**Fix**: Verwijder `~/.knowledge-base/config.json` en herstart met `KB_PASSWORD=nieuwwachtwoord kb start`.

## Duplicate ingestion — zelfde inhoud via twee code-paden (FIXED 2026-03-21)
**Symptom**: Zelfde inhoud staat twee keer in `documents` met verschillende `doc_type` (bv. "text" + "source").
**Cause**: `kb_ingest` MCP tool → `ingestText()` en vault-indexer → `insertDocument()` zijn onafhankelijke write-paden zonder cross-check. `insertDocument` had geen UNIQUE constraint.
**Fix**: `src/db.js` — `content_hash TEXT` kolom + `CREATE UNIQUE INDEX ... WHERE content_hash IS NOT NULL` + `INSERT OR IGNORE` in `insertDocument`. Bij conflict retourneert de functie het bestaande document.
**Ordering pitfall**: Index-creatie moet ná de `ALTER TABLE` migration staan — anders crasht `initSchema` op bestaande DBs.

## Duplicate ingestion van bestanden met dezelfde naam
**Symptom**: Bestand wordt geskipt (`skipped++`) ook al is de inhoud anders.
**Cause**: `ingestDirectory()` deduplicateert op `basename(filePath)` (de `source` kolom), niet op content-hash.
**Workaround**: Hernoem het bestand. Content-hash dedup in `insertDocument` vangt dit nu ook op als de inhoud identiek is.

## `auth.js` importeren crasht als DB niet bestaat
**Symptom**: Module-load error bij importeren van `src/auth.js`.
**Cause**: `initSessions()` wordt uitgevoerd bij module-load en roept `getDb()` aan, wat de DB aanmaakt.
**Normal behavior**: Dit is verwacht gedrag — `paths.js` maakt `~/.knowledge-base/` aan bij import, DB wordt aangemaakt bij eerste `getDb()` aanroep.

## kb setup appendt API keys elke run — duplicate entries in .env
**Symptom**: "Invalid API key" ondanks correcte key in .env.
**Cause**: `src/cli/setup.js` appendt `KB_API_KEY_*` elke keer onderaan `.env` zonder te checken of de entry al bestaat. dotenv pakt bij duplicaten de LAATSTE waarde. Als de client de EERSTE waarde gebruikt, matcht hij niet.
**Fix**: `.env` handmatig nakijken en duplicaten verwijderen. Houd de laatste (onderste) waarde.
**Preventie**: Bug in `src/cli/setup.js` moet gefixed worden (check voor bestaande key voor append).

## /api/v1/health is publiek — verkeerde endpoint voor API key test
**Symptom**: curl naar `/api/v1/health` geeft 200 OK ook zonder API key.
**Cause**: Health endpoint is expliciet geregistreerd zonder `brainAuth` middleware: `app.get('/api/v1/health', corsMiddleware, ...)`.
**Fix**: Gebruik `/api/v1/stats` of `/api/v1/search?q=test` voor authenticated endpoint tests.

## Better Auth handler moet vóór express.json staan
**Symptom**: OAuth requests mislukken met parse errors.
**Cause**: Better Auth verwerkt de raw request body zelf — `express.json()` er voor zet body corrupt.
**Fix**: In `server.js` — `app.all('/api/auth/*', ...)` registreren vóór `app.use(express.json(...))`.
