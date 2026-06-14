import Database from 'better-sqlite3';
import { statSync } from 'fs';
import { createHash } from 'crypto';
import { DB_PATH } from './paths.js';
import { generateEmbedding, embeddingToBuffer, bufferToEmbedding, cosineSimilarity } from './embeddings/embed.js';

let db = null;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 100');  // Checkpoint every 100 pages (~400KB) to prevent WAL bloat
    initSchema(db);

    // Periodic WAL checkpoint every 5 minutes to keep WAL file small
    setInterval(() => {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (e) {
        console.error('[KB] WAL checkpoint failed:', e.message);
      }
    }, 5 * 60 * 1000).unref();
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT,
      source TEXT,
      doc_type TEXT NOT NULL,
      tags TEXT DEFAULT '',
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title, content, tags,
      content='documents',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
      VALUES('delete', old.id, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
      VALUES('delete', old.id, old.title, old.content, old.tags);
      INSERT INTO documents_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    -- Vault file tracking for incremental indexing
    CREATE TABLE IF NOT EXISTS vault_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_path TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      title TEXT,
      note_type TEXT,
      tags TEXT DEFAULT '',
      project TEXT,
      status TEXT DEFAULT 'active',
      source TEXT,
      confidence TEXT,
      summary TEXT,
      key_topics TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vault_files_hash ON vault_files(content_hash);
    CREATE INDEX IF NOT EXISTS idx_vault_files_type ON vault_files(note_type);
    CREATE INDEX IF NOT EXISTS idx_vault_files_project ON vault_files(project);
  `);

  // Migration: add content_hash column to documents if missing
  const docCols = db.prepare("PRAGMA table_info(documents)").all().map(c => c.name);
  if (!docCols.includes('content_hash')) {
    db.prepare('ALTER TABLE documents ADD COLUMN content_hash TEXT').run();
  }
  if (!docCols.includes('summary')) {
    db.prepare('ALTER TABLE documents ADD COLUMN summary TEXT').run();
  }
  // Create unique index after migration (column is guaranteed to exist)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_hash
    ON documents(content_hash) WHERE content_hash IS NOT NULL;`);

  // Migration: add summary and key_topics columns if missing
  const cols = db.prepare("PRAGMA table_info(vault_files)").all().map(c => c.name);
  if (!cols.includes('summary')) {
    db.prepare('ALTER TABLE vault_files ADD COLUMN summary TEXT').run();
  }
  if (!cols.includes('key_topics')) {
    db.prepare('ALTER TABLE vault_files ADD COLUMN key_topics TEXT').run();
  }

  // Migration: two-way memory bridge — provenance, trust, and retention columns on documents.
  // All defaults are CONSTANT (SQLite forbids non-constant defaults like CURRENT_TIMESTAMP on
  // ALTER TABLE ADD COLUMN); DATETIME columns are therefore nullable with no default.
  // Design: docs/memory-bridge/03-shared-design.md §4, §7.
  const memCols = db.prepare("PRAGMA table_info(documents)").all().map(c => c.name);
  const addDocCol = (name, decl) => {
    if (!memCols.includes(name)) db.prepare(`ALTER TABLE documents ADD COLUMN ${name} ${decl}`).run();
  };
  addDocCol('created_by', "TEXT DEFAULT 'system'");      // 'user' | 'agent' | 'system' (provenance)
  addDocCol('author_detail', 'TEXT');                     // model id / 'subagent' / etc.
  addDocCol('confidence', "TEXT DEFAULT 'unverified'");   // verified|asserted|inferred|unverified
  addDocCol('reasoning', 'TEXT');                         // the *why* behind the fact (transferable payload)
  addDocCol('verified_at', 'DATETIME');                   // last confirmed against ground truth (staleness)
  addDocCol('importance', 'REAL DEFAULT 0.5');            // [0,1] salience weight; high = stays salient unread
  addDocCol('access_count', 'INTEGER DEFAULT 0');         // strengthen-on-recall counter ("pays rent")
  addDocCol('last_accessed_at', 'DATETIME');              // recency anchor for live Ebbinghaus decay
  addDocCol('outcome_score', 'REAL DEFAULT 0');           // net helped(+)/burned(-) signal
  addDocCol('superseded_by', 'INTEGER');                  // demote-don't-delete supersession link
  addDocCol('supersession_reason', 'TEXT');               // why superseded (kept visible)
  addDocCol('deps_hash', 'TEXT');                         // SHA-256 of declared inputs (tracked-dep staleness)
  addDocCol('review_status', "TEXT DEFAULT 'none'");      // none|pending|accepted|rejected|flagged
  addDocCol('project', 'TEXT');                           // project scope for recall filtering
  addDocCol('next_review_at', 'DATETIME');                // spaced re-surfacing schedule (NULL = due now)
  addDocCol('memory_system', 'TEXT');                     // working|episodic|semantic|procedural; NULL reads as semantic
  addDocCol('storage_strength', 'REAL DEFAULT 1');        // durable trace; stretches half-life + grows on recall (FSRS)
  addDocCol('predicted_outcome', 'REAL DEFAULT 0');       // running expected helpfulness [-1,1] (reward-prediction-error baseline)
  addDocCol('consolidated_into', 'INTEGER');              // episodic -> semantic (CLS): demoted after generalisation
  addDocCol('derived_from', 'TEXT');                      // semantic: JSON array of source episodic ids
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_created_by ON documents(created_by);
    CREATE INDEX IF NOT EXISTS idx_documents_review ON documents(review_status);
    CREATE INDEX IF NOT EXISTS idx_documents_memory_system ON documents(memory_system);`);
  // No backfill UPDATE: legacy rows keep memory_system = NULL, which weightsFor() reads as 'semantic'
  // (the historical behaviour) — avoids firing the FTS AFTER UPDATE trigger on rows that predate FTS.

  db.exec(`

    -- Embeddings for semantic search (stored as Float32Array binary blobs)
    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      vault_path TEXT,
      chunk_index INTEGER DEFAULT 0,
      chunk_text TEXT,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_embeddings_doc ON embeddings(document_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_vault ON embeddings(vault_path);

    -- Transparent agent workspace (Global-Workspace-style blackboard): each specialised step in a
    -- recall/consolidation cycle writes an auditable {agent, doc_id, score, vote, reasoning} row the
    -- human can read and override. Brain-inspired (Hearsay-II / Society of Mind), not brain-proven.
    CREATE TABLE IF NOT EXISTS workspace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      doc_id INTEGER,
      score REAL,
      vote TEXT,
      reasoning TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_cycle ON workspace(cycle_id);
  `);
}

export { initSchema, getDb };

// Test helpers — inject/reset the DB singleton for isolated unit tests
export function _setTestDb(testDb) { db = testDb; }
export function _resetDb() { db = null; }

// Clamp a value into [0,1], defaulting null/NaN to 0.5 (used for importance on every write path).
function clamp01(v) { const n = v == null ? 0.5 : Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; }

export function insertDocument({ title, content, source, doc_type, tags, file_path, file_size,
  created_by, author_detail, confidence, reasoning, importance, deps_hash, review_status, project, verified_at,
  memory_system, storage_strength }) {
  // Defensive coercion — callers may pass untrusted (LLM / NDJSON) values.
  title = typeof title === 'string' ? title : String(title ?? '');
  content = typeof content === 'string' ? content : String(content ?? '');
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 32);
  const db = getDb();
  // Coalesce here (not via column DEFAULT): once a column is named in INSERT, its DEFAULT
  // no longer applies, so existing callers that omit these fields must still get sane values.
  const meta = {
    created_by: created_by || 'system',
    author_detail: author_detail || null,
    confidence: confidence || 'unverified',
    reasoning: reasoning || null,
    importance: clamp01(importance),
    deps_hash: deps_hash || null,
    review_status: review_status || 'none',
    project: project || null,
    verified_at: verified_at || null,
    memory_system: memory_system || null,
    storage_strength: storage_strength == null ? 1 : storage_strength,
  };
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO documents
      (title, content, content_hash, source, doc_type, tags, file_path, file_size,
       created_by, author_detail, confidence, reasoning, importance, deps_hash, review_status, project, verified_at,
       memory_system, storage_strength)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(title, content, hash, source || null, doc_type, tags || '', file_path || null, file_size || 0,
    meta.created_by, meta.author_detail, meta.confidence, meta.reasoning, meta.importance,
    meta.deps_hash, meta.review_status, meta.project, meta.verified_at,
    meta.memory_system, meta.storage_strength);

  if (result.changes === 0) {
    // Duplicate content — return existing document
    return db.prepare('SELECT * FROM documents WHERE content_hash = ?').get(hash);
  }

  return {
    id: result.lastInsertRowid,
    title,
    content,
    content_hash: hash,
    source: source || null,
    doc_type,
    tags: tags || '',
    file_path: file_path || null,
    file_size: file_size || 0,
    ...meta,
  };
}

export function updateDocument(id, { title, tags }) {
  const stmt = getDb().prepare(`
    UPDATE documents SET title = ?, tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  return stmt.run(title, tags, id);
}

