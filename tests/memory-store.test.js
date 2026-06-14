// tests/memory-store.test.js — the first-principles memory store (docs/memory-bridge/07).
// Covers the `memories` entity, the one salience formula, the human-disposed review queue, the brief
// (THE session load), consolidation (THE ambient save), portability, migration, the re-pointed MCP
// tools, and the spine wiring. Fast + offline: in-memory SQLite + a deterministic fake embedder.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { initSchema, _setTestDb, _resetDb, insertDocument } from '../src/db.js';
import {
  remember, recall, brief, briefMarkdown, getMemory, listPending, review, supersede,
  recordOutcome, salienceOf, consolidate, migrateFromDocuments, exportNDJSON, importNDJSON,
  backfillEmbeddings, extractResultText, _setTestEmbedder, _setAutoEmbed,
} from '../src/memory/store.js';
import { getToolDefinitions } from '../src/tools.js';
import {
  briefHookOutput, installSpine, spineStatus, uninstallSpine, extractTranscriptText,
} from '../src/memory/spine.js';

// Deterministic fake embedder: keyword → small topic-space vector. Real-model semantics verified e2e.
function fakeEmbed(text) {
  const t = String(text).toLowerCase();
  const v = [0, 0, 0, 0.0001];
  if (/deploy|systemd|pm2|server|infra|release|rollout/.test(t)) v[0] += 1;
  if (/cat|mat|animal|pet|dog|kitten/.test(t)) v[1] += 1;
  if (/memory|bridge|recall|salience|provenance|brain/.test(t)) v[2] += 1;
  const mag = Math.hypot(...v) || 1;
  return new Float32Array(v.map(x => x / mag));
}
const getTool = (name) => getToolDefinitions().find(t => t.name === name);

describe('memory store — the entity, salience, and the disposed queue', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(fakeEmbed); });
  after(() => { _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb(); });

  it('agent writes are pending + capped below verified; user writes are accepted', () => {
    const am = remember({ content: 'agent zzqB spawns a shell', reasoning: 'why', created_by: 'agent', confidence: 'verified' });
    assert.strictEqual(am.created_by, 'agent');
    assert.strictEqual(am.review_status, 'pending');
    assert.notStrictEqual(am.confidence, 'verified', 'agent cannot self-declare verified');

    const um = remember({ content: 'user zzqC prefers concise replies', created_by: 'user' });
    assert.strictEqual(um.created_by, 'user');
    assert.strictEqual(um.review_status, 'accepted');
    assert.strictEqual(um.confidence, 'asserted');
  });

  it('a user may declare verified; kind defaults to semantic', () => {
    const m = remember({ content: 'user zzqV verified fact', created_by: 'user', confidence: 'verified' });
    assert.strictEqual(m.confidence, 'verified');
    assert.strictEqual(m.kind, 'semantic');
  });

  it('dedup by content hash returns the existing memory (no duplicate row)', () => {
    const a = remember({ content: 'dedupe zzqD identical content', created_by: 'user' });
    const b = remember({ content: 'dedupe zzqD identical content', created_by: 'user' });
    assert.strictEqual(a.id, b.id);
  });

  it('remember throws on non-string content (defensive)', () => {
    assert.throws(() => remember({ content: null, created_by: 'user' }));
  });

  it('recall strengthens what it surfaces (use_count bumps, last_used_at set)', async () => {
    const m = remember({ content: 'recall zzqE strengthen token', created_by: 'user' });
    assert.strictEqual(getMemory(m.id).use_count, 0);
    const hits = await recall('zzqE');
    assert.ok(hits.some(h => h.id === m.id), 'recalled');
    assert.strictEqual(getMemory(m.id).use_count, 1, 'use_count bumped');
    assert.ok(getMemory(m.id).last_used_at, 'last_used_at set');
  });

  it('rejected memories are excluded from recall', async () => {
    const m = remember({ content: 'reject zzqF proposal token', created_by: 'agent' });
    review(m.id, 'reject');
    assert.ok(!(await recall('zzqF')).some(h => h.id === m.id), 'rejected excluded');
  });

  it('supersede demotes: out of default recall, back with includeSuperseded', async () => {
    const oldM = remember({ content: 'super zzqG old belief token', created_by: 'user' });
    const neu = remember({ content: 'super zzqG new belief token', created_by: 'user' });
    supersede(oldM.id, neu.id, 'corrected');
    const def = (await recall('zzqG')).map(h => h.id);
    assert.ok(!def.includes(oldM.id), 'superseded out of default recall');
    const inc = (await recall('zzqG', { includeSuperseded: true })).map(h => h.id);
    assert.ok(inc.includes(oldM.id), 'superseded returns with the flag');
  });

  it('outcome → trust: a burn lowers confidence one notch + decrements outcome; helped increments', () => {
    const m = remember({ content: 'burn zzqH token', created_by: 'user', confidence: 'verified' });
    const burned = recordOutcome(m.id, 'burned');
    assert.strictEqual(burned.confidence, 'asserted', 'burn demotes verified → asserted');
    assert.strictEqual(burned.outcome, -1);
    const helped = recordOutcome(m.id, 'helped');
    assert.strictEqual(helped.outcome, 0, 'helped raises outcome back');
  });

  it('semantic recall ranks by topic (with embeddings), not keyword overlap', async () => {
    const deploy = remember({ content: 'we deploy with systemd not pm2', created_by: 'user' });
    remember({ content: 'the cat sat on the mat', created_by: 'user' });
    await backfillEmbeddings();
    const hits = await recall('release rollout approach', { limit: 2 });
    assert.strictEqual(hits[0].id, deploy.id, 'deploy memory wins on topic similarity');
    assert.strictEqual(hits[0].relevance_source, 'semantic');
  });

  it('recall falls back to FTS when no embeddings exist (memories born indexed)', async () => {
    // Isolated store: the semantic path engages whenever ANY candidate has an embedding, so prove the
    // born-indexed FTS fallback in a clean db where nothing is embedded.
    const clean = new Database(':memory:'); initSchema(clean); _setTestDb(clean);
    const m = remember({ content: 'fallback zzqFB unique fts token', created_by: 'user' });
    const hits = await recall('zzqFB'); // no embeddings anywhere → FTS path
    assert.ok(hits.some(h => h.id === m.id), 'FTS fallback finds it');
    assert.strictEqual(hits.find(h => h.id === m.id).relevance_source, 'fts');
    clean.close(); _setTestDb(db);
  });
});

