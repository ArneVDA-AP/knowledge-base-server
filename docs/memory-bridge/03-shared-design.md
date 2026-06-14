# The Shared Design — Kaiba as a Two-Way Memory Bridge

> Reconciles the user's existing perspective with Claude's perspective
> (`02-claude-perspective.md`) into one design, grounded in the validated findings
> (`01-theory-validation.md`) and verified against the current Kaiba codebase.
> Status: **foundation drafted** (reconciliation + contract + principles). The
> compounding/decay mechanism (§7) and the schema/tool specifics that depend on it
> (§4, §8) are completed once theory validation lands — see the explicit markers.

---

## 1. Reconciliation premise

Two parties, one store, but **not symmetric** (see `02-claude-perspective.md` §7). The
design is built *on* the asymmetry, not against it:

- The **user** is authoritative about intent, goals, preferences, and prohibitions; has
  native cross-session continuity; writes slowly and rarely; main failure is *forgetting
  to write things down*.
- **Claude** is authoritative about verified operational detail (how the code behaves,
  what broke and why); has **zero** native continuity; writes fast and voluminously; main
  failure is *writing confident-sounding things that are wrong*.

A bridge that treats both as the same kind of writer into the same flat store fails both.
The design records **which side** authored each memory and **how verified** it is, and lets
each side see and correct the other's contributions.

