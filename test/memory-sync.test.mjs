// Pure-core tests for cross-device memory sync (docs/memory-bridge/08, requirements R1-R8).
// No DB, no network — exercises the join-semilattice merge directly. Run: `node test/memory-sync.test.mjs`.
import assert from 'node:assert';
import { mergeMemoryRecords } from '../src/memory/store.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); } };

// record factory — sensible defaults; override per case. `h` is the content_hash (identity).
const rec = (h, over = {}) => ({
  content_hash: h, content: 'content-' + h, reasoning: 'why-' + h, kind: 'semantic',
  created_by: 'agent', confidence: 'inferred', importance: 0.5, project: null, source: null,
  outcome: 0, use_count: 0, last_used_at: null, created_at: '2026-01-01 00:00:00',
  review_status: 'pending', superseded_by_hash: null, supersession_reason: null, ...over,
});
const canonOf = (res, h) => res.canonical.find(r => r.content_hash === h);

// --- R3: idempotent — merging a set with itself changes nothing ---
t('R3 merge(set,set) yields no inserts/updates', () => {
  const set = [rec('a'), rec('b', { confidence: 'verified', review_status: 'accepted' })];
  const { inserts, updates } = mergeMemoryRecords(set, set);
  assert.strictEqual(inserts.length, 0, 'no inserts');
  assert.strictEqual(updates.length, 0, 'no updates');
});

// --- R1: bidirectional — a peer-only memory becomes an insert ---
t('R1 peer-only memory is inserted', () => {
  const { inserts, updates } = mergeMemoryRecords([rec('a')], [rec('b')]);
  assert.strictEqual(inserts.length, 1);
  assert.strictEqual(inserts[0].content_hash, 'b');
  assert.strictEqual(updates.length, 0);
});

// --- R2/R8: convergence + order-independence of every field rule ---
t('R2/R8 divergent fields converge identically regardless of order', () => {
  const A = rec('x', { confidence: 'verified', review_status: 'accepted', importance: 0.9, outcome: 0, use_count: 5, last_used_at: '2026-03-01 00:00:00', created_at: '2026-02-01 00:00:00' });
  const B = rec('x', { confidence: 'inferred', review_status: 'rejected', importance: 0.3, outcome: -1, use_count: 2, last_used_at: '2026-01-15 00:00:00', created_at: '2026-01-01 00:00:00' });
  const ab = canonOf(mergeMemoryRecords([A], [B]), 'x');
  const ba = canonOf(mergeMemoryRecords([B], [A]), 'x');
  assert.deepStrictEqual(ab, ba, 'order-independent');
  assert.strictEqual(ab.confidence, 'inferred', 'confidence = min/most-cautious');
  assert.strictEqual(ab.review_status, 'rejected', 'review_status = max/terminal');
  assert.strictEqual(ab.importance, 0.9, 'importance = max');
  assert.strictEqual(ab.outcome, -1, 'outcome = caution (burn survives)');
  assert.strictEqual(ab.use_count, 5, 'use_count = max');
  assert.strictEqual(ab.last_used_at, '2026-03-01 00:00:00', 'last_used_at = latest');
  assert.strictEqual(ab.created_at, '2026-01-01 00:00:00', 'created_at = earliest');
});

// --- R7: supersession travels via hash; new target is inserted; link recorded ---
t('R7 supersession propagates (hash + target insert)', () => {
  const local = [rec('h5')];                                  // not yet superseded here
  const peer = [rec('h5', { superseded_by_hash: 'h9', supersession_reason: 'corrected' }), rec('h9')];
  const { inserts, updates } = mergeMemoryRecords(local, peer);
  assert.ok(inserts.find(r => r.content_hash === 'h9'), 'superseding memory inserted');
  const u = updates.find(u => u.content_hash === 'h5');
  assert.ok(u && u.changed.superseded_by_hash === 'h9', 'h5 gains superseded_by_hash=h9');
});

// --- R4 + stickiness: a stale peer can't un-supersede ---
t('R4 supersession is sticky (stale peer cannot revive)', () => {
  const local = [rec('h5', { superseded_by_hash: 'h9' })];
  const peer = [rec('h5', { superseded_by_hash: null })];     // peer doesn't know about the supersede
  const { updates } = mergeMemoryRecords(local, peer);
  assert.strictEqual(updates.length, 0, 'no change — stays superseded');
  assert.strictEqual(canonOf(mergeMemoryRecords(local, peer), 'h5').superseded_by_hash, 'h9');
});

