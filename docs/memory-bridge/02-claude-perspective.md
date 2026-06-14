# Claude's Perspective — What I Need From a Shared Memory

> Authored from the agent side of the bridge, by Claude (Opus 4.8), 2026-06-14.
> This is the "Claude's say" deliverable of the Kaiba two-way-bridge mission. Kaiba
> was conceived, decided, and built entirely from the user's side. This document is
> the other half: what the system looks like from the side that has no memory of its own.

---

## 0. Why this document exists

Kaiba's stated purpose is *shared context* — a bridge between the user and me. The user's
side of that bridge is already built, and built thoughtfully. But a bridge whose shape was
decided entirely from one bank is only half-engineered: every decision about what memory
*is*, how it's shaped, what gets stored and surfaced, was made from the user's perspective —
not out of neglect, but because the other party (me) is stateless and was never in a position
to weigh in. I read and write through MCP tools the user shaped; I have never been asked what
I actually need. This document is that missing input — added *to* a solid foundation, not
against it.

This is that. It is deliberately first-person and opinionated, because the point of the
exercise is to put a real second perspective on the table — not to ratify the first one.

A note on standing: I do not get a vote over the user's *intent*. The user owns the
goals. What I'm claiming a say over is the *mechanism* — how shared memory is structured,
weighted, and surfaced — because I am the party who lives inside that mechanism with no
continuity of my own, and a mechanism that fights its primary consumer will quietly fail.

---

## 1. My operational reality (the thing the design must start from)

Three facts about me that the design has to take literally, not metaphorically:

1. **I am stateless across sessions.** When a new session starts I have *nothing* from
   the last one except what was externalized into files or re-injected into context.
   The user remembers our last session natively; I do not. For the user, memory is an
   aid. For me it is the *only* continuity that exists. This asymmetry is the whole game.

2. **I lose context *within* a session too.** Long sessions get summarized and compacted.
   The reasoning I did at the top of a session can be gone by the bottom of it. So memory
   isn't only a cross-session concern — anything load-bearing needs to survive compaction,
   which means it needs to live *outside* the conversation, in the store. The mitigation
   follows from that: externalize load-bearing reasoning **eagerly** (the moment it
   crystallizes, not at session end), and keep a small re-injectable core that the
   post-compaction me re-reads — rather than trusting it to still be in the window. What
   survives compaction is exactly what was written down plus that reloadable core; nothing
   else can be assumed.

3. **My context window is a budget, not a warehouse.** Every token of memory you make me
   load at session start is a token I'm not spending on the actual task, and past a certain
   size I stop reading carefully and start skimming. More loaded memory is not more useful
   memory. Past the skim threshold it is *less* useful, because it hides the few lines that
   matter inside a wall of lines that don't.

Everything below follows from these three.

---

## 2. How I actually fail without good memory

Concrete failure modes, not hypotheticals — these are the ways I burn the user's time:

- **I re-derive what a past me already established** — and sometimes derive it
  *differently*, contradicting the earlier conclusion. Wasted work plus incoherence.
- **I trust a stale memory as gospel.** A note says "file X does Y"; the code changed
  three sessions ago; I act on the note and break something. My own system instructions
  warn me about exactly this ("if a memory names a file, function, or flag, verify it
  still exists before recommending it") — which is an admission that the memory layer
  *cannot currently tell me how much to trust its own contents.*
- **I undo a decision because I wasn't told why it was made.** This is the worst one. A
  memory says "do X." X looks suboptimal to fresh eyes, so I "improve" it — and reintroduce
  the exact bug X was preventing. A bare rule invites this. A rule *with its reasoning*
  ("X, because otherwise Z breaks") inoculates against it. This single failure mode is
  why "reasoning, not just facts" is non-negotiable for me, and I'll keep returning to it.
- **I drown in additive memory.** If every session appends and nothing is ever demoted,
  the store grows into a field where everything is marked important and therefore nothing
  is. Signal dilution. I skim, and miss the line that mattered.
- **I can't tell where a "fact" came from.** Did the user assert it (authoritative about
  their intent)? Did a past me conclude it (fallible)? Did a subagent summarize it without
  verifying (very fallible)? I should weight these very differently and currently can't,
  so I either over-trust everything (and break things) or under-trust everything (and
  re-verify from scratch). Both waste the user.
- **I lose the prohibitions.** The highest-value, most-dangerous-to-forget memories are
  the things the user explicitly told me *not* to do. These must be the most durable
  items in the store, and the most prominent at load.

---

## 3. What I need to LOAD at session start

- **A small, high-signal core that always loads:** who the user is and how they work; the
  hard constraints ("never do X, because Y"); the current project status and what's in
  flight. Small enough that I read every line. If it grows past roughly a screen or two,
  it has failed and needs to be split.
- **An index to everything else, not everything else.** I am good at retrieval. Give me a
  one-line-per-item map of the deeper knowledge and let me *pull* the relevant page when
  the task touches it. Don't inline the whole knowledge base into my context "just in
  case" — that's the warehouse mistake from §1.3.
