# 08 — Cross-device sync (vault + memory brain) — SPECIFICATION

Status: building (branch `rebuild/memory-spine`). Builds on the spine rebuild (`07-spine-rebuild.md`).

## Goal

A user runs Kaiba on two machines (laptop = primary, desktop). Both should see the same knowledge:

1. **Vault notes** (Obsidian markdown) — shared so either machine can read/index them.
2. **Memory brain** (the `memories` table — the Claude⇄User layer) — synced so a memory created or
   corrected on one machine reaches the other.

"Vault memories" in the user's request = the `memories` brain (the durable Claude⇄User layer), synced
**alongside** the shared vault. Vault notes are `documents`; the brain is `memories`. Both must travel.

## Two data classes, two mechanisms

| Data | Source of truth | Transport | Per-machine state |
|------|-----------------|-----------|-------------------|
| Vault notes (markdown) | the files | **Google Drive** folder sync | each machine indexes into its own `kb.db` (`kb vault reindex`) |
| Memory brain (`memories`) | the union of both machines | **per-machine NDJSON files** in a shared Drive dir, merged by `kb memory-sync` | each machine keeps its own `kb.db`; NDJSON is the wire format |

### HARD RULE — never sync `kb.db` itself
SQLite in a cloud-sync folder with two machines = corruption (WAL + partial syncs + concurrent writers).
`kb.db` stays in `~/.knowledge-base/` (local, NOT in Drive). The vault files are shared; the index is
derived and rebuildable. The brain is shared via an explicit merge, never by copying the db file.

## Vault sharing (procedure, not code)

