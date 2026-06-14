// src/memory/store.js — the memory domain (first-principles rebuild; see docs/memory-bridge/07).
// Memory is a first-class entity (`memories` table), not columns bolted onto documents. One taxonomy
// (episodic|semantic|procedural), one salience formula, a human-disposed review queue, and a brief that
// is THE session-start load. Deliberately lean — the speculative machinery is intentionally absent.
import { createHash } from 'crypto';
import { getDb } from '../db.js';
import { generateEmbedding, embeddingToBuffer, bufferToEmbedding, cosineSimilarity } from '../embeddings/embed.js';
import { runClaude } from '../utils/claude.js';

const KINDS = ['episodic', 'semantic', 'procedural'];
const KIND_HALF_LIFE_HOURS = { episodic: 24, semantic: 720, procedural: 4320 }; // "different systems, different rules"
const W_RECENCY = 0.4, W_IMPORTANCE = 0.6;
const CONFIDENCE_WEIGHT = { verified: 1.0, asserted: 0.75, inferred: 0.5, unverified: 0.3 };
const CONFIDENCE_LADDER = ['verified', 'asserted', 'inferred', 'unverified'];

// --- test seams (fast, offline tests) ---
let _testEmbedder = null;
let _autoEmbed = true;
export function _setTestEmbedder(fn) { _testEmbedder = fn; }
export function _setAutoEmbed(on) { _autoEmbed = on; }
function embedFn() { return _testEmbedder || generateEmbedding; }

// --- helpers ---
function clamp01(v) { const n = v == null ? 0.5 : Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; }
function computeHash(content) { return createHash('sha256').update(String(content)).digest('hex').slice(0, 32); }
function sqliteTimeToDate(ts) { if (!ts) return null; const d = new Date(String(ts).replace(' ', 'T') + 'Z'); return isNaN(d.getTime()) ? null : d; }

function retrievability(m) {
  const ref = sqliteTimeToDate(m.last_used_at) || sqliteTimeToDate(m.created_at);
  if (!ref) return 0.5;
  const hours = Math.max(0, (Date.now() - ref.getTime()) / 3600000);
  const halfLife = KIND_HALF_LIFE_HOURS[m.kind] || KIND_HALF_LIFE_HOURS.semantic;
  return Math.exp(-Math.LN2 * hours / halfLife);
}

// The one salience formula. Nothing decaying is stored; decay is evaluated live at recall.
export function salienceOf(m, relevance = 1) {
  const importance = m.importance == null ? 0.5 : m.importance;
  const cw = CONFIDENCE_WEIGHT[m.confidence] ?? 0.3;
  const outcomeMult = Math.min(1.6, Math.max(0.4, 1 + 0.15 * (m.outcome || 0)));
  return relevance * (W_RECENCY * retrievability(m) + W_IMPORTANCE * importance) * cw * outcomeMult;
}

function shape(m) {
  return {
    id: m.id, kind: m.kind, content: m.content, reasoning: m.reasoning,
    created_by: m.created_by, confidence: m.confidence, importance: m.importance,
    project: m.project, outcome: m.outcome, use_count: m.use_count,
    review_status: m.review_status, superseded_by: m.superseded_by,
    created_at: m.created_at, last_used_at: m.last_used_at,
  };
}

function ftsSearch(query, limit) {
  const terms = String(query).toLowerCase().split(/[^a-z0-9]+/i).filter(t => t.length > 1).map(t => t + '*');
  if (!terms.length) return [];
  try {
    return getDb().prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?')
      .all(terms.join(' OR '), limit).map(r => r.rowid);
  } catch { return []; }
}

// --- embeddings ---
export async function embedMemory(id) {
  const db = getDb();
  const m = db.prepare('SELECT id, content, reasoning FROM memories WHERE id = ?').get(id);
  if (!m) return false;
  const emb = await embedFn()([m.content, m.reasoning].filter(Boolean).join('\n').slice(0, 2000));
  db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(embeddingToBuffer(emb), id);
  return true;
}
function embedMemorySafe(id) { return Promise.resolve().then(() => embedMemory(id)).catch(() => false); }
export async function backfillEmbeddings() {
  const rows = getDb().prepare('SELECT id FROM memories WHERE embedding IS NULL').all();
  let n = 0; for (const r of rows) { if (await embedMemorySafe(r.id)) n++; }
  return { embedded: n, total: rows.length };
}

