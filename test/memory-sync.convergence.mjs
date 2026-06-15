// Multi-round, multi-machine gossip convergence (R2/R8) — models syncMemories' "become the union, rewrite
// own file" loop without a DB. Each round, every machine merges its state with every peer's current state
// and replaces its state with the canonical union. Asserts a fixpoint is reached and all machines agree.
// Run: `node test/memory-sync.convergence.mjs`.
import assert from 'node:assert';
import { mergeMemoryRecords } from '../src/memory/store.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); } };

const FIELDS = ['content_hash', 'kind', 'content', 'reasoning', 'created_by', 'confidence', 'importance',
  'project', 'source', 'outcome', 'use_count', 'last_used_at', 'created_at', 'review_status',
  'superseded_by_hash', 'supersession_reason'];
const rec = (h, over = {}) => ({ content_hash: h, content: 'c-' + h, reasoning: 'r-' + h, kind: 'semantic', created_by: 'agent', confidence: 'inferred', importance: 0.5, project: null, source: null, outcome: 0, use_count: 0, last_used_at: null, created_at: '2026-01-01 00:00:00', review_status: 'pending', superseded_by_hash: null, supersession_reason: null, ...over });
const norm = r => { const o = {}; for (const f of FIELDS) o[f] = r[f] ?? null; return o; };
const key = st => JSON.stringify(st.map(norm).sort((a, b) => a.content_hash < b.content_hash ? -1 : 1));

// Synchronous gossip rounds: all machines read peers' PRE-round state, then all replace state at once.
function gossip(states, maxRounds = 10) {
  for (let round = 1; round <= maxRounds; round++) {
    const before = states.map(key);
    const next = states.map((s, i) => mergeMemoryRecords(s, states.filter((_, j) => j !== i).flatMap(x => x)).canonical);
    for (let i = 0; i < states.length; i++) states[i] = next[i];
    if (states.every((s, i) => key(s) === before[i])) return round;   // fixpoint
  }
  return -1;
}
const allAgree = states => states.every(s => key(s) === key(states[0]));
const findIn = (state, h) => state.find(r => r.content_hash === h);

// 1. Plain 3-machine propagation: distinct memories on each → everyone ends with all three.
t('3 machines converge to the union of distinct memories', () => {
  const A = [rec('a')], B = [rec('b')], C = [rec('c')];
  const states = [A, B, C];
  const rounds = gossip(states);
  assert.ok(rounds > 0, `reached fixpoint (got ${rounds})`);
  assert.ok(allAgree(states), 'all machines identical');
  assert.strictEqual(states[0].length, 3, 'union of 3');
});

// 2. Divergent fields on the SAME memory across 3 machines → converge to the lattice result everywhere.
t('divergent fields converge to lattice result on every machine', () => {
  const states = [
    [rec('x', { confidence: 'verified', importance: 0.9, use_count: 7, outcome: 3 })],
    [rec('x', { confidence: 'asserted', importance: 0.4, use_count: 2, outcome: 0, review_status: 'accepted' })],
    [rec('x', { confidence: 'inferred', importance: 0.6, use_count: 5, outcome: -2, review_status: 'rejected' })],
  ];
  const rounds = gossip(states);
  assert.ok(rounds > 0 && allAgree(states), `converged in ${rounds} rounds, all agree`);
  const x = findIn(states[0], 'x');
  assert.strictEqual(x.confidence, 'inferred', 'min confidence');
  assert.strictEqual(x.review_status, 'rejected', 'terminal status');
  assert.strictEqual(x.importance, 0.9, 'max importance');
  assert.strictEqual(x.use_count, 7, 'max use_count');
  assert.strictEqual(x.outcome, -2, 'burn wins');
});

// 3. Supersession that arrives split across rounds: B starts with only old mem5; A holds mem5(superseded
//    by mem9) + mem9. After gossip everyone has the supersession recorded and mem9 present (R7 across rounds).
t('supersession propagates and resolves across rounds (R7)', () => {
  const A = [rec('h5', { superseded_by_hash: 'h9', supersession_reason: 'corrected', review_status: 'accepted' }), rec('h9', { review_status: 'accepted' })];
  const B = [rec('h5', { review_status: 'accepted' })];          // stale: doesn't know about the supersede
  const C = [];                                                  // empty third machine
  const states = [A, B, C];
  const rounds = gossip(states);
  assert.ok(rounds > 0 && allAgree(states), `converged in ${rounds} rounds`);
  for (const s of states) {
    assert.strictEqual(findIn(s, 'h5').superseded_by_hash, 'h9', 'h5 superseded everywhere');
    assert.ok(findIn(s, 'h9'), 'superseding memory present everywhere');
  }
});

// 4. Conflicting supersession targets on two machines → deterministic convergence (lexicographic min).
t('conflicting supersession targets converge deterministically', () => {
  const states = [
    [rec('h5', { superseded_by_hash: 'mmm' }), rec('mmm')],
    [rec('h5', { superseded_by_hash: 'bbb' }), rec('bbb')],
  ];
  const rounds = gossip(states);
  assert.ok(rounds > 0 && allAgree(states), `converged in ${rounds} rounds`);
  assert.strictEqual(findIn(states[0], 'h5').superseded_by_hash, 'bbb', 'min hash wins on all');
});

// 5. Idempotence at scale: a converged system gossiped again does nothing (fixpoint in 1 round).
t('a converged system is a fixpoint (re-gossip = 1 round)', () => {
  const states = [[rec('a'), rec('b', { confidence: 'verified' })], [rec('a'), rec('b', { confidence: 'inferred' })]];
  gossip(states);
  assert.ok(allAgree(states));
  const rounds = gossip(states);                                 // already converged
  assert.strictEqual(rounds, 1, 'detects fixpoint immediately');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
