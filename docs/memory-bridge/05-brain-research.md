# 05 - Brain-inspired architecture research (design input)

> Deep, cited, adversarial research mapping how a real brain's memory + architecture works onto Kaiba.
> Produced by the `kaiba-brain-research` workflow (7 angles x [1 researcher + 2 skeptics] + 1 synthesist).
> Crucially separates established neuroscience from sound-engineering from analogy-only — read the
> grounding column and honesty section before building. Structured data in `05-brain-research.data.json`.
> Generated 2026-06-14.

---

The code claims in the research check out: single global `SALIENCE` const (db.js:420), flat `±1` outcome with one-notch demotion (db.js:657-671), deterministic `sort().slice()` recall (search.js:45-46, 80-86), no `novelty`/`predicted_outcome`/`storage_strength`/`memory_system` columns, and `superseded_by`/`findSimilarMemory`/`confidence` ladder all exist. The research's diagnosis is accurate. Now I'll synthesize the report.

---

# Kaiba v-Next: Design-Input Report — Brain-Inspired Memory Architecture

*Lead-architect synthesis of six research angles (memory-systems, consolidation, forgetting-plasticity, attention-salience, predictive-bayesian, non-determinism, agentic-architecture), each adversarially voted. Written from the user's perspective: this is a two-way user↔Claude memory bridge, and the goal is to make it function more like a real brain — layered memory, controlled non-determinism, and a transparent collection of specialised internal agents.*

**Verification note:** Every "current state" claim below was checked against source, not memory. Confirmed: one global salience constant (`src/db.js:420` — `recencyHalfLifeHours:72, wRecency:0.4, wImportance:0.6`); flat `±1` outcome with single-notch confidence demotion (`db.js:657–671`); deterministic `sort().slice()` recall (`src/embeddings/search.js:45–46, 80–86`); confidence ladder + `superseded_by` + `findSimilarMemory` already present. No `memory_system`, `storage_strength`, `novelty`, or `predicted_outcome` columns exist. The diagnosis in the research is sound.

---

## Brain → Kaiba mapping

