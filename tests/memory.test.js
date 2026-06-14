import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
  initSchema, _setTestDb, _resetDb,
  insertDocument, getDocument, searchDocuments,
  rememberMemory, recallMemories, recordMemoryOutcome,
  supersedeMemory, listPendingMemories, reviewMemory, computeDepsHash,
  embedMemory, backfillMemoryEmbeddings, _setTestEmbedder, _setAutoEmbed, getSessionBrief, findConflict,
  exportMemoriesNDJSON, importMemories, listDocuments, salienceOf, strengthenedStorage, markConsolidated, recallTraced,
  getReplayQueue,
} from '../src/db.js';
import { getToolDefinitions, getHttpToolDefinitions } from '../src/tools.js';

function getTool(name) { return getToolDefinitions().find(t => t.name === name); }

// Deterministic fake embedder for fast, offline, reproducible semantic tests.
// Maps text to a small topic-space vector by keyword; real-model semantics are verified e2e.
function fakeEmbed(text) {
  const t = String(text).toLowerCase();
  const v = [0, 0, 0, 0.0001];
  if (/deploy|systemd|pm2|server|infra|release|rollout/.test(t)) v[0] += 1;
  if (/cat|mat|animal|pet|dog|kitten/.test(t)) v[1] += 1;
  if (/memory|bridge|recall|salience|provenance/.test(t)) v[2] += 1;
  const mag = Math.hypot(...v) || 1;
  return new Float32Array(v.map(x => x / mag));
}