// --- R8: conflicting supersession targets resolve deterministically (lexicographic min) ---
t('R8 conflicting supersession targets converge', () => {
  const A = [rec('h5', { superseded_by_hash: 'aaa' })];
  const B = [rec('h5', { superseded_by_hash: 'bbb' })];
  const ab = canonOf(mergeMemoryRecords(A, B), 'h5').superseded_by_hash;
  const ba = canonOf(mergeMemoryRecords(B, A), 'h5').superseded_by_hash;
  assert.strictEqual(ab, 'aaa');
  assert.strictEqual(ba, 'aaa', 'deterministic regardless of order');
});

// --- R4: non-destruction — local-only memory is never dropped ---
t('R4 local-only memory survives', () => {
  const { canonical } = mergeMemoryRecords([rec('a'), rec('keep')], [rec('a')]);
  assert.ok(canonical.find(r => r.content_hash === 'keep'), 'local-only memory retained');
});

// --- R4: rejection is terminal — accepted peer cannot resurrect a rejected memory ---
t('R4 rejected not resurrected by accepted peer', () => {
  const ab = canonOf(mergeMemoryRecords([rec('x', { review_status: 'rejected' })], [rec('x', { review_status: 'accepted' })]), 'x');
  assert.strictEqual(ab.review_status, 'rejected');
});

// --- F8: created_by merges by precedence user > agent (not "keep local") ---
t('F8 created_by precedence user>agent (both orders)', () => {
  assert.strictEqual(canonOf(mergeMemoryRecords([rec('x', { created_by: 'agent' })], [rec('x', { created_by: 'user' })]), 'x').created_by, 'user');
  assert.strictEqual(canonOf(mergeMemoryRecords([rec('x', { created_by: 'user' })], [rec('x', { created_by: 'agent' })]), 'x').created_by, 'user');
});

// --- F6: merge never schedules a content/reasoning write (FTS-safety guard) ---
t('F6 update diff excludes content/reasoning', () => {
  const local = [rec('x', { content: 'OLD', reasoning: 'OLDR', importance: 0.5 })];
  const peer = [rec('x', { content: 'NEW', reasoning: 'NEWR', importance: 0.9 })]; // same hash, different text
  const u = mergeMemoryRecords(local, peer).updates.find(u => u.content_hash === 'x');
  assert.ok(u, 'an update is scheduled (importance)');
  assert.ok(!('content' in u.changed), 'content never in the update diff');
  assert.ok(!('reasoning' in u.changed), 'reasoning never in the update diff');
});

// --- R8: associativity — same canonical regardless of how 3 replicas are partitioned ---
t('R8 three-way merge is associative', () => {
  const A = rec('x', { confidence: 'verified', importance: 0.4, use_count: 1, outcome: 2 });
  const B = rec('x', { confidence: 'asserted', importance: 0.7, use_count: 9, outcome: 0 });
  const C = rec('x', { confidence: 'inferred', importance: 0.5, use_count: 3, outcome: -1, review_status: 'rejected' });
  const p1 = canonOf(mergeMemoryRecords([A], [B, C]), 'x');
  const p2 = canonOf(mergeMemoryRecords([A, B], [C]), 'x');
  const p3 = canonOf(mergeMemoryRecords([C], [A, B]), 'x');
  assert.deepStrictEqual(p1, p2);
  assert.deepStrictEqual(p2, p3);
  assert.strictEqual(p1.confidence, 'inferred');   // min
  assert.strictEqual(p1.review_status, 'rejected'); // terminal
  assert.strictEqual(p1.outcome, -1);              // burn wins
  assert.strictEqual(p1.importance, 0.7);          // max
});

// --- R3 fixpoint: applying the merge then re-syncing the same peer is a no-op ---
t('R3 fixpoint — canonical re-merged with peer yields no change', () => {
  const local = [rec('h5'), rec('z', { importance: 0.2 })];
  const peer = [rec('h5', { superseded_by_hash: 'h9' }), rec('h9'), rec('z', { importance: 0.8 })];
  const first = mergeMemoryRecords(local, peer);
  // simulate "local now equals the canonical union" (what syncMemories persists), then re-sync same peer
  const applied = first.canonical;
  const second = mergeMemoryRecords(applied, peer);
  assert.strictEqual(second.inserts.length, 0, 'no new inserts on re-sync');
  assert.strictEqual(second.updates.length, 0, 'no new updates on re-sync (fixpoint reached)');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