- Vault currently lives in a **local, unsynced** folder on the laptop.
- Move it **once** into Google Drive (`<Drive>/kaiba-sync/vault/`), so Drive replicates it to the desktop.
- On each machine: set `OBSIDIAN_VAULT_PATH` to the synced path, then `kb vault reindex`.
- `.obsidian/` config travels too; simultaneous edits on both machines can create Drive conflict copies —
  acceptable for not-at-the-same-time use; Obsidian Sync / git are the upgrades if needed. (Document, don't build.)

## Memory sync — design (this is the code deliverable)

### Identity & transport
- **Identity = `content_hash`** (sha256[:32] of content). Portable across machines; local `id` is NOT.
- **Per-machine export files** in the shared dir: `kaiba-brain.<host>.ndjson` (host = sanitized `os.hostname()`).
  Each machine **owns and overwrites only its own file** → no concurrent-write conflicts on a single shared
  file. `kb memory-sync` = "import everyone else's file, then (re)write my own".
- Shared dir default: `KB_BRAIN_SYNC_DIR` env, else `<homedir>/My Drive/kaiba-sync/brain`.

### Trust domain — sync ≠ import
- Existing `importNDJSON` is the **untrusted foreign** path: forces `pending`, caps confidence at `inferred`.
  Correct for a brain you didn't author. KEEP IT UNCHANGED.
- `memory-sync` is the **trusted same-owner** path: both files are the user's own machines, so it PRESERVES
  `review_status`, `confidence`, provenance, outcomes. Trust is asserted by the user pointing sync at their
  own Drive dir (a local CLI choice, same as choosing to import).

### Portable supersession (the subtle part)
`superseded_by` is a local row id → meaningless on another machine. So:
- **Export** resolves `superseded_by` (id) → `superseded_by_hash` (the `content_hash` of the superseding row).
- **Merge** inserts all rows first, then a second pass resolves `superseded_by_hash` → local id.
- Result: a correction made on machine A (e.g. #5→#9) propagates as a supersession on B, instead of B
  silently keeping the wrong memory or relearning it. This is the whole reason a naive import is insufficient.

### Convergent field merge (when both sides already have a hash)
Merge must be a **commutative, associative, idempotent** function per field (a join-semilattice) so the result
is the same regardless of sync order or how many times you run it (eventual consistency). Rules:

| Field | Merge rule | Rationale |
|-------|-----------|-----------|
| `review_status` | max over `rejected > accepted > pending` | a rejection anywhere is terminal — never silently relearn a refuted belief. (Supersession is NOT a `review_status`; it travels via `superseded_by_hash` below.) Unknown/garbled values never win — a valid value always beats an out-of-enum one. |
| `confidence` | **min** over `verified > asserted > inferred > unverified` (i.e. most cautious) | a burn (which lowers confidence) anywhere must not be undone by sync |
| `outcome` (int) | if either < 0 → `min`; else `max` | preserve a burn signal; otherwise keep the strongest positive evidence |
| `importance` | `max` | sync never downgrades importance |
| `use_count` | `max` | recency/“pays rent” signal, monotone |
| `last_used_at` | latest (max timestamp) | feeds recency salience |
| `created_at` | earliest (min timestamp) | true origin time |
| `superseded_by_hash` | first non-null; if conflicting non-nulls, keep local + log | supersession propagates; conflicts are rare and surfaced |
| `content`,`reasoning`,`kind`,`created_by`,`project` | keep local (identity-bound to the hash) | same hash ⇒ same content; these don't diverge meaningfully |

A field whose merge isn't one of {min, max, latest, lattice-max} must not be added without re-checking convergence.

### Architecture (pure core + IO shell — for testability)
- `mergeMemoryRecords(localRecords, incomingRecords)` → **pure**, no db: returns `{merged, actions}`.
  All correctness (lattice props, idempotency, supersession portability, non-destruction) is tested here.
- `exportSyncRecords({project})` → reads local db → array of portable records (incl. `content_hash`,
  `superseded_by_hash`).
- `syncMemories({dir, project, dryRun})` → IO shell: read other machines' files → `mergeMemoryRecords` →
  apply diff to db (insert new born-indexed; update merged fields; resolve supersession pass 2) → rewrite own
  file. Returns `{machines, pulledNew, pulledUpdated, pushed, dryRun}`. Best-effort embeddings on new rows.

### CLI contract (what the laptop runbook targets)
```
kb memory-sync [--dir=<path>] [--project=<p>] [--dry-run]
```
- default dir = `KB_BRAIN_SYNC_DIR` or `<homedir>/My Drive/kaiba-sync/brain` (created if missing)
- `--dry-run` reports counts, writes nothing (not db, not own file)
- registered in `bin/kb.js` dispatch + usage text

## Requirements (verification checklist)
- **R1 Bidirectional**: a memory on either machine reaches the other after each side syncs.
- **R2 Convergent**: after both sync, both hold the same logical set (union); field values agree.
- **R3 Idempotent**: re-running sync with no changes writes nothing new (dedup by `content_hash`).
- **R4 Non-destructive**: sync never deletes a local-only memory, never downgrades importance/use, never
  resurrects a `rejected`/`superseded` one.
- **R5 Trust-preserving**: status/confidence/provenance survive a sync round-trip (unlike untrusted import).
- **R6 Safe transport**: only NDJSON crosses Drive; `kb.db` never leaves `~/.knowledge-base`.
- **R7 Portable supersession**: a supersede on A becomes a supersede on B (no id leakage, no relearn).
- **R8 Order-independent**: merge result is identical regardless of which machine syncs first or how often.

## Verification method (run every milestone)
1. **Pure-core test** `test/memory-sync.test.mjs` (node:assert, no db) asserting R1–R8 against
   `mergeMemoryRecords` — run after: core written, after CLI wired, after any merge-rule edit.
2. **Dry-run integration** against the real db with a synthetic "other machine" file (no writes).
3. **Sub-agent adversarial verification** at the design stage and at completion: read THIS spec + the code +
   the test, try to refute convergence/non-destruction/supersession-portability and find spec-vs-code drift.

## Out of scope (restraint — see 07)
No CRDT vector clocks, no real-time sync daemon, no automatic conflict-copy resolution, no kb.db replication.
Sync is explicit (`kb memory-sync`), optionally wired into the spine later if recall data shows it pays rent.