describe('salience formula', () => {
  it('weights importance, confidence, and outcome as specified', () => {
    const base = { kind: 'semantic', importance: 0.5, confidence: 'verified', outcome: 0, created_at: null, last_used_at: null };
    const verified = salienceOf({ ...base }, 1);
    const inferred = salienceOf({ ...base, confidence: 'inferred' }, 1);
    assert.ok(verified > inferred, 'verified outranks inferred');
    const important = salienceOf({ ...base, importance: 1 }, 1);
    assert.ok(important > verified, 'higher importance ranks higher');
    const helped = salienceOf({ ...base, outcome: 2 }, 1);
    const burned = salienceOf({ ...base, outcome: -2 }, 1);
    assert.ok(helped > verified && verified > burned, 'outcome multiplier moves salience');
  });

  it('episodic decays faster than procedural for the same age', () => {
    const old = { importance: 0.5, confidence: 'verified', outcome: 0, created_at: '2000-01-01 00:00:00', last_used_at: null };
    const epi = salienceOf({ ...old, kind: 'episodic' }, 1);
    const proc = salienceOf({ ...old, kind: 'procedural' }, 1);
    assert.ok(proc > epi, 'procedural retains salience longer than episodic');
  });
});

describe('extractResultText — tolerate the real claude CLI envelope shapes', () => {
  it('pulls .result from a stream-event ARRAY (the shape the live CLI returns)', () => {
    const stdout = JSON.stringify([
      { type: 'system', subtype: 'init', session_id: 'x' },
      { type: 'assistant', message: { role: 'assistant' } },
      { type: 'result', subtype: 'success', result: '{"memories":[{"content":"c"}]}' },
    ]);
    assert.strictEqual(extractResultText(stdout), '{"memories":[{"content":"c"}]}');
  });
  it('pulls .result from a single result object', () => {
    assert.strictEqual(extractResultText(JSON.stringify({ type: 'result', result: 'hello' })), 'hello');
  });
  it('passes raw text through when stdout is not JSON', () => {
    assert.strictEqual(extractResultText('plain text answer'), 'plain text answer');
  });
  it('returns empty string for a JSON envelope with no result field (no crash)', () => {
    assert.strictEqual(extractResultText(JSON.stringify({ type: 'error' })), '');
    assert.strictEqual(extractResultText(JSON.stringify([{ type: 'system' }])), '');
  });
});

describe('brief — THE session load', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(fakeEmbed); });
  after(() => { _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb(); });

  it('CORE is ordered by importance; pending count reflects the queue; markdown renders', () => {
    const hi = remember({ content: 'never drop the documents table', created_by: 'user', importance: 0.98 });
    remember({ content: 'a minor aside', created_by: 'user', importance: 0.1 });
    remember({ content: 'an agent proposal awaiting review', created_by: 'agent' }); // pending
    const b = brief({ core: 5, recent: 5 });
    assert.strictEqual(b.core[0].id, hi.id, 'highest-importance memory leads CORE');
    assert.strictEqual(b.pending, 1, 'one pending proposal counted');
    assert.ok(b.core.every(m => m.review_status === 'accepted'), 'pending never leaks into CORE');
    const md = briefMarkdown({ core: 5, recent: 5 });
    assert.match(md, /Memory brief/);
    assert.match(md, /never drop the documents table/);
    assert.match(md, /awaiting your review/);
  });

  it('an empty store yields an empty markdown brief (no noise)', () => {
    const db2 = new Database(':memory:'); initSchema(db2); _setTestDb(db2);
    assert.strictEqual(briefMarkdown({}), '');
    db2.close(); _setTestDb(db);
  });
});