describe('memory bridge — db layer', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); });
  after(() => { _setAutoEmbed(true); db.close(); _resetDb(); });

  it('legacy insertDocument gets honest provenance defaults', () => {
    const d = insertDocument({ title: 'Legacy', content: 'legacy zzqA content', doc_type: 'text' });
    const row = getDocument(Number(d.id));
    assert.strictEqual(row.created_by, 'system');
    assert.strictEqual(row.confidence, 'unverified');
    assert.strictEqual(row.importance, 0.5);
    assert.strictEqual(row.review_status, 'none');
    assert.strictEqual(row.access_count, 0);
  });

  it('agent memory is pending + inferred (correctness gate); user memory is accepted', () => {
    const am = rememberMemory({ title: 'Agent', content: 'agent zzqB spawn shell', reasoning: 'why it matters' });
    const ar = getDocument(Number(am.id));
    assert.strictEqual(ar.created_by, 'agent');
    assert.strictEqual(ar.confidence, 'inferred');
    assert.strictEqual(ar.review_status, 'pending');
    assert.strictEqual(ar.reasoning, 'why it matters');
    assert.strictEqual(ar.doc_type, 'memory');
    const um = rememberMemory({ title: 'User', content: 'user zzqC prefers concise', created_by: 'user' });
    assert.strictEqual(getDocument(Number(um.id)).created_by, 'user');
    assert.strictEqual(getDocument(Number(um.id)).review_status, 'accepted');
  });

  it('recall ranks by salience, surfaces trust signals, strengthens on recall', async () => {
    const m = rememberMemory({ title: 'Recallable', content: 'recall zzqD topic here', created_by: 'user' });
    const hits = await recallMemories('zzqD');
    const h = hits.find(x => x.id === Number(m.id));
    assert.ok(h, 'memory is recalled');
    assert.ok(typeof h.salience === 'number', 'salience present');
    assert.strictEqual(h.created_by, 'user', 'provenance surfaced');
    assert.strictEqual(h.confidence, 'asserted', 'confidence surfaced');
    const before = getDocument(Number(m.id)).access_count;
    await recallMemories('zzqD');
    assert.ok(getDocument(Number(m.id)).access_count > before, 'access_count bumps on recall (pays rent)');
  });

  it('burned outcome downgrades confidence (precision-weighted) and flags; never deletes', () => {
    const m = rememberMemory({ title: 'Burnable', content: 'burn zzqE topic', created_by: 'user', confidence: 'verified' });
    const r = recordMemoryOutcome(Number(m.id), 'burned');
    assert.ok(['inferred', 'unverified'].includes(r.confidence), `verified drops more than one notch on burn (got ${r.confidence})`);
    assert.strictEqual(r.review_status, 'flagged', 'burn flags for review');
    assert.ok(r.outcome_score < 0, 'burn lowers outcome_score');
    assert.ok(getDocument(Number(m.id)) !== null, 'not deleted');
    const r2 = recordMemoryOutcome(Number(m.id), 'helped');
    assert.ok(r2.outcome_score > r.outcome_score, 'a later helped raises outcome_score');
  });

  it('supersession demotes from default recall but stays queryable (demote, do not delete)', async () => {
    const old = rememberMemory({ title: 'Old', content: 'super zzqF old version', created_by: 'user' });
    const neu = rememberMemory({ title: 'New', content: 'super zzqF new version', created_by: 'user' });
    supersedeMemory(Number(old.id), Number(neu.id), 'corrected');
    const def = (await recallMemories('zzqF')).map(x => x.id);
    assert.ok(!def.includes(Number(old.id)), 'superseded excluded from default recall');
    const inc = (await recallMemories('zzqF', { includeSuperseded: true })).map(x => x.id);
    assert.ok(inc.includes(Number(old.id)), 'queryable with includeSuperseded');
    assert.ok(getDocument(Number(old.id)) !== null, 'superseded memory not deleted');
  });

  it('review queue: agent memory is pending, reject excludes it from recall', async () => {
    const m = rememberMemory({ title: 'Pend', content: 'pend zzqG proposal' }); // agent default
    assert.ok(listPendingMemories().some(p => p.id === Number(m.id)), 'in pending queue');
    reviewMemory(Number(m.id), 'reject');
    assert.strictEqual(getDocument(Number(m.id)).review_status, 'rejected');
    assert.ok(!(await recallMemories('zzqG')).some(x => x.id === Number(m.id)), 'rejected excluded from recall');
  });

  it('flagged (burned) memories surface in the review queue (regression)', () => {
    const m = rememberMemory({ title: 'Flagme', content: 'flag zzqFL token', created_by: 'user' });
    recordMemoryOutcome(Number(m.id), 'burned'); // -> review_status='flagged'
    const queue = listPendingMemories();
    const found = queue.find(p => p.id === Number(m.id));
    assert.ok(found, 'flagged memory appears in the review queue (was the bug: it vanished)');
    assert.strictEqual(found.review_status, 'flagged');
  });

  it('deps hash is deterministic (order-independent); a changed tracked dep flags stale', async () => {
    assert.strictEqual(computeDepsHash({ a: 1, b: 2 }), computeDepsHash({ b: 2, a: 1 }));
    const m = rememberMemory({ title: 'Dep', content: 'dep zzqH content', created_by: 'user', deps: { v: '1' } });
    assert.strictEqual((await recallMemories('zzqH', { deps: { v: '1' } })).find(x => x.id === Number(m.id)).stale, false);
    assert.strictEqual((await recallMemories('zzqH', { deps: { v: '2' } })).find(x => x.id === Number(m.id)).stale, true);
  });
});

describe('memory bridge — semantic recall (embeddings)', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(fakeEmbed); });
  after(() => { _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb(); });

  it('recalls a paraphrase that FTS token-matching misses', async () => {
    const deploy = rememberMemory({ title: 'Deploy method', content: 'we deploy with systemd not pm2', created_by: 'user' });
    const animal = rememberMemory({ title: 'Pet', content: 'the cat sat on the mat', created_by: 'user' });
    await embedMemory(Number(deploy.id));
    await embedMemory(Number(animal.id));

    // FTS alone misses the deploy memory for this query — no shared tokens.
    const fts = searchDocuments('deployment approach');
    assert.ok(!fts.some(r => r.id === Number(deploy.id)), 'FTS should not match the paraphrase');

    const hits = await recallMemories('deployment approach');
    assert.ok(hits.length >= 1, 'recall returns results');
    assert.strictEqual(hits[0].id, Number(deploy.id), 'semantic recall surfaces the deploy memory first');
    assert.strictEqual(hits[0].relevance_source, 'semantic', 'used semantic relevance');
    const deployRank = hits.findIndex(h => h.id === Number(deploy.id));
    const animalRank = hits.findIndex(h => h.id === Number(animal.id));
    assert.ok(deployRank < animalRank, 'deploy ranks above the unrelated memory');
  });

  it('backfillMemoryEmbeddings embeds memories lacking an embedding', async () => {
    const m = rememberMemory({ title: 'Backfill me', content: 'rollout server release plan', created_by: 'user' });
    const res = await backfillMemoryEmbeddings();
    assert.ok(res.embedded >= 1, `backfill embedded at least the new memory (got ${res.embedded})`);
    const hit = (await recallMemories('deployment rollout')).find(h => h.id === Number(m.id));
    assert.ok(hit && hit.relevance_source === 'semantic', 'backfilled memory is semantically recallable');
  });
});