This is the missing half of Kaiba. Everything in the current system was designed from the
user's side; this document deliberately makes Claude a first-class party to the *mechanism*
(not to the user's intent — Claude proposes on intent, the user disposes).

---

## 2. The three memory surfaces today — and the one they should become

Kaiba's reality right now is **three disconnected memory surfaces**, only one of which is
the actual bridge:

| Surface | Where | Who reads it | Who writes it | Role today |
|---|---|---|---|---|
| **Kaiba KB** | `~/.knowledge-base/kb.db` (server) | user (dashboard), Claude (MCP/REST) | both, via ingest/capture/vault | The shared store — the bridge |
| **`.agent-memory/`** | repo files | Claude (SessionStart) | Claude (by hand) | Project status/conventions, loaded each session |
| **`~/.claude/.../memory/`** | global Claude-Code files | Claude | Claude (by hand) | The frontmatter+index memory described in the system prompt |

These overlap and drift. The auto-ingest (`server.js:44-60`) already pulls
`~/.claude/projects/*/memory` *into* Kaiba on first run — a one-way, one-time bridge that
proves the intent but not the mechanism. The design's job is to make **Kaiba the canonical
two-way store**, with the file surfaces becoming either (a) a *projection* Kaiba renders for
session loading, or (b) writers that sync into Kaiba continuously — not independent islands.

Decision (non-contingent): **Kaiba is canonical.** The always-loaded session core is
*generated from* Kaiba, so a write by either party on either surface converges to one place.

---

## 3. Where the user's existing design already aligns

Crucial for a genuine reconciliation: the user has already built much of what Claude's
perspective asks for. The design **extends** this rather than replacing it. The user's
articulated memory spec (the global frontmatter-memory + `.agent-memory/`) already has:

- **Typed memory** — `metadata.type: user | feedback | project | reference`. This maps
  almost directly onto the layered model (global = user/feedback, project = project,
  wiki = reference + a new *concept* type). ✅ keep, extend.
- **Reasoning attached** — feedback/project memories already require **`Why:`** and
  **`How to apply:`** lines. This is exactly Claude's "reasoning, not bare rules" ask
  (`02` §3). ✅ keep, make it a first-class field, extend to all agent-written memory.
- **An index that loads each session** — `MEMORY.md` (one line per memory). This is the
  "small core + index, not everything" loading model (`02` §3). ✅ keep, formalize the
  size budget.
- **Linking** — `[[name]]` cross-links. The knowledge-graph substrate. ✅ keep.
- **Supersession-by-deletion** — "delete memories that turn out to be wrong." This is the
  *intent* of decay, but the blunt version. Claude's perspective asks to **demote, not
  delete** (`02` §6) so the corrected belief stays visible. ⚠️ this is the one place the
  designs diverge, and §7 resolves it.
- **Recall-as-background-context with a verify caveat** — the system already tells Claude
  "if a memory names a file/function/flag, verify it still exists." That caveat is an
  admission the store can't currently express its own trust level. ⚠️ §4 fixes this by
  making provenance/confidence/staleness first-class so the caveat becomes data, not a
  blanket warning.

So the reconciliation is mostly **additive**: take the user's typed-frontmatter-with-
reasoning design, host it canonically in Kaiba, and add the four trust signals and the
demote-don't-delete decay that Claude needs to actually rely on it.

---

## 4. Data model — provenance, trust, reasoning *(foundation set; decay columns pending §7)*

Verified current `documents` schema (`db.js:29-41`, confirmed by reading source):
`id, title, content, content_hash, source, doc_type, tags, file_path, file_size,
created_at, updated_at, summary`. There is **no** field for who/what created a doc, its
confidence, its reasoning, its access/usefulness, or its supersession. `vault_files` has a
`confidence TEXT` column that is essentially unused.

The single write chokepoint is **`insertDocument` (`db.js:136`)** — every path (file,
directory, `ingestText`, vault indexer) funnels through it. Provenance/trust fields are
added **there, once**, and propagate everywhere. This is the keystone.

**Committed additions (non-contingent — flow from `02` §4, the four trust signals):**

| Column on `documents` | Type | Purpose | From |
|---|---|---|---|
| `created_by` | TEXT (`'user'` \| `'agent'` \| `'system'`) | Provenance: which side authored this | `02` §4.1, §7 |
| `author_detail` | TEXT (nullable) | Finer origin, e.g. agent model id or "subagent:unverified" | `02` §4.1 |
| `confidence` | TEXT (`'verified'` \| `'asserted'` \| `'inferred'` \| `'unverified'`) | Was this checked against ground truth? | `02` §4.2 |
| `reasoning` | TEXT (nullable) | The *why* behind the fact — the transferable payload | `02` §3, §5 |
| `verified_at` | DATETIME (nullable) | When last confirmed true against reality (staleness) | `02` §4.3 |

Backward-compatible: all nullable / defaulted, added via the existing migration pattern
(`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`, as at `db.js:91-109`). Existing rows get
`created_by='system'`, `confidence='unverified'` — honest defaults for legacy content.

**Retention columns (committed post-validation — see §7):** these are the *inputs* to the
salience score, which is computed live at recall (no decaying number is ever stored).

| Column on `documents` | Type | Purpose | From |
|---|---|---|---|
| `access_count` | INTEGER DEFAULT 0 | strengthen-on-recall counter ("pays rent") | §7.2 |
| `last_accessed_at` | DATETIME (nullable) | recency anchor for live decay; reset on recall | §7.1–2 |
| `importance` | REAL DEFAULT 0.5 | importance weight [0,1]; prevents "all important" collapse | §7.3 |
| `outcome_score` | REAL DEFAULT 0 | net helped(+)/burned(−) signal; feeds confidence + salience | §7.4 |
| `superseded_by` | INTEGER (→documents.id) | demote-don't-delete supersession link | §7 |
| `supersession_reason` | TEXT (nullable) | why superseded (kept visible) | §7 |
| `deps_hash` | TEXT (nullable) | SHA-256 of declared inputs; tracked-dependency staleness | §7 |
| `review_status` | TEXT DEFAULT 'none' | propose/dispose audit: none/pending/accepted/rejected/flagged | §5, §7 |

---

## 5. The bidirectional contract (propose / dispose)

The rule that makes "two-way" real and safe (from `02` §7):

1. **Human-authored memory carries authority; agent-authored memory carries
   verifiability-and-decay.** Both live in one store, weighted by `created_by` + `confidence`.
2. **The human disposes on intent; Claude proposes.** Claude may write memories *about the
   user's intent/decisions*, but they are tagged `created_by='agent'` and surfaced to the
   user for confirmation. Claude must never silently overwrite a `created_by='user'` memory
   about the user's own intent. Promotion of an agent intent-memory to authoritative is a
   user action.
3. **Claude disposes on verified operation; the human can audit.** Claude's
   `confidence='verified'` findings about how the system behaves are the operational
   authority, but they're tagged as Claude's and are challengeable.
4. **Conflicts surface; they are not silently resolved.** When a `user` constraint appears to
   conflict with a `verified` agent observation, the store flags it for review rather than
   letting last-writer-wins. (Mechanically: a lightweight conflict marker / review queue,
   detailed in §8.)
5. **Writes are reviewable, not gated.** Claude writes freely while autonomous (`02` §8);
   the user gets a window (dashboard view + a "what Claude remembered" digest) to correct or
   veto. Review-after, not approve-before — correct for a high-volume fallible writer.

---

## 6. Loading model — small core + index + pull on demand

From `02` §3 and §1.3 (context budget is a budget, not a warehouse):

- **Always-loaded core (hard size budget):** who the user is, how they work, hard
  prohibitions (with reasoning), current project status. Target ≤ ~1.5–2k tokens. Generated
  *from Kaiba* (the canonical store), not hand-maintained in a divergent file. If it exceeds
  budget, it splits — the index absorbs the overflow.
- **Index, not contents:** one line per deeper memory/concept page (title + hook), so Claude
  can *pull* the relevant page when the task touches it. This is the existing `MEMORY.md`
  pattern, formalized and generated.
- **On-demand pull:** `kb_context` (briefings) → `kb_read` (full) already implements
  pull-on-demand; the design leans on it and adds trust signals to what it returns so Claude
  knows how much to trust each pulled item *before* acting.
- **Reasoning travels with the rule:** loaded prohibitions and decisions carry their `Why:`
  so Claude doesn't "improve" a decision into reintroducing the bug it prevented (`02` §2).

---

## 7. The compounding / decay mechanism (validated → adapted & renamed)

Verdict from `01-theory-validation.md`: all three coined mechanisms are **UNVERIFIED as named
patterns** — and "constraint-store versioning" actively collides with prior art (the CS
"constraint store" is *monotonic*: add-only, never decays — the opposite of what's intended).
But each underlying *idea* is sound and traceable to a primary source. So Kaiba **adapts and
renames**, assembling the mechanism from established parts rather than adopting the jargon.

**Kaiba's salience-and-supersession retention model** — four grounded mechanisms, none invented:

1. **Salience-ranked recall** (Generative Agents §4.1): at *read* time, rank memories by
   `relevance × (a·recency + b·importance) × confidenceWeight × outcomeWeight`. Recency is an
   Ebbinghaus-style decay computed **live** from `last_accessed_at` — nothing is stored as a
   decaying number; decay is a function evaluated at recall.
2. **Strengthen-on-recall = "pays rent"** (MemoryBank, R=e^(−t/S)): every recall bumps
   `access_count` and resets `last_accessed_at`. A memory that keeps getting used keeps its
   salience; one never used sinks. This is the causal model the validation demanded:
   **time decays, recall/utility arrests decay** — *not* "new items evict old ones."
3. **Importance, not recency, prevents the "everything is important" collapse.** A high
   `importance` memory (a hard prohibition, a load-bearing decision) stays salient for months
   unread; a low-importance aside fades fast. Set on write, adjustable on review.
4. **Outcome-tagged confidence** (adapted *decay-by-outcome*): when a memory proves wrong/right
   in use, `kb_memory_outcome` updates `outcome_score` and may downgrade `confidence`, surfaced
   at recall as lower salience + a flag. **Honest limit (validation):** the best research
   systems are ~55% accurate at detecting invalidated memories, so a low-outcome memory is
   **flagged-for-review — never silently deleted, never silently trusted.**

**Staleness** (adapted *reasoning-hash*, scoped to its real power): on write, compute
`deps_hash` = SHA-256 over an entry's *declared* inputs (source version, model/prompt version,
cited upstream doc ids). On recall, if a caller supplies current deps, a mismatch raises a
**stale** flag. This catches staleness only for **tracked** dependencies; it is structurally
blind to new external evidence (validation), so it is a cheap first-pass signal, **not** a
guarantee, and is never marketed as detecting all "context shifts." Semantic staleness
(re-verify against reality) stays a human/audit job.

**Supersession = demote, don't delete** (`02` §6 + STALE KEEP/STALE/REPLACE):
`kb_supersede(oldId, newId, reason)` sets `superseded_by`/`supersession_reason`. Superseded
memories leave default recall but stay queryable (`includeSuperseded`), so a refuted belief is
remembered *as refuted* and never silently relearned.

**Two guardrails the validation made non-negotiable:**
- **Correctness gate before persisting reasoning** (reasoning-over-facts caveat: *incorrect*
  stored reasoning measurably worsens outcomes). Agent-written reasoning enters at
  `confidence='inferred'` and is not promoted to `verified` without a check against ground truth.
- **Sycophancy guardrail** (ai-self-maintenance FALSE; +45% sycophancy from user-memory):
  user-asserted beliefs are stored as `created_by='user'` preferences/opinions, kept distinct
  from `confidence='verified'` facts, so stored memory can't quietly push Claude toward telling
  the user what they want to hear. Preferences are re-evaluated against outcomes, not reinforced
  on sight.

Every part traces to a primary source (Generative Agents, MemoryBank, LRU/LFU, STALE/CUPMem,
Bayesian confidence) — see `01-theory-validation.md` §"Design implications for Kaiba".

---

## 8. Tool & API surface changes (initial set)

> Note: this is the **initial** memory-tool set. Later rounds added `kb_consolidate`, `kb_session_brief`,
> `kb_memory_conflicts`, and `kb_workspace` (9 memory tools total / 26 overall) — see `04-roadmap.md` and
> `05-brain-research.md`. The list below is the original five.


**New MCP tools** (added in `tools.js`, the single source for stdio + HTTP):
- `kb_remember` — write a memory: `content, reasoning?, type?, importance?, confidence?, tags?,
  project?, deps?`. `created_by` inferred by transport ('agent' on MCP/REST, 'user' on
  dashboard); agent intent-memories enter `review_status='pending'`. Computes `deps_hash`.
- `kb_recall` — salience-ranked retrieval (§7.1) returning the trust signals (`created_by`,
  `confidence`, `importance`, `outcome_score`, `stale` flag, age) so Claude calibrates before
  acting; **bumps `access_count`/`last_accessed_at`** on returned hits ("pays rent"). Supports
  `includeSuperseded`.
- `kb_memory_outcome` — record `helped|burned` for a memory id → updates `outcome_score`,
  may downgrade `confidence` (§7.4).
- `kb_supersede` — `oldId, newId, reason` → demote-don't-delete supersession (§7).
- `kb_memory_review` *(admin)* — list `review_status='pending'` agent memories; `accept|reject`
  — the human audit loop (§5; validation made this load-bearing, not optional).

**Extend existing:**
- `insertDocument` (`db.js:136`, the keystone chokepoint) — accept/persist
  `created_by, author_detail, confidence, reasoning, importance, deps_hash, review_status`;
  default sensibly; fully backward-compatible.
- `kb_search` / `kb_read` / `kb_context` — surface the trust signals in their output so every
  read path, not just `kb_recall`, lets Claude see provenance/confidence.
- Fix the latent `kb_ingest` tags bug (`tools.js:91` passes `tags` positionally into the
  `{tags}` opts object → tags silently dropped) while touching this path.

**REST (`routes/v1.js`):** mirror the memory surface — `POST /api/v1/memory` (remember),
`GET /api/v1/memory/recall`, `POST /api/v1/memory/:id/outcome`, `POST /api/v1/memory/supersede`,
and the review queue `GET/POST /api/v1/memory/review`. API-key/OAuth callers are agents
(`created_by='agent'`); cookie-auth dashboard writes are `'user'`.

**Dashboard:** a minimal "Memory" view listing memories with provenance/confidence and an
accept/reject control for the review queue. (The REST review queue alone proves the loop
end-to-end for criterion 4; the dashboard view is the human-facing polish on top.)

---

## 9. Migration & backward compatibility (non-negotiable)

- All new columns nullable/defaulted; added via the established idempotent migration pattern.
- Legacy rows labelled honestly (`created_by='system'`, `confidence='unverified'`).
- FTS triggers (`db.js:49-64`) only index title/content/tags, so new columns don't disturb
  search. Verified.
- No behavior change for existing read paths unless a caller opts into the new fields.
- The gate (`node --test tests/*.test.js`) must stay green; new tests added per §10.

---

## 10. Verification plan (how we prove it works, per criterion 4)

- Unit: new columns persist and round-trip through `insertDocument`/`getDocument`; defaults
  applied to legacy rows; trust signals surface through read tools. (Pattern: in-memory DB +
  `_setTestDb`/`_resetDb`, as in `tests/db.test.js`, `tests/tools-handlers.test.js`.)
- End-to-end in the **real system** (not just unit tests): start the server, write a memory
  as "agent", read it back through MCP/REST and confirm trust signals present; write as
  "user" via dashboard path; demonstrate a supersession + that the superseded item leaves the
  default view but stays queryable.
- Self-check interval: after each build sub-phase, an independent verifier subagent checks the
  diff against this spec and the goal criteria. Discrepancies loop back before proceeding.

---

## 10b. Build constraints resolved from the pre-build adversarial review

An independent reviewer checked this design against the validation *and the actual codebase*
before the build (verdict: BUILD WITH FIXES). The resolutions below are now binding:

1. **Provenance is decided at the call site, NOT "inferred by transport."** The shared
   `tools.js` handler only receives parsed args — it cannot see transport/auth. So `created_by`
   defaults to `'agent'` in the tool/REST (`v1.js`, api-key/OAuth) paths and is set to `'user'`
   at the dashboard route (`api.js`, cookie auth). The db layer already takes `created_by`
   as an explicit argument. (Resolves the one design-breaking issue.)
2. **No non-constant ADD COLUMN defaults.** SQLite throws `Cannot add a column with non-constant
   default` on a non-empty table (it silently passes on an empty one — so a test must seed a
   row *before* migrating). `verified_at`/`last_accessed_at` stay nullable-no-default; all other
   new columns use constant defaults. (Implemented in `db.js`.)
3. **`insertDocument` coalesces new fields in JS** — once a column is named in the INSERT its
   DEFAULT no longer fires, so bound `undefined` would store NULL. (Implemented.)
4. **Trust signals are added to the explicit SELECT lists** (`searchDocuments`, `listDocuments`,
   and the `kb_context` mapper); `getDocument` is `SELECT *` and needs no change. (db.js done;
   `kb_context` in this pass.)
5. **Salience is a design choice, stated honestly:** recency = `exp(−ln2 · Δh / 72h)` (3-day
   half-life), relevance = FTS rank *position* normalized to (0,1] (avoids raw BM25 being
   negative/unbounded), composed multiplicatively with confidence/outcome weights. Generative
   Agents validates the additive `recency+importance+relevance` core; the multiplicative
   confidence/outcome layering is Kaiba's own composition, not separately evidenced. (Implemented.)
6. **Demotion scope:** supersession/rejection demote from the **memory read path (`kb_recall`)**;
   raw `kb_search`/`kb_read` remain exhaustive (you can always still find anything). This keeps
   "demote, don't delete" honest without making general search lossy.
7. **`kb_memory_review` is admin-gated** (added to `ADMIN_ONLY_TOOLS`).
8. **A dashboard user-write + review route exists** (`api.js`, cookie auth → `created_by='user'`)
   so the *user* half of the bridge is exercisable end-to-end, not just the agent half.
9. **The `kb_ingest` tags bug is fixed** (`tools.js` → `ingestText(title, content, { tags })`).
10. **Dogfood criterion 5:** this design's own decisions and the build outcome are persisted via
    `kb_remember` into Kaiba + `.agent-memory`, so the bridge's first real memories are about
    itself.

## 11. Explicitly NOT doing (scope discipline)

- Not replacing FTS5/embeddings or the search architecture.
- Not migrating off SQLite or adding a vector DB.
- Not rewriting the file-based surfaces away — they become projections/writers, not islands.
- Not building approve-before-write gating (contradicts `02` §8; review-after instead).
- Not auto-deleting anything (demote, don't delete).
- Not inventing un-grounded mechanisms — §7 adopts only what survives validation.