| Brain mechanism | Grounding | Skeptics: held? / mapping sound? | Concrete Kaiba change |
|---|---|---|---|
| **Multiple dissociable memory systems** (Squire taxonomy; episodic vs semantic, Tulving; working, Baddeley) | Established | Taxonomy held ✓ / sound ✓ (off-by-one: salience const is db.js:420 not 419) | Add `memory_system` column {working, episodic, semantic, procedural}; per-system weight table replacing the global `SALIENCE` const |
| **Complementary Learning Systems** — fast hippocampus + slow neocortex, interleaved replay avoids catastrophic interference (McClelland 1995) | Established (framework) | Held ✓ / sound ✓ | Two-tier `memory_tier`; offline interleaved consolidator (episodic→semantic) reusing `superseded_by` for `consolidated_into` |
| **WM = activity-based persistent firing, NOT weight-based** (Baddeley substrate) | **Contested** (activity-silent / synaptic theories, Stokes/Mongillo) | Held ✗ (over-claimed) / sound ✓ | WM as TTL scratch buffer (cap ~7, hard eviction) — sound caching regardless of the firing debate |
| **Systems consolidation = hippocampus disengages over time** (Standard Model) | **Contested** (Multiple Trace Theory; hippocampus may stay required) | Held ✗ / sound ✓ | "Demote episodic after consolidation" is fine engineering; do **not** sell as settled neuroscience |
| **Reconsolidation** — retrieval makes a memory labile, re-stabilised by protein synthesis (Nader 2000) | Established core / **boundary conditions contested** (human replication failures) | Held ~ / partly redundant | Labile window on contradicting recall + `prior_versions` table + review gate. Reuses existing machinery; net-additive but incremental |
| **Two-strength memory** — storage strength (durable) vs retrieval strength (accessible now); forgetting is adaptive (Bjork) | Emerging (psych model, behaviourally robust) | Held ✗ as "neuroscience" / sound ✓ (FSRS-validated) | **Split salience**: persist `storage_strength`; compute retrievability dynamically; half-life scales with storage strength |
| **Active/dedicated forgetting machinery** (dopamine→Rac1→cofilin; "race" between acquisition & forgetting) | **Contested** (robust in *Drosophila*, partial/unreplicated in mammals) | Held ✗ / sound ✓ | A background Janitor agent (decay + fuse near-dups + propose prunes). Justify as compaction, not as the Rac1 pathway |
| **Retrieval-induced forgetting** — recalling A suppresses competitor B (Anderson 1994) | Emerging (effect replicates; inhibition mechanism debated) | Held ~ / sound, novel | Small retrievability penalty on retrieved-but-not-selected same-project competitors; logged in `reasoning` |
| **Dopamine = reward-prediction-error** (Schultz 1997) | Established | Held ✓ / sound ✓ | `predicted_outcome` + PE = actual − predicted; replace flat ±1 with PE-scaled, bidirectional update |
| **Precision-weighted belief updating** (Friston free-energy) | **Theory / contested** (near-unfalsifiability critiques) | Held ✗ / sound ✓ | Treat `confidence` as precision; update magnitude ∝ Π·PE; learn confidence from outcome variance |
| **Norepinephrine = global gain/temperature; novelty/unexpected-uncertainty** (Aston-Jones; Yu & Dayan) | Emerging (gain established; novelty channel partial) | Held ~ / sound ✓ | `novelty` column = 1 − max cosine to existing; session-level recall temperature ("arousal") knob |
| **Salience network switch** (anterior insula toggles DMN↔CEN; Menon) | Emerging/contested (causal role) | Held ✗ / **mapping weak** | A "switch agent" choosing memory-lean vs task-fresh mode — flagged as a thin reskin of a relevance threshold |
| **Pulvinar/thalamic gating** — boost attended ~4×, suppress neighbours (Purushothaman 2012) | Established | Held ✓ / sound ✓ (needs guardrails) | Write-time lateral inhibition: boost new memory, demote nearest competitor |
| **Neural sampling / stochastic resonance / generative replay** (sampling hypothesis; SFMA softmax replay) | Emerging→Model/analogy | Held ✗ as "established" / core sound ✓ | Softmax/temperature recall, MMR diversity, inhibition-of-return, RNG-seed audit |
| **Key–value memory; storage rarely the bottleneck, retrieval is** (Gershman, Fiete & Irie 2025) | Emerging (biological impl. open) | Held ~ / sound ✓ | embedding = KEY (address), `summary` = VALUE (content); never hard-delete (defend as soft-delete hygiene) |
| **Global Neuronal Workspace** — winner ignites, broadcast over long-range cortex (Dehaene; Baars) | **Contested** (2025 Cogitate adversarial collab undercut PFC-ignition signature) | Held ✗ / sound ✓ as a design pattern | `workspace` (blackboard) table; each agent writes {agent, doc_id, score, vote, reasoning}; ignition threshold for broadcast |
| **Society of specialised modules** (Minsky; blackboard/Hearsay-II) | Analogy-only (AI design pattern) | n/a / sound ✓ | The whole specialised-agent framework below |
| **Basal-ganglia actor-critic gating** of PFC working memory (O'Reilly & Frank PBWM) | Model (influential, not textbook fact) | Held ~ / sound ✓ | BG-gate agent: bandit over the ignition threshold using `outcome_score` as the dopamine signal |
| **Amygdala emotional tagging** — retroactively strengthens related memories (Dunsmoor 2015) | Established | Held ✓ / sound ✓ | Importance/salience tagging at write-time (maps to existing `importance`) |
| **Cerebellar forward model** — predict-then-error (Wolpert 1998) | Established (motor); extension to cognition emerging | Held ~ / sound ✓ | Critic/verifier agent: predict outcome of a memory, downgrade confidence on miss |

---

## Ranked brain-inspired increments

Ordered by **leverage × feasibility × evidence**. ✅ = survives skeptics on engineering merit independent of the brain story. ⚠️ = analogy-driven / contested — keep visible, scope tightly.

### 1. Two-strength memory: split salience into storage vs retrievability ✅ *(highest)*
**Build:** Add `storage_strength REAL` (monotonic, durable trace). Compute retrievability *dynamically* at recall: `R = exp(−Δt / (τ · storage_strength))`. Replace `salience = relevance × (recency + importance) × confidence × outcome` with `salience = relevance × R × confidence × outcome`, and make half-life **scale with storage_strength** instead of the fixed 72h const (`db.js:420`).
**Why:** This is the single deepest structural fix. The current flat 72h half-life and flat strengthen-on-recall (`access_count + 1`, no diminishing returns) means a memory recalled twice in five minutes looks as "learned" as one earned over months. Grounded in FSRS/Half-Life-Regression — a *shipped, validated* operationalisation (Duolingo ~45% prediction-error cut), so it stands without the Bjork psychology.
**Advances the second brain:** Memories now have a durable identity that survives disuse — the prerequisite for "demote-don't-delete" to mean something and for spaced re-surfacing to work.

### 2. Layered memory systems: make `memory_system` a first-class column ✅
**Build:** Add `memory_system` {working, episodic, semantic, procedural} + a per-system weight table. Derive initial values from `doc_type`/`source`. (See full architecture below.)
**Why:** The keystone. Today one `doc_type` string and one salience formula conflate every memory type — exactly the brain's central insight (different systems, different rules) is what's missing. Everything else hangs off this column. Converges with CoALA and 2024–26 agent-memory surveys, so it's a recognised field frame, not a private analogy.
**Advances the second brain:** Lets episodic (time-bound experience), semantic (your stable preferences/facts), and procedural (skills that pay rent) be encoded and retrieved by *different* rules.

### 3. Prediction-error-gated outcome updates ✅
**Build:** Add `predicted_outcome REAL` (= salience at recall time). On outcome, compute `pe = actual(±1) − predicted` and replace the flat ±1 in `recordMemoryOutcome` (`db.js:657`) with a **PE-scaled, bidirectional** update. Make confidence-update magnitude ∝ `Π · pe` (Π = confidence-as-precision); learn confidence from the running variance of a memory's outcomes.
**Why:** Kaiba has the *outcome* half of a reward-prediction-error loop but not the *prediction* half. Uniform reinforcement on every neutral recall inflates trust. This is plain TD / online-credit-assignment + inverse-variance weighting — sound regardless of dopamine. Dopamine RPE is the one *fully established* brain pillar here.
**Caveat (skeptic-flagged):** Don't overload `confidence` for two roles (recall gain *and* update gain) — add a separate precision field if they diverge.

### 4. Two-rate CLS consolidation with interleaved replay ✅
**Build:** Reframe `consolidate.js` as a scheduled **offline** consolidator. Instead of one-shot extract→dedupe, sample a batch that **interleaves** new pending episodics with a sample of old consolidated semantics (clustered by embedding/project); ask the LLM to extract the durable cross-episode generalisation → write a `semantic` row linked via `derived_from`; set the source episodic `consolidated_into` (reuse `superseded_by`). Move "a little" per pass.
**Why:** Interleaving is what prevents a new episode silently overwriting a hard-won general rule (catastrophic interference). Grounded in Deep Generative Replay / Brain-Inspired Replay (van de Ven 2020) — real ML, brain-independent.
**Caveat:** "Hippocampus disengages" (demote episodic) is the contested Standard-Model leg — implement it as a retention policy, not a neuroscience claim.

### 5. Novelty channel + diversity-aware retrieval (MMR) ✅
**Build:** `novelty REAL` = 1 − max(cosine to existing) computed at write (infra already exists in `findSimilarMemory`). Add an MMR pass over stored embeddings at recall so results are complementary, not 5 paraphrases of one memory.
**Why:** Standard outlier detection + 25-year-old IR technique (Carbonell & Goldstein 1998). Fills a real gap: Kaiba weights relevance/recency/importance/confidence/outcome but has no novelty term and returns near-duplicates.

### 6. Prioritised replay = consolidation order ✅
**Build:** `replay_priority REAL` = importance × |outcome_score| × surprise(1−cosine-to-semantics). Consolidate high-priority first; re-replay high-importance semantics periodically (spaced rehearsal). Don't consolidate FIFO.
**Why:** Literally Prioritized Experience Replay (Schaul 2015), a SOTA-validated ML result. Surprise-weighted SWR replay is established brain support.

### 7. Controlled non-determinism: temperature recall + RNG-seed audit ✅ (core) / ⚠️ (rationale)
**Build:** `sampleFromSalience(scored, {limit, temperature, λ})` via softmax + Gumbel-top-k (sample without replacement). **T=0 reproduces today's exact top-k** (backward compatible). Accept an optional RNG seed, store it in the recall log for replay.
**Why:** Principled weighted sampling (Kool 2019). The *engineering* (temperature, MMR, inhibition-of-return, seed) is sound; the *brain rationale* ("biology is noisy") is the weak part — keep it as a config knob, default deterministic on verified/high-importance critical paths. (See dedicated section.)

### 8. Lateral inhibition at write-time (pulvinar gating) ✅ *(with guardrails)*
**Build:** On each new memory, boost its importance and apply a small retrievability demotion to the single nearest competing neighbour (reuse `superseded_by` machinery only when truly a supersession; otherwise a soft retrievability penalty).
**Why:** Pulvinar gating is established; the store sharpens rather than bloats. **Guardrail:** auto-demoting nearest-neighbour on *every* write risks demoting distinct-but-similar memories — gate by a high cosine threshold + log.

### 9. Reconsolidation-on-recall (labile window) ⚠️ *(partly redundant)*
**Build:** When recall surfaces a memory whose session outcome contradicts it, set `review_status='labile'`, snapshot old text to `prior_versions`, route a proposed update to the existing review queue.
**Why:** Net-additive versioning + human gate. But skeptics note it **largely re-skins** machinery Kaiba already has (strengthen-on-recall, supersession, confidence-downgrade-on-burn, review queue). Build it as git-style versioning, not as a novel mechanism. **Drop** the "edit lapses after N recalls" sub-rule — it's an invented mechanism with no engineering rationale that risks silently dropping correct updates.

### 10. Retrieval-induced forgetting ⚠️ *(novel, cheap, speculative)*
**Build:** When recall selects A over a high-cosine same-project competitor B, apply a small retrievability penalty to B; log in `reasoning`; gate behind review.
**Why:** The single most novel/lowest-cost differentiator — no mainstream agent memory ships it. But the inhibition mechanism is contested and it risks over-suppressing useful related memories. Ship behind logging + offline eval, not as a default.

### 11. Salience-switch agent (DMN↔CEN) ⚠️ *(weakest — defer)*
**Build:** An agent deciding "lean on memory" vs "treat task as fresh."
**Why deferred:** Both skeptics on two angles independently flagged this as a thin reskin of a relevance threshold; adding an LLM agent + latency + non-determinism for a binary route a threshold handles. The salience-network causal-switch neuroscience is also contested (and took 2025 Cogitate damage to the parent GNW theory). **Implement as a threshold/config, not an agent.**

---

## Layered memory architecture

Map the brain's four systems onto Kaiba with **one new column doing the heavy lifting** plus per-system rules. This is the keystone everything else depends on.

### Schema
```
ALTER documents ADD memory_system TEXT;   -- {working, episodic, semantic, procedural}
ALTER documents ADD memory_tier   TEXT;   -- {episodic(fast), semantic(slow)} within declarative
ALTER documents ADD event_time    DATETIME;       -- episodic: when it happened
ALTER documents ADD context_json  TEXT;           -- episodic: project, session_id, files touched
ALTER documents ADD storage_strength REAL;        -- durable trace (increment 1)
ALTER documents ADD success_rate  REAL;           -- procedural: helped/(helped+burned)
ALTER documents ADD consolidated_into INTEGER;    -- episodic→semantic provenance (reuse superseded_by)
ALTER documents ADD derived_from  TEXT;           -- semantic: JSON array of source episodic ids
```
Replace the global `SALIENCE` const (`db.js:420`) with a **per-system weight table**:

| System | Brain analog | Encoding | Retrieval weighting | Lifecycle |
|---|---|---|---|---|
| **WORKING** | PFC persistent activity | Per-session/per-project scratch; cap ~7 rows, TTL minutes–hours | **Not in recall ranking** — hard eviction | Never persisted to long-term; the session brief is the "central-executive read" of this buffer |
| **EPISODIC** | Hippocampus (fast, sparse, one-shot) | One-shot write, **no dedupe gate**; keep `event_time` + `context_json` | High recency-weight + context-cue match | Fast tier; demoted (`consolidated_into`) after consolidation |
| **SEMANTIC** | Neocortex (slow, distributed) | Deduped at write via `findSimilarMemory`; generalised across episodes | Importance/relevance over recency (today's 0.4/0.6 split is already semantic-shaped) | Slow tier; durable; periodically re-replayed to stay stable |
| **PROCEDURAL** | Striatum / basal ganglia (habit) | Skills/bug-fixes; `success_rate` = helped/(helped+burned) | `outcome_score` + `success_rate` **dominate**; recency barely decays | A skill earns trust by working repeatedly |

### Promotion: episodic → semantic via consolidation (the CLS pipeline)
1. **Capture (fast/episodic):** session captures land as `memory_system='episodic'`, `memory_tier='episodic'`, `confidence='asserted'`, high recency weight, no dedupe — the hippocampal one-shot store.
2. **Offline replay (scheduled, "sleep"):** the Consolidator samples episodics **stochastically by `replay_priority`** (not FIFO, not strict top-k), **interleaves** them with a sample of existing semantics (clustered by embedding/project), and asks the LLM to extract the durable cross-episode generalisation.
3. **Write semantic + link provenance:** new row `memory_system='semantic'`, importance up, confidence up, recency-weight down, `derived_from=[episodic ids]`.
4. **Demote source:** set the episodic's `consolidated_into=<semantic_id>` (reuse `superseded_by`). It leaves default recall but stays queryable — mirrors time-dependent hippocampal disengagement (engineered as a retention policy, **not** asserted as settled neuroscience).
5. **Spaced re-rehearsal:** periodically re-replay high-importance semantics to refresh retrievability (ties to the existing spaced re-surfacing work).

This turns the current single extract→dedupe→pending pass into a layered fast-write / slow-generalise system — the proven antidote to catastrophic interference, and the cleanest home for controlled non-determinism (step 2).

---

## Controlled non-determinism

**Goal:** move off strict deterministic `sort().slice()` (verified at `search.js:45–46, 80–86`) toward salience-weighted probabilistic recall — **bounded, transparent, and reproducible on demand**.

### Mechanism (the four sound pieces)
1. **Temperature sampling.** Convert salience to a softmax `p_i = exp(salience_i / T) / Σ exp(salience_j / T)`; sample `limit` items **without replacement** via Gumbel-top-k.
   - **`T = 0` reproduces today's exact top-k** — fully backward compatible.
   - `T > 0` widens sampling so high-storage / low-retrievability memories occasionally resurface (the "reminiscence" effect).
   - Expose `temperature` on `kb_recall` / `kb_session_brief` and an env default `KB_RECALL_TEMPERATURE`.
2. **Diversity (MMR).** After scoring, `select_i = argmax[λ·salience_i − (1−λ)·max_{j∈selected} cosine(emb_i, emb_j)]` so recall returns complementary memories, not paraphrases. (Standard IR; no brain story needed.)
3. **Inhibition-of-return.** Multiply salience by a decaying `[1 − IoR]` term using `last_accessed_at` / `access_count` so a just-surfaced memory is transiently suppressed and one row doesn't dominate every brief.
4. **Stochastic consolidation.** Apply temperature **only** to the *offline* consolidator's episode selection (step 2 of the pipeline) so cross-links vary run-to-run — this is where non-determinism earns its keep, scoped away from user-facing fact lookups.

### Tradeoffs and how to keep it bounded + transparent
| Risk | Mitigation |
|---|---|
| **Reproducibility / debuggability** — "why did it return X this time?" | Accept an optional RNG **seed**; store it + the temperature in the recall log / `reasoning` field. Any stochastic recall is exactly replayable for audit. |
| **Eval instability** | Default **T=0** (deterministic) on verified/high-importance critical paths; raise T only for exploratory contexts (synthesis, weekly review). |
| **Surfacing wrong/stale memories** | Temperature sampling is over *salience*, which already includes confidence × outcome — low-trust memories stay improbable. Bound max T. |
| **Over-engineering / metaphor creep** | **Drop the stochastic-resonance "noise floor"** (both skeptics: no genuine IR analog; temperature already subsumes "let weak items surface"). Don't build a "Sampler/Explorer agent persona" — a context-dependent temperature config achieves the same without the ceremony. |

**Bottom line:** ship temperature + MMR + inhibition-of-return + seed-logging. Treat temperature as a config knob, not a neuroscience claim. Default deterministic; opt into stochasticity per context.

---

## Specialised-agent framework (transparent orchestration)

The north-star ask. Turn the monolith into a **transparent blackboard of single-responsibility agents**, each writing auditable proposals to one shared workspace. Crucially: this is justified by the **Society-of-Mind / Hearsay-II blackboard** AI pattern (it would stand on software-engineering merit alone) — the brain-region labels are *inspiration*, not load-bearing proof. Most agents *reuse existing columns*; few need new code.

### The workspace (Global-Workspace-style broadcast, made literal)
```
CREATE TABLE workspace (
  cycle_id    TEXT,         -- one recall/consolidation cycle
  agent       TEXT,         -- which agent proposed
  doc_id      INTEGER,
  score       REAL,
  vote        TEXT,         -- broadcast | suppress | flag | propose
  reasoning   TEXT,         -- human-readable
  created_at  DATETIME
);
```
Each cycle is a row-group. Agents propose; only memories crossing an **ignition threshold** get broadcast into the prompt. Every proposal + vote + reasoning is inspectable and overridable by the human — extends the existing propose/dispose review queue. **This is the transparency mechanism: the human reads the blackboard.**

### The agents

| Agent | Single responsibility | Inputs → Outputs | When it runs | Brain analog | Status |
|---|---|---|---|---|---|
| **Librarian** (Retriever) | Address & fetch by meaning | query → candidate set, each with `cosine(query-key) × salience` | Every recall | Hippocampal key–value (embedding=KEY, `summary`=VALUE) | ✅ sound |
| **Salience Router** | Score & gate ignition | candidates → softmax/temperature ranking; mark which cross threshold | Every recall | Salience-detection + GNW ignition | ✅ core sound (ignition theory contested) |
| **Consolidator** | Episodic → semantic generalisation | high-priority episodics + sampled semantics (interleaved) → new semantic rows + provenance | Offline (cron, "sleep") | CLS slow system + DMN/SWR replay | ✅ sound (replay-causation correlational only) |
| **Conflict-Resolver** | Detect contradiction, demote-don't-delete | new memory + existing → `superseded_by` set, route to review | Write-time | PFC control | ✅ sound |
| **Critic/Verifier** | Predict outcome, score realised PE | memory + action → updated `outcome_score`, confidence downgrade on miss | Post-session | Cerebellar forward model | ⚠️ analog loose; reduces to "store outcome + tune weight" |
| **Janitor/Forgetter** | Decay, fuse near-dups, propose prunes | all memories → recomputed retrievability, fused rows, prune proposals | Offline, **parallel** to consolidator | "Dedicated forgetting machinery" | ✅ as compaction (Rac1 pathway contested) |
| **BG-Gate** | Learn the ignition threshold | broadcast history + `outcome_score` (reward) → adjusted threshold/router weights | Periodic | Basal-ganglia actor-critic (PBWM) | ⚠️ model, not fact; risk: overfit on sparse signal |
| **Tagger** | Importance/novelty at write | new memory → `importance`, `novelty` | Write-time | Amygdala emotional tagging | ✅ established |

**Deliberately NOT built as agents:** the **Salience-Switch (DMN↔CEN)** — implement as a relevance threshold, not an LLM agent (skeptic-rejected on two angles). And no "Sampler/Explorer persona" — temperature is a config knob.

### Orchestration flow
1. **Recall cycle:** Librarian fetches → Tagger/Salience Router score → Janitor applies retrievability/IoR penalties → Router runs ignition (softmax+temperature, MMR diversity) → memories above threshold broadcast to the prompt. All proposals logged to `workspace`.
2. **Write cycle:** Tagger scores importance/novelty → Conflict-Resolver checks contradictions → lateral inhibition demotes nearest competitor → high-novelty/conflicting writes routed to review.
3. **Offline ("sleep") cycle:** Consolidator (stochastic replay, interleaved) + Janitor (decay/fuse/prune) run in parallel — the "race between acquisition and forgetting," engineered as two cooperating background jobs. BG-Gate updates the ignition threshold from accumulated outcomes.
4. **Human audit:** the `workspace` table + propose/dispose queue is the single pane of glass. Every agent's reasoning is a row the user can read and override.

**Cost caveat (skeptic-flagged):** 6–8 agents writing one workspace adds real coordination/latency/cost. Only worth it if the audit-trail/override value is actually used. Build incrementally — start with Librarian + Salience Router + Consolidator + Janitor (the four that reuse existing code); add Critic/BG-Gate only once the workspace is proven.

---

## Honesty / what is analogy, not evidence

Keep these visible so they don't get overclaimed downstream. The *engineering* survives in every case; the *brain claims* below are contested, model-only, or pure analogy.

1. **Global Neuronal Workspace "ignition/broadcast"** is a **contested theory of consciousness** (competes with IIT). The 2025 Cogitate adversarial collaboration (Nature) failed to confirm GNW's signature sustained-prefrontal-ignition prediction. Our blackboard is a *design pattern* (Hearsay-II), not proof the brain works this way.
2. **"Working memory is persistent firing, NOT weight-based"** — actively debated (activity-silent / short-term synaptic-plasticity accounts). Our TTL scratch buffer is sound caching either way.
3. **Systems consolidation = "hippocampus disengages over time"** is the **Standard Model**, directly opposed by Multiple Trace Theory (the hippocampus may always be needed for vivid episodic recall). "Demote episodic after consolidation" is a retention policy, not settled science.
4. **Reconsolidation as a general "retrieval makes any memory labile"** has strong **boundary conditions** and documented **human replication failures**. Build labile-window as versioning + human review, not as a universal mechanism.
5. **Bjork two-strength theory** is a **psychological model** (behaviourally robust via spacing/testing effects), *not* measured neuroscience. Storage strength "never decreases / no upper bound" is an axiom, not a fact. The *implementation* is FSRS — production-validated.
6. **Dedicated dopamine→Rac1→cofilin forgetting machinery** and the "race between acquisition and forgetting" are robust in *Drosophila* but **partial/unreplicated in mammals**. Defend the Janitor as compaction/dedup hygiene.
7. **Precision-weighted free-energy / active inference** is a **theoretical framework** with near-unfalsifiability critiques. Our PE-gated updates are plain TD + inverse-variance estimation.
8. **Norepinephrine "global temperature" and the novelty/uncertainty channel** — gain is established; the unexpected-uncertainty role (Yu & Dayan) is partially confirmed; the dopamine→directed-exploration link **failed to replicate** in at least one cited pharmacology study. Temperature is a config knob.
9. **Salience-network causal switch (DMN↔CEN)** — node existence established, causal switch role contested. We're *not* building it as an agent for exactly this reason.
10. **Neural-sampling hypothesis & stochastic resonance as "the brain exploits noise functionally"** — sampling is contested vs probabilistic population codes; SR is real in vitro but a *functional* role in the CNS is unproven. Our temperature/MMR is standard IR.
11. **Key–value "information once stored is never lost; retrieval is the bottleneck"** (Gershman 2025) is an **emerging viewpoint with published counter-evidence** (storage-degradation/DMN-forgetting work). Defend never-hard-delete as **soft-delete hygiene**, not as "the brain never forgets."
12. **Cerebellar forward model as a general cognitive critic** — established for *motor* control; the cognitive extension is analogy. The Critic agent reduces to "predict, then update an outcome score."
13. **One-agent-per-brain-region "society"** is an **AI design pattern** (Minsky/Society of Mind), not a neuroscience finding.

**The honest summary:** the *taxonomy* of memory systems, dopamine RPE, pulvinar gating, amygdala tagging, and CLS-as-framework are established and load-bearing. The *coordination spine* (GNW), the *forgetting machinery*, the *free-energy* frame, and the *agent-per-region* wiring are inspiration. Every proposed change has an **independent CS/ML justification** (FSRS, PER, MMR, blackboard, key-value attention, soft-delete) — so the design survives even if every contested brain claim is wrong. Document Kaiba v-Next as **brain-inspired, not brain-proven.**

---

## Recommended next 3 goals

Sequenced; each is verifiable and builds on the prior.

**Goal 1 — Layered memory + two-strength salience (the keystone).**
> Add `memory_system` and `storage_strength` columns with a per-system weight table replacing the global `SALIENCE` const (`db.js:420`). Backfill `memory_system` from existing `doc_type`/`source`. Replace flat strengthen-on-recall with FSRS-style storage-strength growth (diminishing returns gated by how low retrievability was at recall) and a storage-strength-scaled half-life. **Verifiable:** existing memories backfill correctly; retrievability for a memory recalled twice in 5 min grows measurably less than one recalled after a week; `T=0`/legacy recall ordering is byte-identical to today on a fixed corpus.

**Goal 2 — Two-rate CLS consolidation + prediction-error outcomes.**
> Reframe `consolidate.js` as a scheduled offline consolidator that interleaves new episodics with sampled semantics, writes `semantic` rows with `derived_from` provenance, and demotes sources via `consolidated_into`. Add `predicted_outcome`; replace the flat ±1 in `recordMemoryOutcome` (`db.js:657`) with a PE-scaled bidirectional update and confidence-as-precision. **Verifiable:** a repeated cross-session pattern produces exactly one durable semantic memory linked to its episodic sources; injecting a contradicting outcome on a high-confidence memory yields a larger confidence drop than on a low-confidence one; consolidation is idempotent (re-running produces no duplicate semantics).

**Goal 3 — Transparent agent workspace + bounded non-determinism.**
> Add the `workspace` (blackboard) table and the four foundational agents (Librarian, Salience Router, Consolidator, Janitor) writing auditable {agent, score, vote, reasoning} rows. Ship temperature-sampled recall (Gumbel-top-k, `T=0` default, env `KB_RECALL_TEMPERATURE`) + MMR diversity + inhibition-of-return + RNG-seed logging. **Verifiable:** every recall cycle leaves an inspectable workspace trail the human can override; `T=0` is bit-for-bit deterministic and matches Goal-1 output; a given seed + temperature replays an identical stochastic recall; MMR demonstrably reduces near-duplicate results on a planted-paraphrase test set.

*Deferred to later rounds (visible, not hidden): reconsolidation labile-window (redundant with existing machinery — build as versioning only), retrieval-induced forgetting (novel but speculative — behind logging + offline eval), BG-Gate threshold learning (needs the workspace proven first), Critic/Verifier (analogy-loose). The salience-switch agent and stochastic-resonance noise floor are rejected outright per skeptic consensus.*

---

**Relevant files:** `C:\Users\Admin\My Drive\DBV4\claude_code\kb\knowledge-base-server\src\db.js` (salience const :420, salienceOf :443, recordMemoryOutcome :657, supersedeMemory :675, findSimilarMemory :512, confidence ladder :421-422), `C:\Users\Admin\My Drive\DBV4\claude_code\kb\knowledge-base-server\src\embeddings\search.js` (deterministic recall :45-46, 80-86), `C:\Users\Admin\My Drive\DBV4\claude_code\kb\knowledge-base-server\src\consolidate.js` (consolidation pipeline to reframe).