describe('consolidation — THE ambient save — closes the save→load loop', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(fakeEmbed); });
  after(() => { _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb(); });

  const fakeExtract = async () => JSON.stringify({
    memories: [
      { kind: 'semantic', content: 'we deploy with systemd not pm2', reasoning: 'pm2 was flaky here', importance: 0.8 },
      { kind: 'procedural', content: 'reindex the vault after bulk edits', reasoning: 'hash-incremental misses external writes', importance: 0.6 },
    ],
  });

  it('extracts durable memories → writes them pending → a fresh brief surfaces them once accepted', async () => {
    const res = await consolidate('a long session transcript...', { extractFn: fakeExtract });
    assert.strictEqual(res.extracted, 2);
    assert.strictEqual(res.written, 2);
    // Written as agent/pending — not yet in the load-bearing brief.
    let b = brief({ core: 10, recent: 10 });
    assert.strictEqual(b.core.length, 0, 'pending memories are NOT auto-loaded');
    assert.strictEqual(b.pending, 2);
    // The human disposes → accept both.
    for (const p of listPending()) review(p.id, 'accept');
    b = brief({ core: 10, recent: 10 });
    assert.strictEqual(b.core.length, 2, 'accepted memories now auto-load — save→load loop closed');
    assert.ok(b.core.some(m => /systemd/.test(m.content)));
  });

  it('dry run extracts without writing; bad extractor output never throws', async () => {
    const before = listPending().length;
    const dry = await consolidate('x', { extractFn: fakeExtract, dryRun: true });
    assert.strictEqual(dry.written, 0);
    assert.strictEqual(listPending().length, before, 'dry run wrote nothing');
    const junk = await consolidate('x', { extractFn: async () => 'not json at all' });
    assert.strictEqual(junk.extracted, 0);
  });
});

describe('portability — export / import NDJSON', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(fakeEmbed); });
  after(() => { _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb(); });

  it('round-trips, re-enters the review queue, caps confidence, dedupes, and never throws on junk', () => {
    remember({ content: 'portable verified fact one', created_by: 'user', confidence: 'verified', importance: 0.8 });
    remember({ content: 'portable proposal two', created_by: 'agent' });
    const ndjson = exportNDJSON();
    assert.strictEqual(ndjson.split('\n').filter(Boolean).length, 2);

    // Import into a clean store: untrusted file → everything pending, confidence capped at inferred.
    const db2 = new Database(':memory:'); initSchema(db2); _setTestDb(db2);
    const res = importNDJSON(ndjson);
    assert.strictEqual(res.imported, 2);
    const imported = listPending({ limit: 50 });
    assert.strictEqual(imported.length, 2, 'imported memories enter the review queue');
    assert.ok(imported.every(m => m.confidence === 'inferred'), 'verified is downgraded on untrusted import');
    // Re-import is idempotent (content-hash dedupe).
    assert.strictEqual(importNDJSON(ndjson).imported, 0);
    // Malformed lines are skipped, not fatal.
    assert.doesNotThrow(() => importNDJSON('not json\n{"no":"content"}\n'));
    db2.close(); _setTestDb(db);
  });
});

describe('migration — lift documents-based memories into the entity table', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(fakeEmbed); });
  after(() => { _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb(); });

  it('migrates user/agent documents (preserving provenance + review status), skips system docs and dupes', async () => {
    insertDocument({ title: 'U', content: 'migrated user decision: ship on fridays', created_by: 'user', confidence: 'asserted', review_status: 'accepted', memory_system: 'semantic', doc_type: 'decision' });
    insertDocument({ title: 'A', content: 'migrated agent guess: cache is warm', created_by: 'agent', confidence: 'inferred', review_status: 'pending', memory_system: 'episodic', doc_type: 'session' });
    insertDocument({ title: 'Sys', content: 'a plain ingested system document', created_by: 'system', doc_type: 'text' });

    const r = migrateFromDocuments();
    assert.strictEqual(r.migrated, 2, 'only the two memory documents migrate');
    const hits = await recall('migrated', { limit: 10, includeSuperseded: true });
    const byProv = Object.fromEntries(hits.map(h => [h.created_by, true]));
    assert.ok(byProv.user && byProv.agent, 'both provenances preserved');
    // Re-running migration is idempotent (content-hash dedupe).
    assert.strictEqual(migrateFromDocuments().migrated, 0);
  });
});