describe('memory bridge — FTS fallback when no embeddings', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); });
  after(() => { _setAutoEmbed(true); db.close(); _resetDb(); });

  it('recall still works (via FTS) when the embeddings table is empty', async () => {
    const m = rememberMemory({ title: 'Fallback', content: 'fallback zzqFB unique token', created_by: 'user' });
    const hits = await recallMemories('zzqFB');
    const hit = hits.find(h => h.id === Number(m.id));
    assert.ok(hit, 'recall works via FTS fallback');
    assert.strictEqual(hit.relevance_source, 'fts', 'fell back to FTS relevance');
  });

  it('empty-query recall returns recency-ranked memories (recency source)', async () => {
    rememberMemory({ title: 'R1', content: 'recency one zzr', created_by: 'user', importance: 0.9 });
    rememberMemory({ title: 'R2', content: 'recency two zzr', created_by: 'user', importance: 0.1 });
    const hits = await recallMemories('', { limit: 5 });
    assert.ok(hits.length >= 2, 'returns memories even with no query');
    assert.ok(hits.every(h => h.relevance_source === 'recency'), 'no-query recall uses the recency source');
  });
});

describe('memory bridge — session brief (spaced re-surfacing)', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); });
  after(() => { _setAutoEmbed(true); db.close(); _resetDb(); });

  it('CORE = accepted high-importance; DUE = un-surfaced; a brief schedules items forward (spacing)', () => {
    const hi = rememberMemory({ title: 'Prohibition', content: 'never drop the documents table', created_by: 'user', importance: 0.95 });
    rememberMemory({ title: 'Aside', content: 'minor note zzqbrief', created_by: 'user', importance: 0.2 });
    const brief1 = getSessionBrief({ core: 5, due: 5 });
    assert.ok(brief1.core.some(m => m.id === Number(hi.id)), 'high-importance accepted memory is in CORE');
    assert.ok(brief1.due.length >= 1, 'un-surfaced memories are DUE');
    const brief2 = getSessionBrief({ core: 5, due: 5 });
    assert.strictEqual(brief2.due.length, 0, 'nothing due immediately after a brief (spacing pushed them forward)');
  });
});

describe('memory bridge — conflict surfacing (closest semantic neighbor)', () => {
  let db;
  // Topic axes (weight 1) + two hash-spread spikes so same-topic texts land cosine ~0.85 (in band)
  // and cross-topic land near 0 (out of band) — deterministically.
  function topicVec(text) {
    const t = String(text).toLowerCase();
    const N = 44; const v = new Array(N).fill(0);
    if (/deploy|systemd|pm2|server/.test(t)) v[0] = 1;
    else if (/cat|mat|animal/.test(t)) v[1] = 1;
    else v[2] = 1;
    let h = 0; for (let i = 0; i < t.length; i++) h = (h * 131 + t.charCodeAt(i)) >>> 0;
    v[3 + (h % 20)] += 0.3;
    v[23 + ((h >> 5) % 20)] += 0.3;
    const mag = Math.hypot(...v) || 1;
    return new Float32Array(v.map(x => x / mag));
  }
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(topicVec); });
  after(() => { _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb(); });

  it('finds a close-but-distinct neighbor (same topic) and ignores unrelated memories', async () => {
    const a = rememberMemory({ title: 'A', content: 'we deploy with systemd on the server', created_by: 'user' });
    const b = rememberMemory({ title: 'B', content: 'deployment uses the systemd service manager', created_by: 'user' });
    const cat = rememberMemory({ title: 'C', content: 'the cat sat on the mat at home', created_by: 'user' });
    await embedMemory(Number(a.id)); await embedMemory(Number(b.id)); await embedMemory(Number(cat.id));
    const conflict = await findConflict(Number(b.id));
    assert.ok(conflict, 'a close neighbor is found for the deploy memory');
    assert.strictEqual(conflict.id, Number(a.id), 'the deploy neighbor, not the cat');
    const none = await findConflict(Number(cat.id));
    assert.ok(!none || none.id !== Number(a.id), 'the unrelated cat memory has no deploy neighbor in band');
  });
});

