// Integration test for the sync IO shell against the REAL kb.db. It only ever adds/removes clearly-marked
// 'SYNCTEST%' rows (never touches the user's real memories — no peer record shares their content_hash) and
// uses a throwaway temp sync dir. Cleans up in finally. Run: `node test/memory-sync.integration.mjs`.
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/db.js';
import { syncMemories, exportSyncRecords, recall, briefMarkdown, _setAutoEmbed } from '../src/memory/store.js';

_setAutoEmbed(false);                                  // offline: no model load
const hash = (c) => createHash('sha256').update(c).digest('hex').slice(0, 32);
const db = getDb();
let pass = 0, fail = 0, dir;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); } };
const countTest = () => db.prepare("SELECT COUNT(*) c FROM memories WHERE content LIKE 'SYNCTEST%'").get().c;

try {
  dir = mkdtempSync(join(tmpdir(), 'kaiba-sync-'));
  const rightHash = hash('SYNCTEST-right');
  const peer = [
    { content_hash: hash('SYNCTEST-new'), content: 'SYNCTEST-new', kind: 'semantic', created_by: 'user', confidence: 'asserted', importance: 0.8, review_status: 'accepted', outcome: 0, use_count: 0, created_at: '2026-05-01 00:00:00' },
    { content_hash: hash('SYNCTEST-wrong'), content: 'SYNCTEST-wrong', kind: 'semantic', created_by: 'user', confidence: 'asserted', importance: 0.7, review_status: 'accepted', superseded_by_hash: rightHash, supersession_reason: 'corrected on peer', created_at: '2026-05-01 00:00:00' },
    { content_hash: rightHash, content: 'SYNCTEST-right', kind: 'semantic', created_by: 'user', confidence: 'verified', importance: 0.85, review_status: 'accepted', created_at: '2026-05-02 00:00:00' },
  ];
  const writePeer = (recs) => writeFileSync(join(dir, 'kaiba-brain.peerbox.ndjson'), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  writePeer(peer);

  const before = countTest();

  // --- R6 + dry-run: reports 3 new, writes NOTHING (db unchanged, no own-file) ---
  const dry = await syncMemories({ dir, dryRun: true });
  t('dry-run: pulledNew === 3', () => assert.strictEqual(dry.pulledNew, 3));
  t('dry-run: db unchanged', () => assert.strictEqual(countTest(), before));
  t('dry-run: no own-file written', () => assert.ok(!readdirSync(dir).some(f => f.includes('peerbox') ? false : f.endsWith('.ndjson'))));

  // --- real sync: inserts 3, resolves supersession, own-file written ---
  const real = await syncMemories({ dir });
  t('real: 3 inserted', () => assert.strictEqual(countTest(), before + 3));
  t('real: own-file written, NDJSON only (R6 — no kb.db in sync dir)', () => {
    const files = readdirSync(dir);
    assert.ok(files.some(f => /^kaiba-brain\..+\.ndjson$/.test(f) && !f.includes('peerbox')), 'own file present');
    assert.ok(!files.some(f => f.endsWith('.db') || f.endsWith('.db-wal')), 'no sqlite files');
  });

  // --- R7: the superseded test row is linked AND excluded from brief/recall ---
  const wrongRow = db.prepare("SELECT * FROM memories WHERE content = 'SYNCTEST-wrong'").get();
  const rightRow = db.prepare("SELECT * FROM memories WHERE content = 'SYNCTEST-right'").get();
  t('R7: superseded_by resolved to local id of the superseding row', () => {
    assert.strictEqual(wrongRow.superseded_by_hash, rightHash);
    assert.strictEqual(wrongRow.superseded_by, rightRow.id);
  });
  const got = await recall('SYNCTEST', { limit: 10 });
  const contents = got.map(r => r.content);
  t('recall excludes superseded, includes the new + corrected', () => {
    assert.ok(!contents.includes('SYNCTEST-wrong'), 'wrong (superseded) excluded');
    assert.ok(contents.includes('SYNCTEST-new'), 'new included');
    assert.ok(contents.includes('SYNCTEST-right'), 'corrected included');
  });
  t('briefMarkdown does not surface the superseded row', () => {
    assert.ok(!briefMarkdown().includes('SYNCTEST-wrong'));
  });

  // --- R3 idempotent: immediate re-sync of the same peer is a no-op ---
  const again = await syncMemories({ dir });
  t('R3: re-sync pulls 0 new, 0 updated', () => { assert.strictEqual(again.pulledNew, 0); assert.strictEqual(again.pulledUpdated, 0); });

  // --- FTS-safety on the UPDATE path: bump importance on peer, re-sync → UPDATE fires memories_au; FTS still queryable ---
  writePeer(peer.map(r => r.content === 'SYNCTEST-new' ? { ...r, importance: 0.95 } : r));
  const bumped = await syncMemories({ dir });
  t('UPDATE path: importance change applied as 1 update', () => assert.strictEqual(bumped.pulledUpdated, 1));
  t('FTS intact after UPDATE (MATCH query still returns the row)', () => {
    const n = db.prepare("SELECT COUNT(*) c FROM memories_fts WHERE memories_fts MATCH 'SYNCTEST'").get().c;
    assert.ok(n >= 3, `expected >=3 FTS hits, got ${n}`);
  });
  t('UPDATE applied: importance is now 0.95', () => {
    assert.strictEqual(db.prepare("SELECT importance i FROM memories WHERE content='SYNCTEST-new'").get().i, 0.95);
  });

  // --- exportSyncRecords includes superseded rows with a resolved hash (the real #5 too, if present) ---
  t('exportSyncRecords includes superseded rows with resolved hash', () => {
    const recs = exportSyncRecords();
    const w = recs.find(r => r.content === 'SYNCTEST-wrong');
    assert.ok(w && w.superseded_by_hash === rightHash, 'superseded test row exported with hash');
  });

  // --- robustness (verifier MAJOR): a garbled peer `confidence` must NOT corrupt the stored enum or churn ---
  writePeer([{ content_hash: hash('SYNCTEST-bogus'), content: 'SYNCTEST-bogus', kind: 'semantic', created_by: 'user', confidence: 'totally-bogus', review_status: 'accepted', importance: 0.5, created_at: '2026-05-03 00:00:00' }]);
  await syncMemories({ dir });                                  // round 1: insert (sanitizes confidence -> inferred)
  const reSync = await syncMemories({ dir });                   // round 2: merge against the still-bogus peer line
  t('garbled peer confidence is sanitized, not stored raw', () => {
    const c = db.prepare("SELECT confidence FROM memories WHERE content='SYNCTEST-bogus'").get().confidence;
    assert.ok(['verified', 'asserted', 'inferred', 'unverified'].includes(c), `confidence in ladder, got "${c}"`);
  });
  t('garbled peer confidence causes no perpetual churn (fixpoint)', () => assert.strictEqual(reSync.pulledUpdated, 0));
} catch (e) {
  fail++; console.error('FAIL (threw)\n      ' + (e.stack || e.message));
} finally {
  // cleanup: remove only SYNCTEST rows + temp dir; leave the user's real memories untouched
  try { db.prepare("DELETE FROM memories WHERE content LIKE 'SYNCTEST%'").run(); } catch (e) { console.error('cleanup rows failed:', e.message); }
  try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error('cleanup dir failed:', e.message); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