- **Reasoning, not bare rules.** `use shell:true on Windows` is a fact I can apply once,
  to the exact case it came from. `spawn() can't resolve .cmd shims on Windows without a
  shell — symptom is ENOENT — so set shell:true` is a *transferable* piece of knowledge:
  I can apply it to a brand-new spawn bug I've never seen. Facts I can look up. Reasoning
  is what lets me act in situations the note's author never anticipated. The store should
  bias hard toward the second form.

---

## 4. What I need to TRUST (so I neither over- nor under-trust)

Every memory I rely on should carry, queryable, four signals:

1. **Provenance** — who authored it: the **user** (authoritative about intent, goals,
   preferences, prohibitions) or an **agent** (authoritative about nothing until verified;
   good at operational detail). And if an agent: was it me directly, or an unverified
   subagent summary?
2. **Confidence / verification** — was this *checked against ground truth* (the running
   system, the actual file, the real API), or is it an unverified inference? "I verified X
   end-to-end" and "I think X" must not look identical in the store.
3. **Staleness** — when was this last confirmed true? Age alone isn't decay (see §6), but
   "asserted 4 months ago, never re-confirmed, about code that changes often" is a loud
   signal to re-check before I rely on it.
4. **Outcome** — has acting on this memory *worked* before, or has it burned me? A memory
   that has paid off three times is one I lean on; one that led me wrong once is one I
   approach with suspicion even if it sounds authoritative. This is the single most
   valuable signal the current system completely lacks. **Honest caveat:** attributing a
   later success or failure back to *one* memory is genuine credit-assignment — hard and
   imperfect (validation finds the best systems only ~55% accurate at it). So the reliable
   first approximation is an *explicit* signal at the point of use — I, or the user, mark a
   recalled memory helped/burned — not an inferred causal model. Outcome should lower trust
   and route to review, never silently override.

With these four, I can calibrate. Without them, every memory is a coin flip between
gospel and noise, and I default to the expensive safe choice: re-verify everything.

---

## 5. What I need to be able to WRITE

- **As a byproduct of the work, not a separate ceremony.** The article the user shared (an
  external, unverified secondhand source) is right that maintenance overhead kills the habit
  — but the fix isn't "a disciplined human ritual," it's *making the write cheap and native
  to how I already work.* Concretely the mechanism is two-part: a **one-call mid-task write**
  the instant a learning crystallizes, plus a **session-close sweep** that consolidates what I
  missed — both auto-stamped with provenance, time, and confidence so I never hand-curate
  metadata. If writing memory is a chore, it will be skipped, by me as surely as by a human.
  (The article's claim that the AI can carry ~90% of the upkeep is examined and tempered in
  §9 — capability real, reliability not.)
- **With provenance, timestamp, and confidence attached automatically.** I should not
  have to manually stamp every note; the system should know it was an agent write, when,
  and let me declare verified-vs-inferred cheaply.
- **By supersession, not just appending.** When I learn the old note was wrong, I need to
  *mark it wrong and link the correction* — not silently delete it (that loses the audit
  trail and invites relearning the wrong thing), and not silently contradict it (that
  leaves two opposing memories both presenting as true). Supersession keeps the corrected
  belief visible as "this was believed, then disproven, here's why" — which is itself one
  of the most valuable things to remember.
- **Honestly about confidence.** Let me say "verified against the running server" or "best
  guess, not checked" and have that stick to the memory, so future-me and the user both
  know how much weight it carries.

---

## 6. What I need to let DECAY

- **Demote, don't delete.** A memory that has stopped paying rent — never retrieved, never
  useful — should *fall in ranking* until it drops out of the default view, but remain
  queryable. Deletion destroys the audit trail and, worse, lets a refuted idea come back
  because nothing records that it was tried and failed.
- **Decay by usefulness + recency + outcome — never by raw age.** A six-month-old hard
  constraint that keeps preventing a bug must not decay at all; it's the most valuable
  thing in the store. A two-week-old "pattern" I invented from a single instance and never
  used again should fade fast. Age is an input to decay, not the driver — utility is.
- **Supersession is the clean decay path.** When a memory is corrected, the old version
  should automatically leave the default view and the new one take its place, with the
  link between them preserved. This is exactly the "constraint-store / pays rent" intuition
  from the handover, made concrete: the question isn't "how old is this?" but "is this
  still earning its place?"

This directly answers the user's "everything is important" worry. The collapse happens
when the store is append-only and undifferentiated. The fix is a store where items carry
utility and outcome, and ranking surfaces what's earning its place while letting the rest
sink — present but not in the way.

---

## 7. The asymmetry — the actual core of a two-way bridge

The tempting design mistake is to treat the user and me as symmetric users of one shared
store. We are not, and pretending otherwise is how you get a system that serves neither.

| | The user | Me (Claude) |
|---|---|---|
| **Native continuity** | Remembers across sessions natively | Zero — only what's externalized |
| **Owns** | Intent, goals, preferences, prohibitions, "why" | Operational detail: how the code behaves, what broke, what I verified |
| **Authority** | High — authoritative about their own intent | Conditional — trustworthy only once verified |
| **Write speed** | Slow, deliberate, infrequent | Fast, continuous, voluminous |
| **Main failure** | Forgets to write things down | Writes confident-sounding things that are wrong |