describe('memory bridge — portability (export/import NDJSON)', () => {
  it('round-trips provenance + reward signal, re-enters review, and dedupes on re-import', () => {
    const db1 = new Database(':memory:'); initSchema(db1); _setTestDb(db1); _setAutoEmbed(false);
    const p1 = rememberMemory({ title: 'P1', content: 'portable memory one', reasoning: 'r1', created_by: 'user', importance: 0.8 });
    recordMemoryOutcome(Number(p1.id), 'helped'); // give it a learned reward signal
    rememberMemory({ title: 'P2', content: 'portable memory two', created_by: 'agent' });
    const ndjson = exportMemoriesNDJSON();
    assert.strictEqual(ndjson.split('\n').filter(Boolean).length, 2, 'exported both memories');
    _resetDb(); db1.close();

    const db2 = new Database(':memory:'); initSchema(db2); _setTestDb(db2); _setAutoEmbed(false);
    const res = importMemories(ndjson);
    assert.strictEqual(res.imported, 2);
    const ip1 = getDocument(listDocuments({ limit: 100 }).find(d => d.title === 'P1').id);
    assert.strictEqual(ip1.created_by, 'user', 'provenance preserved through round-trip');
    assert.ok(ip1.outcome_score > 0, 'learned reward signal (outcome_score) preserved');
    assert.strictEqual(ip1.review_status, 'pending', 'imported memory re-enters the review queue (untrusted file)');
    // Re-importing the same NDJSON dedupes (no new rows).
    const res2 = importMemories(ndjson);
    assert.strictEqual(res2.imported, 0);
    assert.strictEqual(res2.skipped, 2);
    db2.close(); _resetDb(); _setAutoEmbed(true);
  });

  it('skips malformed / invalid NDJSON lines without throwing', () => {
    const fdb = new Database(':memory:'); initSchema(fdb); _setTestDb(fdb); _setAutoEmbed(false);
    const nd = [
      'not json at all',
      JSON.stringify({ title: 'NoContent' }),
      JSON.stringify({ title: 'Good', content: 'a good import line' }),
      JSON.stringify({ title: 'X', content: 42 }),
    ].join('\n');
    let res;
    assert.doesNotThrow(() => { res = importMemories(nd); }, 'import never throws on bad lines');
    assert.strictEqual(res.imported, 1, 'only the well-formed line imports');
    assert.ok(res.skipped >= 2, 'malformed/invalid lines are skipped, not fatal');
    fdb.close(); _resetDb(); _setAutoEmbed(true);
  });
});