export function deleteDocument(id) {
  const doc = getDb().prepare('SELECT file_path FROM documents WHERE id = ?').get(id);
  getDb().prepare('DELETE FROM documents WHERE id = ?').run(id);
  return doc ? doc.file_path : null;
}

// Common English stop words to filter from search queries
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too',
  'very', 'just', 'because', 'if', 'when', 'where', 'how', 'what',
  'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'me',
  'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'they', 'them', 'their', 'about', 'up',
]);

export function searchDocuments(query, limit = 20) {
  // Strip punctuation, split into terms, remove stop words
  const terms = query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => t.toLowerCase())
    .filter(t => !STOP_WORDS.has(t) && t.length > 1);

  if (terms.length === 0) {
    // All terms were stop words — fall back to original terms
    const fallback = query.replace(/['"]/g, '').split(/\s+/).filter(Boolean);
    if (fallback.length === 0) return [];
    const sanitized = fallback.map(term => `"${term}"`).join(' OR ');
    const stmt = getDb().prepare(`
      SELECT d.id, d.title,
        snippet(documents_fts, 1, '<mark>', '</mark>', '...', 30) as snippet,
        d.doc_type, d.tags, d.file_size, d.created_at,
        bm25(documents_fts, 10.0, 1.0, 5.0) as rank
      FROM documents_fts f
      JOIN documents d ON d.id = f.rowid
      WHERE documents_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(sanitized, limit);
  }

  // Build FTS5 query: AND-first for precision, OR fallback for recall
  // Title-boosted ranking via bm25() weights: title=10x, content=1x, tags=5x
  const andQuery = terms.map(term => `"${term}" *`).join(' AND ');
  const orQuery = terms.map(term => `"${term}" *`).join(' OR ');

  const stmt = getDb().prepare(`
    SELECT d.id, d.title,
      snippet(documents_fts, 1, '<mark>', '</mark>', '...', 30) as snippet,
      d.doc_type, d.tags, d.file_size, d.created_at, d.updated_at,
      d.created_by, d.confidence,
      bm25(documents_fts, 10.0, 1.0, 5.0) as rank
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    WHERE documents_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  // Try AND first for precision; fall back to OR if no results
  let results = stmt.all(andQuery, limit);
  if (results.length === 0 && terms.length > 1) {
    results = stmt.all(orQuery, limit);
  }

  // If OR gives too many low-quality results, re-rank: boost docs matching more terms
  if (terms.length > 1 && results.length > 0) {
    for (const r of results) {
      const titleLower = (r.title || '').toLowerCase();
      const tagsLower = (r.tags || '').toLowerCase();
      let termBoost = 0;
      for (const term of terms) {
        if (titleLower.includes(term)) termBoost += 20;  // title match is very strong
        if (tagsLower.includes(term)) termBoost += 10;   // tag match is strong
      }
      // rank is negative (lower = better in bm25), so subtract boost to improve ranking
      r.rank = r.rank - termBoost;
    }
    results.sort((a, b) => a.rank - b.rank);
  }

  return results;
}

export function updateDocumentSummary(id, summary) {
  return getDb().prepare(
    'UPDATE documents SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(summary, id);
}

export function listDocuments({ type, tag, source, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT id, title, doc_type, tags, file_size, source, summary, created_by, confidence, created_at, updated_at FROM documents';
  const conditions = [];
  const params = [];

  if (type) {
    conditions.push('doc_type = ?');
    params.push(type);
  }
  if (tag) {
    conditions.push("tags LIKE '%' || ? || '%'");
    params.push(tag);
  }
  if (source) {
    conditions.push('source LIKE ?');
    params.push(source);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return getDb().prepare(sql).all(...params);
}

export function getDocument(id) {
  return getDb().prepare('SELECT * FROM documents WHERE id = ?').get(id) || null;
}

export function getStats() {
  const count = getDb().prepare('SELECT COUNT(*) as count FROM documents').get().count;
  const totalSize = getDb().prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM documents').get().total;
  let dbFileSize = 0;
  try {
    dbFileSize = statSync(DB_PATH).size;
  } catch {
    // DB file may not exist yet
  }
  return { count, totalSize, dbFileSize };
}

export function getDocumentCount() {
  return getDb().prepare('SELECT COUNT(*) as count FROM documents').get().count;
}

export function updateDocumentFull(id, { title, content, tags, doc_type, source, file_path, file_size }) {
  const stmt = getDb().prepare(`
    UPDATE documents SET title = ?, content = ?, tags = ?, doc_type = ?, source = ?, file_path = ?, file_size = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  return stmt.run(title, content, tags, doc_type, source, file_path, file_size, id);
}

export function getVaultFile(vaultPath) {
  return getDb().prepare('SELECT * FROM vault_files WHERE vault_path = ?').get(vaultPath);
}

export function upsertVaultFile({ vault_path, content_hash, document_id, title, note_type, tags, project, status, source, confidence, summary, key_topics }) {
  const stmt = getDb().prepare(`
    INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type, tags, project, status, source, confidence, summary, key_topics, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(vault_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      document_id = excluded.document_id,
      title = excluded.title,
      note_type = excluded.note_type,
      tags = excluded.tags,
      project = excluded.project,
      status = excluded.status,
      source = excluded.source,
      confidence = excluded.confidence,
      summary = excluded.summary,
      key_topics = excluded.key_topics,
      indexed_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(vault_path, content_hash, document_id, title, note_type, tags || '', project, status, source, confidence, summary || null, key_topics ? JSON.stringify(key_topics) : null);
}

export function deleteVaultFile(vaultPath) {
  const vf = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(vaultPath);
  if (vf && vf.document_id) {
    getDb().prepare('DELETE FROM documents WHERE id = ?').run(vf.document_id);
  }
  getDb().prepare('DELETE FROM vault_files WHERE vault_path = ?').run(vaultPath);
}

export function getAllVaultPaths() {
  return getDb().prepare('SELECT vault_path, content_hash FROM vault_files').all();
}

// ===========================================================================
// Two-way memory bridge (Claude <-> User shared memory).
// Design:    docs/memory-bridge/03-shared-design.md §7
// Grounded:  docs/memory-bridge/01-theory-validation.md
//            (Generative Agents salience; MemoryBank strengthen-on-recall;
//             STALE/CUPMem supersession; Bayesian outcome confidence)
// Renamed honestly from the coined "constraint-store versioning" (which collides
// with the monotonic CCP "constraint store") -> salience-and-supersession retention.
// ===========================================================================

// Tunable salience weights. Recency is an Ebbinghaus-style half-life decay computed
// LIVE at recall — no decaying value is ever persisted (time decays, recall arrests it).
// Per-memory-system salience weights (brain memory systems; replaces the old single global constant).
// The SEMANTIC profile equals the historical defaults (0.4/0.6, 72h), so recall over existing memories
// is unchanged. Brain-inspired, not brain-proven — see docs/memory-bridge/05-brain-research.md.
const SYSTEM_WEIGHTS = {
  semantic:   { wRecency: 0.4, wImportance: 0.6, halfLifeHours: 72 },   // neocortex: stable facts/decisions
  episodic:   { wRecency: 0.8, wImportance: 0.2, halfLifeHours: 24 },   // hippocampus: time-bound, fast-decay
  procedural: { wRecency: 0.1, wImportance: 0.4, halfLifeHours: 720 },  // striatum: skills, barely decay (outcome-led)
  working:    { wRecency: 1.0, wImportance: 0.0, halfLifeHours: 1 },    // PFC scratch: ephemeral
};
const DEFAULT_WEIGHTS = SYSTEM_WEIGHTS.semantic;
const STRENGTH_GAIN = 0.5; // FSRS-style: a recall when nearly-forgotten strengthens the trace the most
const CONFIDENCE_WEIGHT = { verified: 1.0, asserted: 0.75, inferred: 0.5, unverified: 0.3 };
const CONFIDENCE_LADDER = ['verified', 'asserted', 'inferred', 'unverified'];

function sqliteTimeToDate(ts) {
  if (!ts) return null;
  // SQLite CURRENT_TIMESTAMP is UTC 'YYYY-MM-DD HH:MM:SS'
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

function weightsFor(m) { return (m && SYSTEM_WEIGHTS[m.memory_system]) || DEFAULT_WEIGHTS; }

// Retrievability now: Ebbinghaus decay whose half-life is STRETCHED by storage_strength (two-strength
// model: storage strength is durable; retrievability is what's accessible right now).
function retrievability(m) {
  const w = weightsFor(m);
  const ref = sqliteTimeToDate(m.last_accessed_at) || sqliteTimeToDate(m.created_at);
  if (!ref) return 0.5;
  const hours = Math.max(0, (Date.now() - ref.getTime()) / 3600000);
  const halfLife = w.halfLifeHours * Math.max(1, m.storage_strength || 1);
  return Math.exp(-Math.LN2 * hours / halfLife);
}

function outcomeMultiplier(score) {
  return Math.min(1.6, Math.max(0.4, 1 + 0.15 * (score || 0)));
}

// Salience = relevance × (a·retrievability + b·importance) × confidenceWeight × outcomeMultiplier,
// with per-system a/b/half-life. Semantic + storage_strength=1 reproduces the historical formula exactly.
export function salienceOf(m, relevance = 1) {
  const w = weightsFor(m);
  const importance = m.importance == null ? 0.5 : m.importance;
  const cw = CONFIDENCE_WEIGHT[m.confidence] ?? 0.3;
  const base = w.wRecency * retrievability(m) + w.wImportance * importance;
  return relevance * base * cw * outcomeMultiplier(m.outcome_score);
}

// The strengthened storage trace after a recall: grows with diminishing returns, MOST when
// retrievability was low (recalling something you'd nearly forgotten cements it — the spacing effect).
export function strengthenedStorage(m) {
  return Number(((m.storage_strength || 1) + STRENGTH_GAIN * (1 - retrievability(m))).toFixed(4));
}

// --- Bounded non-determinism for recall (default OFF: T=0 reproduces exact deterministic top-k) ---
const ENV_RECALL_TEMP = (() => { const t = parseFloat(process.env.KB_RECALL_TEMPERATURE || '0'); return Number.isFinite(t) ? t : 0; })();

// Deterministic seeded RNG (mulberry32) so any stochastic recall is exactly replayable for audit.
function makeRng(seed) {
  let s = (seed == null ? (Date.now() & 0xffffffff) : Math.floor(seed)) >>> 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Temperature-sampled top-k via Gumbel-top-k (sampling without replacement from softmax over salience).
// temperature<=0 OR fewer candidates than the limit => exact deterministic top-k (today's behaviour).
function selectByTemperature(scored, limit, temperature, seed) {
  if (!(temperature > 0) || scored.length <= limit) return scored.slice(0, limit);
  const rng = makeRng(seed);
  return scored
    .map(s => {
      const u = Math.min(1 - 1e-12, Math.max(1e-12, rng()));
      const gumbel = -Math.log(-Math.log(u));
      return { s, key: Math.log(Math.max(s.salience, 1e-9)) / temperature + gumbel };
    })
    .sort((a, b) => b.key - a.key)
    .slice(0, limit)
    .map(k => k.s);
}

const ENV_RECALL_DIVERSITY = (() => { const d = parseFloat(process.env.KB_RECALL_DIVERSITY || '0'); return Number.isFinite(d) ? d : 0; })();

// Maximal Marginal Relevance: greedily pick a COMPLEMENTARY set (high salience, low mutual similarity)
// instead of N near-duplicate paraphrases. lambda in (0,1]: higher favours salience, lower favours diversity.
// Standard IR (Carbonell & Goldstein 1998); needs per-candidate embeddings.
function selectByMMR(scored, embById, limit, lambda) {
  const pool = scored.slice(0, Math.max(limit * 4, limit));
  const selected = [];
  const remaining = pool.slice();
  while (selected.length < limit && remaining.length) {
    let bi = 0, best = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const ce = embById.get(remaining[i].id);
      let maxSim = 0;
      if (ce) for (const s of selected) { const se = embById.get(s.id); if (se) { const sim = cosineSimilarity(ce, se); if (sim > maxSim) maxSim = sim; } }
      const score = lambda * remaining[i].salience - (1 - lambda) * maxSim;
      if (score > best) { best = score; bi = i; }
    }
    selected.push(remaining.splice(bi, 1)[0]);
  }
  return selected;
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

// Deterministic SHA-256 over an entry's declared inputs (source/model/prompt version,
// cited upstream doc ids). Used only as a cheap tracked-dependency staleness signal —
// it is structurally blind to untracked external evidence (see 01 reasoning-hash verdict).
export function computeDepsHash(deps) {
  if (deps == null) return null;
  return createHash('sha256').update(JSON.stringify(sortDeep(deps))).digest('hex').slice(0, 32);
}

// --- Semantic embeddings for memories (so recall finds what the brain holds, by meaning) ---
let _testEmbedder = null;       // test seam: inject a deterministic embedder
let _autoEmbedEnabled = true;   // test seam: disable best-effort embed-on-write
export function _setTestEmbedder(fn) { _testEmbedder = fn; }
export function _setAutoEmbed(on) { _autoEmbedEnabled = on; }
function embedFn() { return _testEmbedder || generateEmbedding; }

function memoryEmbedText(row) {
  return [row.title, row.reasoning, row.content].filter(Boolean).join('\n').slice(0, 2000);
}

// Embed (or re-embed) one memory into the embeddings table. Idempotent per document_id.
export async function embedMemory(id) {
  const db = getDb();
  const row = db.prepare('SELECT id, title, content, reasoning FROM documents WHERE id = ?').get(id);
  if (!row) return false;
  const emb = await embedFn()(memoryEmbedText(row));
  const buf = embeddingToBuffer(emb);
  db.transaction(() => {
    db.prepare('DELETE FROM embeddings WHERE document_id = ?').run(id);
    db.prepare('INSERT INTO embeddings (document_id, chunk_index, chunk_text, embedding, dimensions) VALUES (?, 0, ?, ?, ?)')
      .run(id, (row.content || '').slice(0, 500), buf, emb.length);
  })();
  return true;
}

// Best-effort, non-blocking: a failed/slow embed must never break the write or recall.
function embedMemorySafe(id) { return Promise.resolve().then(() => embedMemory(id)).catch(() => false); }

// Backfill embeddings for any bridge memories that lack them (e.g. created before this feature).
export async function backfillMemoryEmbeddings() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id FROM documents WHERE created_by IN ('user','agent')
       AND id NOT IN (SELECT document_id FROM embeddings WHERE document_id IS NOT NULL)`
  ).all();
  let embedded = 0;
  for (const r of rows) { if (await embedMemorySafe(r.id)) embedded++; }
  return { embedded, total: rows.length };
}

// Find the single most semantically-similar live memory to `text`, or null if none clears `min`
// cosine. Used by consolidation to avoid writing near-duplicate memories.
export async function findSimilarMemory(text, { min = 0.9, includeSuperseded = false } = {}) {
  const db = getDb();
  const where = `d.created_by IN ('user','agent') AND d.review_status != 'rejected'`
    + (includeSuperseded ? '' : ' AND d.superseded_by IS NULL');
  const rows = db.prepare(
    `SELECT d.id, d.title, e.embedding FROM documents d JOIN embeddings e ON e.document_id = d.id WHERE ${where}`
  ).all();
  if (!rows.length) return null;
  let best = null;
  try {
    const q = await embedFn()(text);
    for (const r of rows) {
      const sim = cosineSimilarity(q, bufferToEmbedding(r.embedding));
      if (!best || sim > best.similarity) best = { id: r.id, title: r.title, similarity: sim };
    }
  } catch { return null; }
  return best && best.similarity >= min ? best : null;
}

// Surface a memory's closest semantic neighbor within a "consistency band" — close enough to be about
// the same thing, but NOT a near-duplicate. This routes a possible conflict to HUMAN judgment; it does
// NOT decide contradiction (embeddings can't reliably separate agreement from contradiction; the best
// research detectors are ~55% accurate). Read-only.
export async function findConflict(id, { min = 0.80, max = 0.985, includeSuperseded = false } = {}) {
  const db = getDb();
  const self = db.prepare('SELECT embedding FROM embeddings WHERE document_id = ?').get(id);
  if (!self) return null;
  const selfEmb = bufferToEmbedding(self.embedding);
  const where = `d.id != ? AND d.created_by IN ('user','agent') AND d.review_status != 'rejected'`
    + (includeSuperseded ? '' : ' AND d.superseded_by IS NULL');
  const rows = db.prepare(
    `SELECT d.id, d.title, e.embedding FROM documents d JOIN embeddings e ON e.document_id = d.id WHERE ${where}`
  ).all(id);
  let best = null;
  try {
    for (const r of rows) {
      const sim = cosineSimilarity(selfEmb, bufferToEmbedding(r.embedding));
      if (sim >= min && sim <= max && (!best || sim > best.similarity)) best = { id: r.id, title: r.title, similarity: Number(sim.toFixed(3)) };
    }
  } catch { return null; }
  return best;
}

// Write a bridge memory. Agent writes enter the human-audit queue (review_status='pending')
// and at 'inferred' confidence (correctness gate); user writes are authoritative on intent.
export function rememberMemory({ title, content, reasoning, doc_type, tags, importance,
  confidence, created_by, author_detail, project, deps, memory_system } = {}) {
  if (!title || !content) throw new Error('rememberMemory requires title and content');
  const cb = created_by || 'agent';
  const review_status = cb === 'agent' ? 'pending' : 'accepted';
  let conf = confidence || (cb === 'agent' ? 'inferred' : 'asserted');
  // Guardrail (correctness gate): an agent cannot self-declare 'verified' — only the user / review path
  // can promote to verified. Cap agent writes at 'asserted'.
  if (cb === 'agent' && CONFIDENCE_LADDER.indexOf(conf) === 0) conf = 'asserted';
  const dt = doc_type || 'memory';
  // Default the brain memory-system from the type (overridable): sessions are episodic, skills/fixes
  // procedural, everything else a stable semantic fact/decision.
  const sys = memory_system || (dt === 'session' ? 'episodic' : (['fix', 'workflow'].includes(dt) ? 'procedural' : 'semantic'));
  const doc = insertDocument({
    title,
    content,
    source: `memory:${cb}`,
    doc_type: dt,
    tags: Array.isArray(tags) ? tags.join(', ') : (tags || ''),
    file_size: Buffer.byteLength(content || ''),
    created_by: cb,
    author_detail: author_detail || null,
    confidence: conf,
    reasoning: reasoning || null,
    importance: importance == null ? 0.5 : importance,
    deps_hash: computeDepsHash(deps),
    review_status,
    project: project || null,
    memory_system: sys,
  });
  // Best-effort semantic indexing — fire-and-forget so it never blocks or fails the write.
  if (_autoEmbedEnabled && doc && doc.id != null) embedMemorySafe(doc.id);
  return doc;
}

// Salience-ranked recall over bridge memories, returning trust signals. Excludes superseded
// (unless includeSuperseded) and rejected memories. Strengthens recalled memories ("pays rent").
export async function recallMemories(query, { limit = 10, project, type, includeSuperseded = false, deps, temperature, seed, diversity, traceCycleId } = {}) {
  const db = getDb();
  const hasQuery = !!(query && query.trim());

  // Candidate set: all live bridge memories (filtered by project/type, excluding rejected and,
  // by default, superseded). Brute-force scoring is fine at < ~2000 memories.
  const baseWhere = `created_by IN ('user','agent') AND review_status != 'rejected'`
    + (includeSuperseded ? '' : ' AND superseded_by IS NULL AND consolidated_into IS NULL');
  let candSql = `SELECT * FROM documents WHERE ${baseWhere}`;
  const candParams = [];
  if (project) { candSql += ' AND project = ?'; candParams.push(project); }
  if (type) { candSql += ' AND doc_type = ?'; candParams.push(type); }
  const candidates = db.prepare(candSql).all(...candParams);
  if (!candidates.length) return [];

  // Relevance: semantic (cosine over stored embeddings) when available; otherwise FTS rank-position.
  const relevanceById = new Map();
  let source = 'recency';
  if (hasQuery) {
    source = 'fts';
    const ids = candidates.map(c => c.id);
    const embRows = db.prepare(
      `SELECT document_id, embedding FROM embeddings WHERE document_id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids);
    if (embRows.length) {
      try {
        const qemb = await embedFn()(query);
        for (const er of embRows) {
          relevanceById.set(er.document_id, Math.max(0, cosineSimilarity(qemb, bufferToEmbedding(er.embedding))));
        }
        source = 'semantic';
      } catch {
        relevanceById.clear();
        source = 'fts';
      }
    }
    if (source !== 'semantic') {
      // FTS fallback: model unavailable, errored, or no embeddings yet.
      searchDocuments(query, Math.max(limit * 4, 40)).forEach((r, i) => relevanceById.set(r.id, 1 / (1 + i)));
    }
  }

  const curHash = computeDepsHash(deps);
  const floor = source === 'semantic' ? 0.15 : 0.1; // memories missing the active signal can still surface on importance/recency
  const scored = candidates.map(m => {
    const relevance = !hasQuery ? 1 : (relevanceById.has(m.id) ? relevanceById.get(m.id) : floor);
    return {
      id: m.id, title: m.title, content: m.content, reasoning: m.reasoning,
      doc_type: m.doc_type, tags: m.tags, project: m.project,
      created_by: m.created_by, confidence: m.confidence, importance: m.importance,
      memory_system: m.memory_system, storage_strength: m.storage_strength,
      outcome_score: m.outcome_score, access_count: m.access_count,
      review_status: m.review_status, superseded_by: m.superseded_by,
      created_at: m.created_at, last_accessed_at: m.last_accessed_at,
      stale: !!(curHash && m.deps_hash && curHash !== m.deps_hash),
      relevance_source: hasQuery ? source : 'recency',
      salience: Number(salienceOf(m, relevance).toFixed(4)),
      _newStrength: strengthenedStorage(m),
    };
  });
  scored.sort((a, b) => b.salience - a.salience);
  const temp = temperature == null ? ENV_RECALL_TEMP : temperature;
  const div = diversity == null ? ENV_RECALL_DIVERSITY : diversity;
  let top;
  if (div > 0) {
    // MMR diversity selection (opt-in): fetch the pool's embeddings and pick a complementary set.
    const pool = scored.slice(0, Math.max(limit * 4, limit));
    const ids = pool.map(s => s.id);
    const embById = new Map();
    if (ids.length) {
      for (const r of db.prepare(`SELECT document_id, embedding FROM embeddings WHERE document_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
        embById.set(r.document_id, bufferToEmbedding(r.embedding));
      }
    }
    top = selectByMMR(scored, embById, limit, div);
  } else {
    top = selectByTemperature(scored, limit, temp, seed);
  }

  // Strengthen-on-recall: bump access_count + last_accessed_at, and grow storage_strength (FSRS:
  // the boost is larger the lower retrievability was — recalling a near-forgotten memory cements it).
  if (top.length) {
    const bump = db.prepare('UPDATE documents SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP, storage_strength = ? WHERE id = ?');
    db.transaction((rows) => { for (const r of rows) bump.run(r._newStrength, r.id); })(top);
  }

  // Transparent workspace trace (opt-in): log each internal "agent"'s contribution for human audit.
  if (traceCycleId) {
    const ws = db.prepare('INSERT INTO workspace (cycle_id, agent, doc_id, score, vote, reasoning) VALUES (?, ?, ?, ?, ?, ?)');
    const topIds = new Set(top.map(t => t.id));
    db.transaction(() => {
      ws.run(traceCycleId, 'librarian', null, candidates.length, 'fetched',
        `fetched ${candidates.length} candidates via ${hasQuery ? source : 'recency'}` + (temp > 0 ? ` (temperature ${temp})` : ''));
      for (const s of scored.slice(0, Math.max(limit + 3, top.length))) {
        ws.run(traceCycleId, 'salience-router', s.id, s.salience, topIds.has(s.id) ? 'broadcast' : 'suppress', `salience ${s.salience} [${s.relevance_source}]`);
      }
    })();
  }
  return top.map(({ _newStrength, ...rest }) => rest);
}

// Read the blackboard for a cycle — what each internal agent proposed/voted, in order.
export function getWorkspace(cycle_id) {
  return getDb().prepare('SELECT agent, doc_id, score, vote, reasoning, created_at FROM workspace WHERE cycle_id = ? ORDER BY id').all(cycle_id);
}

// Transparent recall: returns the results PLUS the workspace blackboard for that cycle (single pane of glass).
export async function recallTraced(query, opts = {}) {
  const cycle_id = 'recall-' + Date.now() + '-' + (getDb().prepare('SELECT COUNT(*) c FROM workspace').get().c);
  const results = await recallMemories(query, { ...opts, traceCycleId: cycle_id });
  return { cycle_id, results, workspace: getWorkspace(cycle_id) };
}

// Record that acting on a memory helped or burned. A burn downgrades confidence one notch
// and flags for review — never silently deletes, never silently trusts (best detectors ~55%).
// Reward-prediction-error update (dopamine RPE — the one fully-established brain pillar here).
// Each memory carries a running expectation `predicted_outcome` in [-1,1]. An outcome's effect scales
// with the SURPRISE (actual - predicted), not a flat ±1 — so reinforcing an already-trusted memory
// barely moves it, while an UNEXPECTED failure moves it a lot. A worse-than-expected outcome downgrades
// confidence by more notches the higher the memory's confidence was (precision-weighted), and flags it.
const PE_LEARN_RATE = 0.3;
export function recordMemoryOutcome(id, outcome) {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!doc) return null;
  const actual = outcome === 'helped' ? 1 : outcome === 'burned' ? -1 : 0;
  const predicted = doc.predicted_outcome == null ? 0 : doc.predicted_outcome;
  const pe = actual - predicted;
  const newPredicted = Math.max(-1, Math.min(1, predicted + PE_LEARN_RATE * pe));
  const newOutcome = (doc.outcome_score || 0) + pe;
  let confidence = doc.confidence;
  let review_status = doc.review_status;
  if (pe < 0) {
    const precision = CONFIDENCE_WEIGHT[confidence] ?? 0.3;          // confidence-as-precision
    const steps = Math.max(1, Math.round(precision * Math.abs(pe) * 2)); // high-precision miss => bigger drop
    const idx = CONFIDENCE_LADDER.indexOf(confidence);
    if (idx >= 0) confidence = CONFIDENCE_LADDER[Math.min(CONFIDENCE_LADDER.length - 1, idx + steps)];
    review_status = 'flagged';
  }
  db.prepare('UPDATE documents SET outcome_score = ?, predicted_outcome = ?, confidence = ?, review_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newOutcome, newPredicted, confidence, review_status, id);
  return db.prepare('SELECT id, outcome_score, predicted_outcome, confidence, review_status FROM documents WHERE id = ?').get(id);
}

// CLS provenance: mark episodic memories as consolidated into a semantic memory (demote-don't-delete:
// they leave default recall but stay queryable), and record the semantic's source episodic ids.
export function markConsolidated(episodicIds, semanticId) {
  const db = getDb();
  const ids = (episodicIds || []).map(Number).filter(n => Number.isFinite(n));
  const tx = db.transaction(() => {
    const demote = db.prepare('UPDATE documents SET consolidated_into = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    for (const eid of ids) demote.run(semanticId, eid);
    db.prepare('UPDATE documents SET derived_from = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(ids), semanticId);
  });
  tx();
  return { semanticId, derived_from: ids };
}

// Demote-don't-delete: mark old memory superseded by new; old leaves default recall but stays queryable.
export function supersedeMemory(oldId, newId, reason) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(oldId)) return null;
  db.prepare('UPDATE documents SET superseded_by = ?, supersession_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newId || null, reason || null, oldId);
  return db.prepare('SELECT id, superseded_by, supersession_reason FROM documents WHERE id = ?').get(oldId);
}

// Human-audit loop (propose/dispose): the review queue. Surfaces agent PROPOSALS (pending) AND
// any FLAGGED memory (burned via recordMemoryOutcome → needs re-evaluation). Flagged first, since
// a memory that led work astray is more urgent than a fresh proposal. (Fixes the prior bug where
// flagged memories silently vanished because the query required review_status='pending'.)
export function listPendingMemories({ limit = 50 } = {}) {
  return getDb().prepare(
    `SELECT id, title, content, reasoning, doc_type, tags, project, created_by, author_detail,
            confidence, importance, outcome_score, review_status, created_at
     FROM documents
     WHERE superseded_by IS NULL
       AND ( (created_by = 'agent' AND review_status = 'pending') OR review_status = 'flagged' )
     ORDER BY (review_status = 'flagged') DESC, created_at DESC
     LIMIT ?`
  ).all(limit);
}

// Human disposes: accept or reject an agent memory. Rejected memories drop out of recall.
export function reviewMemory(id, decision) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(id)) return null;
  const status = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : null;
  if (!status) throw new Error("decision must be 'accept' or 'reject'");
  db.prepare('UPDATE documents SET review_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
  return db.prepare('SELECT id, review_status FROM documents WHERE id = ?').get(id);
}

// Spaced re-surfacing: a surfaced memory is pushed out by (1 + access_count) days, capped at 30 —
// the more a memory has been used, the less often it needs re-surfacing (retrieval practice + spacing).
function nextReviewInterval(accessCount) { return Math.min(30, 1 + (accessCount || 0)); }

// Session-start briefing: a small always-load CORE (highest-importance accepted memories) plus DUE
// memories scheduled for spaced re-surfacing. Surfacing strengthens them ("pays rent") and pushes
// their next_review_at forward (spacing). The validated high-utility durability lever.
export function getSessionBrief({ core = 5, due = 7, project } = {}) {
  const db = getDb();
  const live = `created_by IN ('user','agent') AND superseded_by IS NULL AND consolidated_into IS NULL AND review_status != 'rejected'`;
  const projClause = project ? ' AND project = ?' : '';

  const coreRows = db.prepare(
    `SELECT * FROM documents WHERE ${live} AND review_status = 'accepted'${projClause}
     ORDER BY importance DESC, COALESCE(outcome_score, 0) DESC, last_accessed_at DESC LIMIT ?`
  ).all(...(project ? [project, core] : [core]));

  const dueRows = db.prepare(
    `SELECT * FROM documents WHERE ${live}${projClause}
       AND (next_review_at IS NULL OR next_review_at <= CURRENT_TIMESTAMP)
     ORDER BY importance DESC, COALESCE(last_accessed_at, created_at) ASC LIMIT ?`
  ).all(...(project ? [project, due] : [due]));

  // Strengthen + schedule forward every surfaced memory (a brief IS a recall).
  const surfaced = [...new Map([...coreRows, ...dueRows].map(r => [r.id, r])).values()];
  if (surfaced.length) {
    const upd = db.prepare(
      `UPDATE documents SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP,
        next_review_at = datetime(CURRENT_TIMESTAMP, ?) WHERE id = ?`
    );
    db.transaction((rows) => { for (const r of rows) upd.run('+' + nextReviewInterval(r.access_count) + ' days', r.id); })(surfaced);
  }

  const shape = (m) => ({
    id: m.id, title: m.title, content: m.content, reasoning: m.reasoning,
    doc_type: m.doc_type, project: m.project, created_by: m.created_by,
    confidence: m.confidence, importance: m.importance, review_status: m.review_status,
  });
  return { core: coreRows.map(shape), due: dueRows.map(shape) };
}

// Batch for CLS consolidation: the highest-priority un-consolidated EPISODIC memories to generalise,
// plus a sample of existing SEMANTIC memories for interleaving context (so the LLM does not re-derive or
// contradict prior generalisations — the antidote to catastrophic interference).
export function getConsolidationBatch({ limit = 12, project } = {}) {
  const db = getDb();
  const proj = project ? ' AND project = ?' : '';
  const live = `superseded_by IS NULL AND consolidated_into IS NULL AND review_status != 'rejected'`;
  const episodics = db.prepare(
    `SELECT id, title, content, reasoning, importance, outcome_score FROM documents
     WHERE memory_system = 'episodic' AND created_by IN ('user','agent') AND ${live}${proj}`
  ).all(...(project ? [project] : []))
    .map(m => ({ ...m, replay_priority: (m.importance == null ? 0.5 : m.importance) * (1 + Math.abs(m.outcome_score || 0)) }))
    .sort((a, b) => b.replay_priority - a.replay_priority)
    .slice(0, limit);
  const semantics = db.prepare(
    `SELECT id, title, content FROM documents WHERE memory_system = 'semantic' AND created_by IN ('user','agent') AND ${live}${proj}
     ORDER BY importance DESC LIMIT 8`
  ).all(...(project ? [project] : []));
  return { episodics, semantics };
}

// Prioritised replay (consolidation order, not FIFO): rank live memories by importance × surprise
// (|outcome_score|) so a consolidator generalises the most consequential experiences first
// (Prioritized Experience Replay; Schaul 2015 — SOTA ML, brain-independent).
export function getReplayQueue({ limit = 20, project } = {}) {
  const db = getDb();
  const where = `created_by IN ('user','agent') AND superseded_by IS NULL AND consolidated_into IS NULL AND review_status != 'rejected'`
    + (project ? ' AND project = ?' : '');
  const rows = db.prepare(`SELECT * FROM documents WHERE ${where}`).all(...(project ? [project] : []));
  return rows
    .map(m => ({
      id: m.id, title: m.title, memory_system: m.memory_system,
      importance: m.importance, outcome_score: m.outcome_score,
      replay_priority: Number(((m.importance == null ? 0.5 : m.importance) * (1 + Math.abs(m.outcome_score || 0))).toFixed(4)),
    }))
    .sort((a, b) => b.replay_priority - a.replay_priority)
    .slice(0, limit);
}

// --- Portability: export/import the shared brain as NDJSON (provenance preserved) ---
const MEMORY_EXPORT_FIELDS = ['title', 'content', 'reasoning', 'doc_type', 'tags', 'project',
  'created_by', 'author_detail', 'confidence', 'importance', 'outcome_score', 'predicted_outcome',
  'memory_system', 'storage_strength', 'review_status', 'created_at'];

export function exportMemories({ project, includeSuperseded = false } = {}) {
  const db = getDb();
  const where = `created_by IN ('user','agent')`
    + (includeSuperseded ? '' : ' AND superseded_by IS NULL')
    + (project ? ' AND project = ?' : '');
  const rows = db.prepare(`SELECT * FROM documents WHERE ${where} ORDER BY created_at ASC`).all(...(project ? [project] : []));
  return rows.map(r => { const o = {}; for (const f of MEMORY_EXPORT_FIELDS) o[f] = r[f]; return o; });
}

export function exportMemoriesNDJSON(opts) {
  return exportMemories(opts).map(m => JSON.stringify(m)).join('\n');
}

// Import memories from NDJSON. Dedupes on content_hash; preserves provenance/confidence/review_status.
// Imported memories are (best-effort) embedded so they are immediately recallable by meaning.
export function importMemories(ndjson) {
  const db = getDb();
  const lines = String(ndjson || '').split('\n').map(l => l.trim()).filter(Boolean);
  let imported = 0, skipped = 0;
  for (const line of lines) {
    try {
      let m;
      try { m = JSON.parse(line); } catch { skipped++; continue; }
      if (!m || typeof m.title !== 'string' || typeof m.content !== 'string') { skipped++; continue; }
      const hash = createHash('sha256').update(m.content).digest('hex').slice(0, 32);
      if (db.prepare('SELECT id FROM documents WHERE content_hash = ?').get(hash)) { skipped++; continue; }
      // Untrusted file: preserve provenance/age/learned-signal, but DON'T trust authority — re-enter the
      // review queue (pending) and cap confidence at 'inferred' so an exported file can't inject
      // auto-accepted, user-authoritative CORE memories.
      const ci = CONFIDENCE_LADDER.indexOf(m.confidence);
      const cappedConfidence = ci >= 0 ? CONFIDENCE_LADDER[Math.max(ci, 2)] : 'inferred';
      const doc = insertDocument({
        title: m.title, content: m.content, reasoning: m.reasoning, doc_type: m.doc_type || 'memory',
        tags: m.tags, source: 'import', created_by: m.created_by || 'agent', author_detail: m.author_detail,
        confidence: cappedConfidence, importance: m.importance, review_status: 'pending',
        project: m.project, memory_system: m.memory_system, storage_strength: m.storage_strength,
        file_size: Buffer.byteLength(String(m.content)),
      });
      if (doc && doc.id != null) {
        // Preserve the learned reward signal and the original timestamp (recency) the file carried.
        db.prepare('UPDATE documents SET outcome_score = ?, predicted_outcome = ?, created_at = COALESCE(?, created_at) WHERE id = ?')
          .run(Number(m.outcome_score) || 0, Number(m.predicted_outcome) || 0, m.created_at || null, doc.id);
        if (_autoEmbedEnabled) embedMemorySafe(doc.id);
      }
      imported++;
    } catch { skipped++; }
  }
  return { imported, skipped, total: lines.length };
}
