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

    -- First-principles rebuild (docs/memory-bridge/07): memory is a FIRST-CLASS ENTITY, not columns
    -- bolted onto documents. One taxonomy (episodic|semantic|procedural). Ops live in src/memory/store.js.
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'semantic',            -- episodic | semantic | procedural
      content TEXT NOT NULL,
      reasoning TEXT,                                   -- the WHY (transferable)
      created_by TEXT NOT NULL DEFAULT 'agent',         -- user | agent
      confidence TEXT NOT NULL DEFAULT 'inferred',      -- verified | asserted | inferred | unverified
      importance REAL NOT NULL DEFAULT 0.5,             -- [0,1]
      project TEXT,
      source TEXT,                                      -- JSON: where it came from
      outcome INTEGER NOT NULL DEFAULT 0,               -- net helped(+) / burned(-)
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at DATETIME,
      superseded_by INTEGER,                            -- demote-don't-delete
      supersession_reason TEXT,
      review_status TEXT NOT NULL DEFAULT 'pending',    -- pending | accepted | rejected
      content_hash TEXT,
      embedding BLOB,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash) WHERE content_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_review ON memories(review_status);
    CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, reasoning, content='memories', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, reasoning) VALUES (new.id, new.content, new.reasoning);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, reasoning) VALUES('delete', old.id, old.content, old.reasoning);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, reasoning) VALUES('delete', old.id, old.content, old.reasoning);
      INSERT INTO memories_fts(rowid, content, reasoning) VALUES (new.id, new.content, new.reasoning);
    END;
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

// NOTE: The memory domain moved to a first-class entity in src/memory/store.js (the `memories`
// table, owned here in initSchema). db.js now owns only the documents/vault/search domain. The old
// documents-bolted-on memory functions were cut in the first-principles rebuild (docs/memory-bridge/07);
// they remain in git history on master. Use migrateFromDocuments() in store.js to lift legacy rows.