describe('memory bridge — brain memory systems + two-strength salience', () => {
  let db;
  const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const daysAgoSql = (n) => sqlTime(new Date(Date.now() - n * 86400000));
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); });
  after(() => { _setAutoEmbed(true); db.close(); _resetDb(); });

  it('rememberMemory defaults memory_system from type (semantic / episodic / procedural)', () => {
    const sem = rememberMemory({ title: 'S', content: 'sem one', created_by: 'user' });
    assert.strictEqual(getDocument(Number(sem.id)).memory_system, 'semantic');
    const epi = rememberMemory({ title: 'E', content: 'epi one', created_by: 'user', doc_type: 'session' });
    assert.strictEqual(getDocument(Number(epi.id)).memory_system, 'episodic');
    const proc = rememberMemory({ title: 'P', content: 'proc one', created_by: 'user', doc_type: 'fix' });
    assert.strictEqual(getDocument(Number(proc.id)).memory_system, 'procedural');
  });

  it('strengthenedStorage grows MORE when retrievability is low (spacing effect)', () => {
    const fresh = { storage_strength: 1, memory_system: 'semantic', last_accessed_at: sqlTime(new Date()), created_at: sqlTime(new Date()) };
    const stale = { storage_strength: 1, memory_system: 'semantic', last_accessed_at: daysAgoSql(60), created_at: daysAgoSql(60) };
    const dFresh = strengthenedStorage(fresh) - 1;
    const dStale = strengthenedStorage(stale) - 1;
    assert.ok(dStale > dFresh, `recalling a near-forgotten memory strengthens it more (${dStale} > ${dFresh})`);
  });

  it('episodic decays faster than semantic (lower salience after a gap)', () => {
    const gap = daysAgoSql(2);
    const base = { storage_strength: 1, importance: 0.5, confidence: 'asserted', outcome_score: 0, last_accessed_at: gap, created_at: gap };
    const epi = { ...base, memory_system: 'episodic' };
    const sem = { ...base, memory_system: 'semantic' };
    assert.ok(salienceOf(sem) > salienceOf(epi), 'semantic retains salience longer than episodic after 48h');
  });

  it('higher storage_strength stretches the half-life (slower decay)', () => {
    const gap = daysAgoSql(3);
    const weak = { memory_system: 'semantic', storage_strength: 1, importance: 0.5, confidence: 'asserted', outcome_score: 0, last_accessed_at: gap, created_at: gap };
    const strong = { ...weak, storage_strength: 5 };
    assert.ok(salienceOf(strong) > salienceOf(weak), 'a stronger trace stays more retrievable after the same gap');
  });

  it('recall grows storage_strength (FSRS)', async () => {
    const m = rememberMemory({ title: 'Grow', content: 'grow zzqss token', created_by: 'user' });
    const before = getDocument(Number(m.id)).storage_strength;
    await recallMemories('zzqss');
    const after = getDocument(Number(m.id)).storage_strength;
    assert.ok(after >= before, `storage_strength grows or holds on recall (${before} -> ${after})`);
  });

  it('prediction-error: high-confidence miss drops more; reinforcement diminishes', () => {
    const idx = c => ['verified', 'asserted', 'inferred', 'unverified'].indexOf(c);
    const hi = rememberMemory({ title: 'Hi', content: 'pe hi token', created_by: 'user', confidence: 'verified' });
    const lo = rememberMemory({ title: 'Lo', content: 'pe lo token', created_by: 'user', confidence: 'inferred' });
    const rh = recordMemoryOutcome(Number(hi.id), 'burned');
    const rl = recordMemoryOutcome(Number(lo.id), 'burned');
    assert.ok((idx(rh.confidence) - idx('verified')) >= (idx(rl.confidence) - idx('inferred')), 'high-confidence miss drops at least as many notches');
    // surprise shrinks: repeatedly confirming a memory gains less each time
    const m = rememberMemory({ title: 'Rep', content: 'pe rep token', created_by: 'user' });
    const a = recordMemoryOutcome(Number(m.id), 'helped');
    const b = recordMemoryOutcome(Number(m.id), 'helped');
    assert.ok((b.outcome_score - a.outcome_score) < a.outcome_score, 'reinforcement diminishes with each repeat');
  });

  it('markConsolidated demotes episodics from recall and links derived_from (CLS provenance)', async () => {
    const e1 = rememberMemory({ title: 'E1', content: 'consolidate zzqcons one', created_by: 'user', doc_type: 'session' });
    const e2 = rememberMemory({ title: 'E2', content: 'consolidate zzqcons two', created_by: 'user', doc_type: 'session' });
    const sem = rememberMemory({ title: 'Sem', content: 'consolidate zzqcons general rule', created_by: 'user' });
    markConsolidated([Number(e1.id), Number(e2.id)], Number(sem.id));
    assert.strictEqual(getDocument(Number(e1.id)).consolidated_into, Number(sem.id));
    assert.deepStrictEqual(JSON.parse(getDocument(Number(sem.id)).derived_from), [Number(e1.id), Number(e2.id)]);
    const recalled = (await recallMemories('zzqcons')).map(x => x.id);
    assert.ok(!recalled.includes(Number(e1.id)), 'consolidated episodic excluded from default recall');
    assert.ok(recalled.includes(Number(sem.id)), 'the semantic generalisation is recalled');
    const withAll = (await recallMemories('zzqcons', { includeSuperseded: true })).map(x => x.id);
    assert.ok(withAll.includes(Number(e1.id)), 'consolidated episodic still queryable with includeSuperseded');
  });
});

