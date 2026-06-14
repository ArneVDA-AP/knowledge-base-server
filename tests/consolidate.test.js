import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
  initSchema, _setTestDb, _resetDb, _setTestEmbedder, _setAutoEmbed, getDocument, rememberMemory,
} from '../src/db.js';
import { consolidate, extractCandidates, consolidateEpisodics } from '../src/consolidate.js';

// Deterministic fake embedder: orthogonal topic axes so dedupe is predictable.
function fakeEmbed(text) {
  const t = String(text).toLowerCase();
  const v = [0, 0, 0, 0.0001];
  if (/systemd|deploy|pm2|server|rollout/.test(t)) v[0] += 1;
  if (/cors|wildcard|origin|extension/.test(t)) v[1] += 1;
  if (/test|vitest|jest|coverage/.test(t)) v[2] += 1;
  const mag = Math.hypot(...v) || 1;
  return new Float32Array(v.map(x => x / mag));
}

// Fake extractor: two orthogonal, durable memories.
const fakeExtract = async () => JSON.stringify({
  memories: [
    { title: 'Deploy via systemd', content: 'we deploy with systemd not pm2', reasoning: 'pm2 was flaky on this host', type: 'decision', importance: 0.8 },
    { title: 'CORS wildcard for extension', content: 'wildcard CORS origin required for the firefox extension', reasoning: 'moz-extension origins are dynamic', type: 'lesson', importance: 0.7 },
  ],
});

describe('consolidate — session-close continuous learning', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(fakeEmbed); });
  after(() => { _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb(); });

  it('extractCandidates parses memories JSON and tolerates code fences', async () => {
    const cands = await extractCandidates('session text', {
      extractFn: async () => '```json\n{"memories":[{"title":"x","content":"y"}]}\n```',
    });
    assert.strictEqual(cands.length, 1);
    assert.strictEqual(cands[0].title, 'x');
  });

  it('extractCandidates returns [] on unparseable output (never throws)', async () => {
    const cands = await extractCandidates('s', { extractFn: async () => 'not json at all' });
    assert.deepStrictEqual(cands, []);
  });

  it('extractCandidates pulls JSON out of prose-wrapped model output', async () => {
    const cands = await extractCandidates('s', { extractFn: async () => 'Sure! Here are the memories:\n{"memories":[{"title":"p","content":"q"}]}\nHope that helps.' });
    assert.strictEqual(cands.length, 1);
    assert.strictEqual(cands[0].title, 'p');
  });

  it('dry-run extracts but writes nothing', async () => {
    const r = await consolidate('sess', { dryRun: true, extractFn: fakeExtract });
    assert.strictEqual(r.extracted, 2);
    assert.strictEqual(r.written, 0);
    assert.ok(r.items.every(i => i.action === 'would-write'), 'all items are previews');
  });

  it('real run writes agent/pending memories with reasoning, then dedupes on re-run', async () => {
    const r = await consolidate('sess', { extractFn: fakeExtract });
    assert.strictEqual(r.written, 2, 'both new memories written');
    assert.strictEqual(r.skipped, 0);

    const writtenItem = r.items.find(i => i.action === 'written');
    const doc = getDocument(writtenItem.id);
    assert.strictEqual(doc.created_by, 'agent', 'consolidated memory is agent-authored');
    assert.strictEqual(doc.review_status, 'pending', 'enters the review queue');
    assert.strictEqual(doc.author_detail, 'consolidation', 'tagged as consolidation');
    assert.ok(doc.reasoning && doc.reasoning.length > 0, 'reasoning persisted');

    // Re-consolidating the same session must not duplicate (semantic dedupe).
    const r2 = await consolidate('sess', { extractFn: fakeExtract });
    assert.strictEqual(r2.written, 0, 'no new writes on re-consolidation');
    assert.strictEqual(r2.skipped, 2, 'both recognized as duplicates');
    assert.ok(r2.items.every(i => i.action === 'skipped-duplicate'));
  });
});

describe('consolidateEpisodics — CLS episodic→semantic generalisation', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(fakeEmbed); });
  after(() => { _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb(); });

  it('generalises episodics into a semantic memory and demotes the sources', async () => {
    const e1 = rememberMemory({ title: 'E1', content: 'deployed with systemd on monday', created_by: 'user', doc_type: 'session' });
    const e2 = rememberMemory({ title: 'E2', content: 'deployed with systemd again on tuesday', created_by: 'user', doc_type: 'session' });
    assert.strictEqual(getDocument(Number(e1.id)).memory_system, 'episodic');
    const fakeExtract = async () => JSON.stringify({ memories: [{ title: 'Deploy via systemd', content: 'we deploy with systemd', reasoning: 'observed repeatedly', importance: 0.8, source_ids: [Number(e1.id), Number(e2.id)] }] });
    const res = await consolidateEpisodics({ extractFn: fakeExtract });
    assert.strictEqual(res.written, 1, 'one semantic generalisation written');
    assert.strictEqual(res.demoted, 2, 'both source episodics demoted');
    const sem = getDocument(res.items.find(i => i.action === 'written').id);
    assert.strictEqual(sem.memory_system, 'semantic', 'generalisation is a semantic memory');
    assert.deepStrictEqual(JSON.parse(sem.derived_from), [Number(e1.id), Number(e2.id)], 'provenance linked');
    assert.strictEqual(getDocument(Number(e1.id)).consolidated_into, Number(sem.id), 'episodic linked to its semantic');
  });

  it('dry-run generalises nothing', async () => {
    rememberMemory({ title: 'E3', content: 'fixed a flaky test by adding a wait', created_by: 'user', doc_type: 'session' });
    const fakeExtract = async () => JSON.stringify({ memories: [{ title: 'X', content: 'y', source_ids: [] }] });
    const res = await consolidateEpisodics({ extractFn: fakeExtract, dryRun: true });
    assert.strictEqual(res.written, 0);
    assert.ok(res.items.every(i => i.action === 'would-write'));
  });
});