// --- core ops ---
// Write a memory. Provenance is decided by the caller (user|agent); agents propose (pending) and can never
// self-declare 'verified'. Deduped by content hash. Best-effort embedded.
export function remember({ kind, content, reasoning, importance, confidence, created_by, project, source } = {}) {
  if (!content || typeof content !== 'string') throw new Error('remember requires string content');
  const db = getDb();
  const cb = created_by === 'user' ? 'user' : 'agent';
  const k = KINDS.includes(kind) ? kind : 'semantic';
  let conf = confidence && CONFIDENCE_LADDER.includes(confidence) ? confidence : (cb === 'agent' ? 'inferred' : 'asserted');
  if (cb === 'agent' && conf === 'verified') conf = 'asserted';            // correctness gate
  const review_status = cb === 'agent' ? 'pending' : 'accepted';
  const hash = computeHash(content);
  const existing = db.prepare('SELECT * FROM memories WHERE content_hash = ?').get(hash);
  if (existing) return existing;
  const src = source == null ? null : (typeof source === 'string' ? source : JSON.stringify(source));
  const info = db.prepare(`INSERT INTO memories
      (kind, content, reasoning, created_by, confidence, importance, project, source, review_status, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(k, content, reasoning || null, cb, conf, clamp01(importance), project || null, src, review_status, hash);
  if (_autoEmbed) embedMemorySafe(info.lastInsertRowid);
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(info.lastInsertRowid);
}

// Salience-ranked recall (semantic with FTS fallback). Strengthens what it surfaces ("pays rent").
export async function recall(query, { limit = 8, kind, project, includeSuperseded = false } = {}) {
  const db = getDb();
  const hasQuery = !!(query && query.trim());
  let where = `review_status != 'rejected'` + (includeSuperseded ? '' : ' AND superseded_by IS NULL');
  const params = [];
  if (kind) { where += ' AND kind = ?'; params.push(kind); }
  if (project) { where += ' AND project = ?'; params.push(project); }
  const candidates = db.prepare(`SELECT * FROM memories WHERE ${where}`).all(...params);
  if (!candidates.length) return [];

  const relevanceById = new Map();
  let source = 'recency';
  if (hasQuery) {
    source = 'fts';
    const withEmb = candidates.filter(c => c.embedding);
    if (withEmb.length) {
      try {
        const q = await embedFn()(query);
        for (const c of withEmb) relevanceById.set(c.id, Math.max(0, cosineSimilarity(q, bufferToEmbedding(c.embedding))));
        source = 'semantic';
      } catch { relevanceById.clear(); source = 'fts'; }
    }
    if (source !== 'semantic') ftsSearch(query, Math.max(limit * 4, 40)).forEach((id, i) => relevanceById.set(id, 1 / (1 + i)));
  }

  const floor = source === 'semantic' ? 0.15 : 0.1;
  const scored = candidates.map(m => ({
    ...shape(m),
    relevance_source: hasQuery ? source : 'recency',
    salience: Number(salienceOf(m, hasQuery ? (relevanceById.has(m.id) ? relevanceById.get(m.id) : floor) : 1).toFixed(4)),
  }));
  scored.sort((a, b) => b.salience - a.salience);
  const top = scored.slice(0, limit);
  if (top.length) {
    const bump = db.prepare('UPDATE memories SET use_count = use_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?');
    db.transaction(ids => { for (const id of ids) bump.run(id); })(top.map(t => t.id));
  }
  return top;
}

// THE SPINE LOAD: a small, high-signal payload to inject at session start.
export function brief({ core = 7, recent = 5, project } = {}) {
  const db = getDb();
  const proj = project ? ' AND project = ?' : '';
  const p = project ? [project] : [];
  const live = `review_status = 'accepted' AND superseded_by IS NULL`;
  const coreRows = db.prepare(
    `SELECT * FROM memories WHERE ${live}${proj}
     ORDER BY importance DESC, COALESCE(outcome,0) DESC, COALESCE(last_used_at, created_at) DESC LIMIT ?`
  ).all(...p, core);
  const coreIds = new Set(coreRows.map(r => r.id));
  const recentRows = db.prepare(
    `SELECT * FROM memories WHERE ${live}${proj} ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ?`
  ).all(...p, core + recent).filter(r => !coreIds.has(r.id)).slice(0, recent);
  return { core: coreRows.map(shape), recent: recentRows.map(shape), pending: countPending(project) };
}

export function briefMarkdown(opts = {}) {
  const b = brief(opts);
  if (!b.core.length && !b.recent.length && !b.pending) return '';
  const line = (m) => `- [${m.kind}/${m.confidence}] ${m.content}${m.reasoning ? ` — *why:* ${m.reasoning}` : ''}`;
  let out = '## Memory brief (Kaiba)\n';
  if (b.core.length) out += '\n**Core (load-bearing — prohibitions, decisions, preferences):**\n' + b.core.map(line).join('\n') + '\n';
  if (b.recent.length) out += '\n**Recently used:**\n' + b.recent.map(line).join('\n') + '\n';
  if (b.pending) out += `\n*(${b.pending} memories awaiting your review — \`kb_memory_review\` or the dashboard.)*\n`;
  return out;
}

export function getMemory(id) { return getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) || null; }

// The review queue is provenance-agnostic: anything pending awaits the user's disposition — agent
// proposals AND memories imported from an untrusted file (which are forced pending on import).
export function listPending({ limit = 50, project } = {}) {
  const proj = project ? ' AND project = ?' : '';
  const p = project ? [project] : [];
  return getDb().prepare(
    `SELECT id, kind, content, reasoning, created_by, confidence, importance, project, review_status, created_at
     FROM memories WHERE review_status = 'pending' AND superseded_by IS NULL${proj}
     ORDER BY created_at DESC LIMIT ?`
  ).all(...p, limit);
}

function countPending(project) {
  const proj = project ? ' AND project = ?' : '';
  const p = project ? [project] : [];
  return getDb().prepare(`SELECT COUNT(*) c FROM memories WHERE review_status='pending' AND superseded_by IS NULL${proj}`).get(...p).c;
}

// Human disposes.
export function review(id, decision) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM memories WHERE id = ?').get(id)) return null;
  const status = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : null;
  if (!status) throw new Error("decision must be 'accept' or 'reject'");
  db.prepare('UPDATE memories SET review_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
  return getMemory(id);
}

// Demote-don't-delete: superseded leaves default recall/brief but stays queryable.
export function supersede(oldId, newId, reason) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM memories WHERE id = ?').get(oldId)) return null;
  db.prepare('UPDATE memories SET superseded_by = ?, supersession_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newId || null, reason || null, oldId);
  return getMemory(oldId);
}

// Outcome → trust. A burn lowers confidence one notch (simple; never silent-deletes).
export function recordOutcome(id, outcome) {
  const db = getDb();
  const m = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  if (!m) return null;
  const delta = outcome === 'helped' ? 1 : outcome === 'burned' ? -1 : 0;
  let confidence = m.confidence;
  if (outcome === 'burned') {
    const idx = CONFIDENCE_LADDER.indexOf(confidence);
    if (idx >= 0 && idx < CONFIDENCE_LADDER.length - 1) confidence = CONFIDENCE_LADDER[idx + 1];
  }
  db.prepare('UPDATE memories SET outcome = outcome + ?, confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(delta, confidence, id);
  return db.prepare('SELECT id, outcome, confidence FROM memories WHERE id = ?').get(id);
}

// One-time migration: lift documents-based memories (the old bolted-on model) into the entity table.
export function migrateFromDocuments() {
  const db = getDb();
  let docs;
  try {
    docs = db.prepare(
      `SELECT id, content, reasoning, doc_type, created_by, confidence, importance, outcome_score,
              review_status, project, memory_system, created_at
       FROM documents WHERE created_by IN ('user','agent')`
    ).all();
  } catch { return { migrated: 0, skipped: 0, total: 0, note: 'no documents memory columns' }; }
  let migrated = 0, skipped = 0;
  for (const d of docs) {
    if (!d.content) { skipped++; continue; }
    const hash = computeHash(d.content);
    if (db.prepare('SELECT id FROM memories WHERE content_hash = ?').get(hash)) { skipped++; continue; }
    const kind = KINDS.includes(d.memory_system) ? d.memory_system : 'semantic';
    const rs = d.review_status === 'rejected' ? 'rejected' : d.review_status === 'accepted' ? 'accepted' : 'pending';
    const info = db.prepare(`INSERT INTO memories
        (kind, content, reasoning, created_by, confidence, importance, project, source, outcome, review_status, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(kind, d.content, d.reasoning || null, d.created_by, CONFIDENCE_LADDER.includes(d.confidence) ? d.confidence : 'inferred',
        clamp01(d.importance), d.project || null, JSON.stringify({ document_id: d.id, origin: 'migrated' }),
        Math.round(d.outcome_score || 0), rs, hash, d.created_at || null);
    if (_autoEmbed) embedMemorySafe(info.lastInsertRowid);
    migrated++;
  }
  return { migrated, skipped, total: docs.length };
}

// --- consolidation (the ambient save) ---
const EXTRACT_PROMPT = `You extract durable MEMORIES from a work session for a shared Claude<->User brain. Return ONLY JSON (no fences):
{ "memories": [ { "kind": "semantic|episodic|procedural", "content": "the durable fact/decision/lesson/preference (1-3 sentences)", "reasoning": "WHY it is true and WHEN it applies", "importance": 0.0 } ] }
Rules: keep only knowledge worth remembering ACROSS sessions — decisions + rationale, hard-won lessons, stable preferences, prohibitions ("never do X because Y"), reusable procedures. Skip ephemeral chatter and one-off state. semantic = durable facts/decisions; episodic = a specific notable event; procedural = a how-to/skill. If nothing is worth keeping, return {"memories":[]}.`;

export function parseMemories(raw) {
  const s = String(raw || '');
  try { const p = JSON.parse(s.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim()); if (Array.isArray(p?.memories)) return p.memories; if (Array.isArray(p)) return p; } catch { /* fall through */ }
  const key = s.indexOf('"memories"');
  if (key !== -1) {
    const start = s.lastIndexOf('{', key);
    if (start !== -1) {
      let depth = 0, inStr = false, esc = false;
      for (let j = start; j < s.length; j++) {
        const c = s[j];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { if (--depth === 0) { try { const p = JSON.parse(s.slice(start, j + 1)); if (Array.isArray(p.memories)) return p.memories; } catch { /* give up */ } break; } }
      }
    }
  }
  return [];
}

// --- portability ---
const EXPORT_FIELDS = ['kind', 'content', 'reasoning', 'created_by', 'confidence', 'importance', 'project', 'source', 'outcome', 'review_status', 'created_at'];

export function exportMemories({ project, includeSuperseded = false } = {}) {
  const where = '1=1' + (includeSuperseded ? '' : ' AND superseded_by IS NULL') + (project ? ' AND project = ?' : '');
  const rows = getDb().prepare(`SELECT * FROM memories WHERE ${where} ORDER BY created_at ASC`).all(...(project ? [project] : []));
  return rows.map(r => { const o = {}; for (const f of EXPORT_FIELDS) o[f] = r[f]; return o; });
}
export function exportNDJSON(opts) { return exportMemories(opts).map(m => JSON.stringify(m)).join('\n'); }

// Import NDJSON. Untrusted file: preserve provenance/outcome/age, but re-enter the review queue and cap
// confidence at 'inferred' so a shared file can't inject auto-accepted, user-authoritative memories.
export function importNDJSON(ndjson) {
  const db = getDb();
  let imported = 0, skipped = 0;
  for (const line of String(ndjson || '').split('\n').map(l => l.trim()).filter(Boolean)) {
    try {
      let m; try { m = JSON.parse(line); } catch { skipped++; continue; }
      if (!m || typeof m.content !== 'string') { skipped++; continue; }
      const hash = computeHash(m.content);
      if (db.prepare('SELECT id FROM memories WHERE content_hash = ?').get(hash)) { skipped++; continue; }
      const ci = CONFIDENCE_LADDER.indexOf(m.confidence);
      const conf = ci >= 0 ? CONFIDENCE_LADDER[Math.max(ci, 2)] : 'inferred';
      const info = db.prepare(`INSERT INTO memories (kind, content, reasoning, created_by, confidence, importance, project, source, outcome, review_status, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(KINDS.includes(m.kind) ? m.kind : 'semantic', m.content, m.reasoning || null,
          m.created_by === 'user' ? 'user' : 'agent', conf, clamp01(m.importance), m.project || null,
          m.source ? (typeof m.source === 'string' ? m.source : JSON.stringify(m.source)) : null,
          Math.round(Number(m.outcome) || 0), 'pending', hash, m.created_at || null);
      if (_autoEmbed) embedMemorySafe(info.lastInsertRowid);
      imported++;
    } catch { skipped++; }
  }
  return { imported, skipped };
}

// `claude -p --output-format json` returns either a single {type:'result',result:'...'} object OR a
// JSON array of stream events whose final 'result' event carries the answer text. Tolerate both shapes
// (and raw, unparseable text) — verified against the live CLI, which returns the array form.
export function extractResultText(stdout) {
  const s = String(stdout || '');
  let parsed; try { parsed = JSON.parse(s); } catch { return s; }
  if (Array.isArray(parsed)) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      const e = parsed[i];
      if (e && typeof e === 'object' && typeof e.result === 'string') return e.result;
    }
    return '';
  }
  if (parsed && typeof parsed === 'object') return typeof parsed.result === 'string' ? parsed.result : '';
  return typeof parsed === 'string' ? parsed : s;
}

export async function consolidate(text, { extractFn, model, dryRun = false, project } = {}) {
  const run = extractFn || (async (prompt) => extractResultText(await runClaude(prompt, { model })));
  const raw = await run(`${EXTRACT_PROMPT}\n\nSESSION:\n${String(text || '').slice(0, 12000)}`);
  const cands = parseMemories(raw);
  const result = { extracted: cands.length, written: 0, skipped: 0, items: [] };
  for (const c of cands) {
    if (!c || typeof c.content !== 'string') { result.skipped++; continue; }
    if (dryRun) { result.items.push({ content: c.content.slice(0, 80), kind: c.kind, action: 'would-write' }); continue; }
    try {
      const m = remember({ kind: c.kind, content: c.content, reasoning: c.reasoning, importance: c.importance, created_by: 'agent', project, source: { origin: 'consolidation' } });
      result.written++;
      result.items.push({ id: m.id, kind: m.kind, action: 'written' });
    } catch { result.skipped++; }
  }
  return result;
}