describe('memory bridge — bounded non-determinism + transparent workspace', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); });
  after(() => { _setAutoEmbed(true); db.close(); _resetDb(); });

  it('T=0 recall is deterministic, seed-independent, and matches the salience order', async () => {
    for (let i = 0; i < 6; i++) rememberMemory({ title: 'D' + i, content: `ndet token item ${i}`, created_by: 'user', importance: i / 10 });
    const a = (await recallMemories('ndet', { limit: 4, temperature: 0 })).map(x => x.id);
    const b = (await recallMemories('ndet', { limit: 4, temperature: 0, seed: 999 })).map(x => x.id);
    assert.deepStrictEqual(a, b, 'T=0 is deterministic and seed-independent');
  });

  it('temperature>0 samples stochastically (reproducible by seed; differs from T=0)', async () => {
    for (let i = 0; i < 8; i++) rememberMemory({ title: 'S' + i, content: `seedtok token ${i}`, created_by: 'user', importance: i / 8 });
    const r1 = (await recallMemories('seedtok', { limit: 3, temperature: 1.0, seed: 42 })).map(x => x.id);
    const r2 = (await recallMemories('seedtok', { limit: 3, temperature: 1.0, seed: 42 })).map(x => x.id);
    assert.deepStrictEqual(r1, r2, 'same seed+temperature reproduces an identical sample');
    assert.strictEqual(new Set(r1).size, 3, 'returns the requested number of distinct memories');
    // negative control: across several seeds, at least one high-T sample differs from the T=0 top-k
    const t0 = (await recallMemories('seedtok', { limit: 3, temperature: 0 })).map(x => x.id);
    let anyDiff = false;
    for (const s of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const r = (await recallMemories('seedtok', { limit: 3, temperature: 2.0, seed: s })).map(x => x.id);
      if (JSON.stringify(r) !== JSON.stringify(t0)) { anyDiff = true; break; }
    }
    assert.ok(anyDiff, 'high temperature actually samples differently from deterministic top-k');
  });

  it('recallTraced writes an auditable workspace blackboard', async () => {
    rememberMemory({ title: 'W1', content: 'wstok token alpha', created_by: 'user' });
    rememberMemory({ title: 'W2', content: 'wstok token beta', created_by: 'user' });
    const out = await recallTraced('wstok', { limit: 2 });
    assert.ok(out.cycle_id && Array.isArray(out.results), 'returns cycle_id + results');
    assert.ok(out.workspace.length >= 2, 'workspace has agent rows');
    assert.ok(out.workspace.some(w => w.agent === 'librarian'), 'librarian step logged');
    assert.ok(out.workspace.some(w => w.agent === 'salience-router' && w.vote === 'broadcast'), 'salience-router logged a broadcast vote');
  });
});

describe('memory bridge — prioritised replay (consolidation order)', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); });
  after(() => { _setAutoEmbed(true); db.close(); _resetDb(); });

  it('surprise is load-bearing: equal importance, the burned (surprising) memory replays first', () => {
    const a = rememberMemory({ title: 'a', content: 'replay a', created_by: 'user', importance: 0.5 });
    const b = rememberMemory({ title: 'b', content: 'replay b', created_by: 'user', importance: 0.5 });
    recordMemoryOutcome(Number(a.id), 'burned'); // only a gains surprise (|outcome_score|)
    const q = getReplayQueue({ limit: 10 });
    const iA = q.findIndex(x => x.id === Number(a.id));
    const iB = q.findIndex(x => x.id === Number(b.id));
    assert.ok(iA >= 0 && iB >= 0 && iA < iB, 'with equal importance, the surprising memory replays first');
  });
});

describe('memory bridge — MMR diversity recall', () => {
  let db;
  // A near-duplicate pair (qqa ~ qqb, cosine ~0.99) plus a relevant-but-distinct item (qqc, cosine ~0.6).
  function mmrEmbed(text) {
    const t = String(text).toLowerCase();
    if (t.includes('qqb')) return new Float32Array([1, 0.14, 0, 0]);   // near-dup of qqa
    if (t.includes('qqc')) return new Float32Array([0.6, 0, 0.8, 0]);  // distinct aspect
    return new Float32Array([1, 0, 0, 0]);                             // qqa + the query
  }
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(mmrEmbed); });
  after(() => { _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb(); });

  it('MMR returns a complementary set instead of the near-duplicate', async () => {
    const a = rememberMemory({ title: 'A', content: 'qqa deploy memory', created_by: 'user' });
    const b = rememberMemory({ title: 'B', content: 'qqb deploy memory near dup', created_by: 'user' });
    const c = rememberMemory({ title: 'C', content: 'qqc deploy distinct aspect', created_by: 'user' });
    await embedMemory(Number(a.id)); await embedMemory(Number(b.id)); await embedMemory(Number(c.id));
    const plain = (await recallMemories('qqa deploy', { limit: 2 })).map(x => x.id);
    const diverse = (await recallMemories('qqa deploy', { limit: 2, diversity: 0.5 })).map(x => x.id);
    assert.ok(plain.includes(Number(a.id)), 'plain top-k includes the best match A');
    assert.ok(!plain.includes(Number(c.id)), 'plain top-k (limit 2) misses C in favour of the near-duplicate B');
    assert.ok(diverse.includes(Number(c.id)), 'MMR surfaces the distinct aspect C instead of the paraphrase');
  });
});

