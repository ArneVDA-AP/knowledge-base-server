# 07 — First-principles rebuild: the bridge as the spine

> Goal (set via `/goal`): *make the bridge the actual spine; rebuild the project from first principles.*
> This is the contract. It enacts the self-critique in the session: the memory layer was a capable
> **store the agent can query**, not the **spine it must load**. The rebuild fixes the three real misses —
> overloaded data model, two memory taxonomies, and store-not-spine wiring — and exercises *restraint*
> (it deletes speculative mechanism rather than carrying it forward). 2026-06-14.

## Principles
1. **Memory is the entity.** A first-class `memories` table — not ~20 nullable columns bolted onto
   `documents`. Ingested documents become a *source* that can feed memories, not the memory store itself.
2. **One taxonomy.** `episodic` (what happened) · `semantic` (durable facts/decisions/preferences) ·
   `procedural` (how-to/skills). `working` = ephemeral session scratch, never persisted. The inherited
   cold/warm/hot tiering is dropped — recency+importance already express it.
3. **The session is bracketed by memory.** A small brief **auto-loads** at session start; consolidation
   **auto-saves** at session end. Recall is *cued*, capture is *ambient* — not opt-in tool calls.
4. **Minimal trustworthy core.** Keep only what's validated and earns its place; add mechanism later only
   when real usage justifies it. We **delete** the speculative machinery (see "Cut").
5. **The human disposes.** Agents *propose* (pending); the user *accepts/rejects*. Provenance is decided
   by where a write comes from; it cannot be self-declared.
6. **Keep the infrastructure.** SQLite, local embeddings, MCP/REST/dashboard, auth, ingestion — these were
   the right call. The rebuild is the memory domain + its wiring, on this foundation.

## The model — `memories` (schema owned by `db.js`, ops by `src/memory/store.js`)
```
id, kind (episodic|semantic|procedural), content, reasoning,
created_by (user|agent), confidence (verified|asserted|inferred|unverified),
importance REAL [0,1], project, source (JSON: {document_id?|session?|origin}),
outcome INTEGER (net helped+/burned-), use_count, last_used_at,
superseded_by, supersession_reason, review_status (pending|accepted|rejected),
content_hash, embedding BLOB, created_at, updated_at
```
- FTS5 `memories_fts` over (content, reasoning) for the keyword/fallback path; `embedding` for semantic.
- **One salience formula, computed live** (nothing decaying is stored):
  `salience = relevance × (0.4·recency + 0.6·importance) × confidenceWeight × outcomeMultiplier`
  where `recency = exp(-ln2 · Δh / halfLife[kind])` (episodic 24h · semantic 720h · procedural 4320h —
  the one retained expression of "different systems, different rules"), `confidenceWeight`
  {verified 1.0, asserted .75, inferred .5, unverified .3}, `outcomeMultiplier = clamp(1+0.15·outcome, .4, 1.6)`.
- **Strengthen-on-recall:** surfaced memories bump `use_count` + reset `last_used_at`. That's it — no
  separate storage-strength field.

## Core ops (`src/memory/store.js`)
- `remember({kind, content, reasoning, importance, confidence, created_by, project, source})` — dedup by
  content_hash; **agent → pending**, confidence capped at `inferred` (correctness gate), never `verified`;
  **user → accepted**, default `asserted`. Embeds (best-effort).
- `recall(query, {limit, kind, project, includeSuperseded})` — live memories ranked by salience (semantic
  with FTS fallback); strengthens what it surfaces; returns trust signals.
- `brief({core, recent, project})` — **THE SPINE LOAD.** A small, high-signal payload: CORE = accepted
  memories by importance (prohibitions/decisions first) + RECENT = recently-used accepted memories. Token-budgeted.
- `review(id, accept|reject)` · `supersede(oldId, newId, reason)` · `recordOutcome(id, helped|burned)`
  (outcome ±1; a burn downgrades confidence one notch — simple, no TD).
- `consolidate(text, {extractFn, dryRun, project})` — **THE AMBIENT SAVE.** LLM-extract durable memories
  from a session → dedup → `remember(agent/pending)`. Injectable extractor for tests.
- `migrateFromDocuments()` — one-time: pull `documents` where `created_by IN ('user','agent')` into
  `memories` (map kind from doc_type/memory_system; dedup). No data lost.

## The spine wiring (the headline deliverable)
- `kb brief [--project=] [--write]` — prints the session-start payload as markdown; `--write` also
  refreshes `.agent-memory/MEMORY.md` as a **generated projection** (the file stops being the source of truth).
- `kb spine install` — installs two Claude Code hooks into `~/.claude/settings.json`:
  **SessionStart →** inject `kb brief` as additionalContext (auto-load); **Stop/SessionEnd →** run
  `kb consolidate` on the transcript (auto-save). The bridge becomes the session spine; it loads and saves
  itself. (`kb spine status` / `--print` to preview without writing.)
- `kb consolidate --episodics` retained as the CLS pass over stored episodics.

## Cut from the core (deleted, not carried forward — restraint is the point)
storage_strength/FSRS · predicted_outcome/PE-TD · MMR diversity · temperature/seed sampling · prioritized
replay · the workspace blackboard · deps_hash staleness · conflict surfacing. **Why:** mechanism front-run
the evidence; the goal is *automatic, trusted, compounding use*, not capability. They remain in git history
(on `master`) and may return when real recall data shows they pay rent.

## Verifiable bar (goal "done")
1. `memories` table + `store.js` core; gate green.
2. Migration moves existing documents-memories into `memories` (count preserved).
3. `kb brief` returns the load payload; `kb spine install` wires SessionStart(brief)+SessionEnd(consolidate).
4. **Spine proven end-to-end:** `consolidate(session)` writes memories → a *fresh* `brief` auto-surfaces
   them. Save→load loop closes without a manual tool call.
5. Lean tool/REST surface re-pointed at `store.js`; speculative tools retired from the core.

## Status — SHIPPED (2026-06-14, branch `rebuild/memory-spine`)
All five bars met and verified against the live system:
1. ✅ `memories` table + `src/memory/store.js` core; `src/memory/spine.js` wiring. Gate green (**99 tests, 0 fail**),
   incl. `tests/memory-store.test.js` (store ops, salience, brief, consolidation, portability, migration, the
   re-pointed tools, the spine).
2. ✅ `kb migrate-memories` lifted the 4 live documents-based memories into `memories` (count preserved;
   provenance + review_status preserved; all embedded).
3. ✅ Real `kb brief --hook` returns valid SessionStart JSON; `kb spine install` merges SessionStart(brief)+
   Stop(consolidate) idempotently, preserving existing hooks.
4. ✅ **Loop closed end-to-end with the real CLIs:** a transcript piped to `kb consolidate --from-transcript`
   wrote 4 pending memories via the real `claude` CLI → accepted one → a *fresh* `kb brief --hook` auto-surfaced
   it (CORE 1→2). Fixed a real bug found here: the CLI's `--output-format json` returns a **stream-event array**,
   not a `{result}` object — `extractResultText` now tolerates both (regression-tested).
5. ✅ MCP tools re-pointed at `store.js` (lean 7: remember/recall/outcome/supersede/session_brief/review/
   consolidate); REST (`v1.js`, `api.js`) + dashboard re-pointed; CLI export/import re-pointed. `kb_workspace` +
   `kb_memory_conflicts` removed. The dead documents-memory block (~579 lines) excised from `db.js`;
   `src/consolidate.js` and its tests deleted. Total tool surface 26 → 24.