describe('re-pointed MCP tools (agent-facing surface)', () => {
  let db;
  before(() => { db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(fakeEmbed); });
  after(() => { _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb(); });

  it('kb_remember hardcodes agent provenance (an MCP caller cannot forge user)', async () => {
    const out = await getTool('kb_remember').handler({ content: 'tool wrote zzqMCP memory', reasoning: 'r' });
    const m = JSON.parse(out.content[0].text);
    assert.strictEqual(m.created_by, 'agent');
    assert.strictEqual(m.review_status, 'pending');
  });

  it('the speculative tools are retired from the core', () => {
    const names = getToolDefinitions().map(t => t.name);
    assert.ok(!names.includes('kb_workspace'), 'kb_workspace removed');
    assert.ok(!names.includes('kb_memory_conflicts'), 'kb_memory_conflicts removed');
    // The lean set survives.
    for (const n of ['kb_remember', 'kb_recall', 'kb_memory_outcome', 'kb_supersede', 'kb_memory_review', 'kb_consolidate', 'kb_session_brief']) {
      assert.ok(names.includes(n), `lean tool present: ${n}`);
    }
  });

  it('kb_session_brief returns the {core, recent, pending} load payload', async () => {
    remember({ content: 'a high-value rule for kb_session_brief', created_by: 'user', importance: 0.9 });
    const out = await getTool('kb_session_brief').handler({ core: 5, recent: 5 });
    const b = JSON.parse(out.content[0].text.split('\n\n').slice(1).join('\n\n'));
    assert.ok(Array.isArray(b.core) && Array.isArray(b.recent));
    assert.strictEqual(typeof b.pending, 'number');
  });
});

describe('the spine wiring', () => {
  let db;
  let settingsPath;
  before(() => {
    db = new Database(':memory:'); initSchema(db); _setTestDb(db); _setAutoEmbed(false); _setTestEmbedder(fakeEmbed);
    settingsPath = join(tmpdir(), `kaiba-spine-${randomBytes(6).toString('hex')}.json`);
  });
  after(() => {
    _setTestEmbedder(null); _setAutoEmbed(true); db.close(); _resetDb();
    try { rmSync(settingsPath); } catch {}
    try { rmSync(settingsPath + '.bak-kaiba'); } catch {}
  });

  it('briefHookOutput is valid SessionStart hook JSON with additionalContext', () => {
    remember({ content: 'spine load-bearing memory', created_by: 'user', importance: 0.9 });
    const out = JSON.parse(briefHookOutput({}));
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.strictEqual(typeof out.hookSpecificOutput.additionalContext, 'string');
    assert.match(out.hookSpecificOutput.additionalContext, /spine load-bearing memory/);
  });

  it('installSpine merges idempotently and preserves a pre-existing unrelated hook', () => {
    // Seed an unrelated hook the user already had.
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } }));
    const first = installSpine({ settingsPath });
    assert.deepStrictEqual(first.added.sort(), ['SessionStart', 'Stop']);
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const startCmds = s.hooks.SessionStart.flatMap(g => g.hooks.map(h => h.command));
    assert.ok(startCmds.some(c => c.includes('echo existing')), 'pre-existing hook preserved');
    assert.ok(startCmds.some(c => c.includes('brief --hook')), 'brief hook installed');
    assert.ok(s.hooks.Stop.flatMap(g => g.hooks.map(h => h.command)).some(c => c.includes('consolidate --from-transcript')), 'consolidate hook installed');
    // Re-install adds nothing.
    assert.deepStrictEqual(installSpine({ settingsPath }).added, []);
    assert.strictEqual(spineStatus({ settingsPath }).installed, true);
    // Uninstall removes ours, keeps theirs.
    uninstallSpine({ settingsPath });
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(spineStatus({ settingsPath }).installed, false);
    assert.ok((after.hooks.SessionStart || []).flatMap(g => g.hooks.map(h => h.command)).some(c => c.includes('echo existing')), 'unrelated hook still there after uninstall');
  });

  it('extractTranscriptText pulls user/assistant text from Claude Code JSONL', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the deploy script' } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'done, used systemd' }, { type: 'tool_use', name: 'Bash' }] } }),
      JSON.stringify({ type: 'system', message: { role: 'system', content: 'ignored' } }),
      'not json — skipped',
    ].join('\n');
    const text = extractTranscriptText(jsonl);
    assert.match(text, /fix the deploy script/);
    assert.match(text, /done, used systemd/);
    assert.ok(!/ignored/.test(text), 'system messages excluded');
  });
});