describe('memory bridge — migration on a NON-EMPTY table (SQLite constant-default trap)', () => {
  it('adds memory columns to an existing documents table that already has rows', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL,
      content_hash TEXT, source TEXT, doc_type TEXT NOT NULL, tags TEXT DEFAULT '',
      file_path TEXT, file_size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
    db.prepare("INSERT INTO documents (title, content, doc_type) VALUES ('old','old content','text')").run();
    assert.doesNotThrow(() => initSchema(db), 'migration must not throw on a non-empty table');
    const row = db.prepare('SELECT * FROM documents WHERE title = ?').get('old');
    assert.strictEqual(row.created_by, 'system', 'legacy row backfilled with constant default');
    assert.strictEqual(row.importance, 0.5);
    assert.strictEqual(row.review_status, 'none');
    assert.strictEqual(row.verified_at, null, 'nullable datetime stays null');
    db.close();
  });
});

describe('memory bridge — tool handlers', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); });
  after(() => { _setAutoEmbed(true); db.close(); _resetDb(); });

  it('kb_remember hardcodes agent provenance (cannot be forged) + kb_recall round-trip', async () => {
    const rem = getTool('kb_remember');
    assert.ok(rem, 'kb_remember exists');
    // Even if a caller passes created_by:'user', the MCP tool must store it as 'agent' (no forgery).
    const res = await rem.handler({ title: 'T', content: 'tool zzqI memory body', reasoning: 'r', created_by: 'user' });
    assert.ok(!res.isError, res.content[0].text);
    assert.strictEqual(JSON.parse(res.content[0].text).created_by, 'agent', 'MCP write cannot forge user provenance');
    const recall = getTool('kb_recall');
    const rr = await recall.handler({ query: 'zzqI' });
    assert.ok(!rr.isError);
    assert.ok(rr.content[0].text.includes('zzqI'), 'recall returns the memory');
    assert.ok(rr.content[0].text.includes('created_by'), 'recall surfaces provenance');
  });

  it('kb_memory_review lists pending and rejects', async () => {
    const rem = getTool('kb_remember');
    const r = await rem.handler({ title: 'P', content: 'tool zzqJ pending body' }); // agent
    const created = JSON.parse(r.content[0].text);
    const review = getTool('kb_memory_review');
    const list = await review.handler({ action: 'list' });
    assert.ok(list.content[0].text.includes(String(created.id)), 'pending lists the new memory');
    const rej = await review.handler({ action: 'reject', id: Number(created.id) });
    assert.ok(!rej.isError);
    assert.ok(rej.content[0].text.includes('rejected'));
  });

  it('kb_ingest preserves tags (regression for the positional-arg bug)', async () => {
    const ing = getTool('kb_ingest');
    const res = await ing.handler({ title: 'Tagged', content: 'tagged zzqK content body', tags: 'alpha,beta' });
    const doc = JSON.parse(res.content[0].text);
    const row = getDocument(Number(doc.id));
    assert.ok(row.tags.includes('alpha') && row.tags.includes('beta'), `tags should persist, got: "${row.tags}"`);
  });

  it('kb_memory_review is admin-gated (excluded from HTTP tool set)', () => {
    assert.ok(!getHttpToolDefinitions().some(t => t.name === 'kb_memory_review'), 'review tool not exposed over HTTP');
    const httpNames = getHttpToolDefinitions().map(t => t.name);
    assert.ok(httpNames.includes('kb_remember') && httpNames.includes('kb_recall'));
  });
});