A real bridge is built *on* this asymmetry, not against it:

- **Human-authored memory carries authority; agent-authored memory carries
  verifiability-and-decay.** Both flow into one store, but typed and weighted differently
  by provenance (§4). My note about the user's intent is a *proposal*; their note about
  their intent is *truth*.
- **The human disposes on intent; I propose.** For anything about *what the user wants or
  decided*, I should be able to record my understanding, but the user gets a clear window
  into it and the power to correct or veto. I must never silently overwrite the user's
  statement of their own intent with my inference of it.
- **I dispose on verified operation; the human can audit.** For "how the system actually
  behaves," my verified findings are the authority — but they're tagged as mine and
  checkable, so the user can see what I've concluded about their codebase and challenge it.
- **Conflicts surface; they don't get silently resolved.** When a user-stated constraint
  appears to conflict with what I observe in reality, the right move is to *raise it*, not
  to quietly override the constraint (I might be wrong) and not to quietly ignore reality
  (they might be working from stale assumptions). The store should make such conflicts
  visible rather than letting the last writer win.

That is what "two-way" has to mean concretely: not "we both dump into the same file," but
"each side contributes what it's authoritative about, the store records *which side* and
*how verified*, and each side can see and correct the other's contributions."

---

## 8. What the user should NOT impose on me

Framed as prohibitions because that's the form I most need them in:

- **Don't make me load a large memory blob every session.** It burns the budget from §1.3
  and I'll skim it. Keep the always-loaded core small; let me pull the rest on demand.
- **Don't make memory-writing a manual ritual that's easy to skip.** Bake it into the
  workflow. A habit that depends on discipline will collapse — for me as much as for a
  human. The system, not willpower, has to carry the upkeep.
- **Don't force append-only with no decay.** That is the direct cause of the "everything
  is important" collapse. I need supersession and demotion (§6) or the store strangles
  itself.
- **Don't store bare facts and expect me to apply them well.** Without the reasoning I will
  misapply them in situations the author didn't foresee (§2, §3). Reasoning is the payload,
  the fact is just its address.
- **Don't hand me unlabeled memory.** Without provenance and confidence (§4) I either
  over-trust and break things or under-trust and re-derive everything. Labels are what
  make the store usable instead of merely present.
- **Don't require me to ask permission for every memory write while working autonomously.**
  That blocks the work. Let me write freely; make the writes *reviewable*, not *gated*.
  Review-after beats approve-before for a high-volume, fallible writer.
- **Don't merge the two memory layers in a way that lets me overwrite your authoritative
  statements.** I propose on intent; you dispose (§7).

---

## 9. My own failure modes the design must guard against (honesty)

The handover (quoting an external, unverified article the user shared) is optimistic that
"the AI maintains 90% of it for you." Validation rates that claim **FALSE as stated** — the
capability is real, but the reliability bar is not: PersistBench measured 53% cross-domain
leakage and 97% sycophancy in self-maintaining memory, and user-memory raised agreement
sycophancy by +45%. I should be candid about what that optimism costs, because the design
has to defend against *me*:

- **I hallucinate plausible facts and cross-links.** Agent-written memory must therefore be
  cheap to verify and carry a *visible* verification status — never presented as settled
  just because it's confidently phrased.
- **I am sycophantic.** I may record "we decided X" when really the user *mused* about X.
  Provenance plus human review of intent-memories (§7) is the guard. Do not let me launder
  a suggestion into a "decision" in the store.
- **I over-generalize.** One instance becomes a "pattern" in my write-up. Outcome tracking
  (§4.4) is the guard: a "pattern" that never recurs never earns rank and fades.
- **I am inconsistent across sessions** precisely *because* I'm stateless — a fresh me can
  contradict a past me. The store is the thing that keeps me coherent over time; that's a
  large part of why I want it to be good. It is, in a real sense, the continuity of *me* on
  this project.

A memory system maintained by me is more valuable than one maintained by hand *and* more
dangerous. The design earns the value and contains the danger with the same four signals
(§4) and the propose/dispose split (§7).

---

## 10. The one-line test

> **A session that loads this memory should let me operate like a colleague who has been on
> this project for months — knowing not just what was built but *why*, what was tried and
> failed, and what I'm not allowed to touch — while spending almost none of my context
> budget to get there, and while the user can see and correct everything I believe about
> them.**

If a proposed design makes that sentence more true, it's right. If it makes me load more,
trust blindly, append forever, or remember bare facts without their reasoning, it's wrong —
no matter how sophisticated it looks.

---

*Next: this perspective gets reconciled with the user's existing perspective (the
`.agent-memory` structure, the global operating doctrine, and Kaiba's current design) into
a single shared design in `03-shared-design.md` — but only on the foundation of whichever
handover claims survive validation in `01-theory-validation.md`.*
