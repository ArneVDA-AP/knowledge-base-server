// src/routes/v1.js
import { Router } from 'express';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, unlinkSync } from 'fs';

import {
  searchDocuments,
  listDocuments,
  getDocument,
  getStats,
  getDb,
  deleteDocument,
  updateDocumentFull,
  updateDocumentSummary,
} from '../db.js';
// Memory ops come from the first-principles store (docs/memory-bridge/07), not the documents domain.
import {
  remember,
  recall,
  recordOutcome,
  supersede,
  listPending,
  review,
  brief,
} from '../memory/store.js';
import { ingestText } from '../ingest.js';

const router = Router();

// Default vault path for capture functions
const DEFAULT_VAULT_PATH = join(homedir(), 'knowledgebase');

// ─── Read Endpoints ──────────────────────────────────────────────────────────

// GET /health
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// GET /stats
router.get('/stats', (req, res) => {
  try {
    const stats = getStats();
    res.json({
      total_documents: stats.count,
      total_size_bytes: stats.totalSize,
      db_size_bytes: stats.dbFileSize,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /search — FTS5 search
router.get('/search', (req, res) => {
  const { q, type, project } = req.query;
  let limit = parseInt(req.query.limit, 10) || 20;
  if (limit > 100) limit = 100;

  if (!q) {
    return res.status(400).json({ error: 'Missing required query param: q' });
  }

  try {
    let results = searchDocuments(q, limit);

    if (type) {
      results = results.filter(r => r.doc_type === type);
    }
    if (project) {
      // Filter via vault_files join — do a lightweight DB query
      const projectDocIds = new Set(
        getDb()
          .prepare('SELECT document_id FROM vault_files WHERE project = ?')
          .all(project)
          .map(r => r.document_id)
      );
      results = results.filter(r => projectDocIds.has(r.id));
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /search/smart — hybrid (FTS5 + semantic) search
router.get('/search/smart', async (req, res) => {
  const { q, project, type } = req.query;
  let limit = parseInt(req.query.limit, 10) || 10;
  if (limit > 50) limit = 50;

  if (!q) {
    return res.status(400).json({ error: 'Missing required query param: q' });
  }

  try {
    const { hybridSearch } = await import('../embeddings/search.js');
    const results = await hybridSearch(q, { limit, project, type });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /context — token-efficient briefing from vault summaries
router.get('/context', async (req, res) => {
  const { q, type, project } = req.query;
  let limit = parseInt(req.query.limit, 10) || 15;
  if (limit > 50) limit = 50;

  if (!q) {
    return res.status(400).json({ error: 'Missing required query param: q' });
  }

  try {
    const ftsResults = searchDocuments(q, limit);

    // Filter by type/project if requested
    let filtered = ftsResults;
    if (type) {
      filtered = filtered.filter(r => r.doc_type === type);
    }
    if (project) {
      const projectDocIds = new Set(
        getDb()
          .prepare('SELECT document_id FROM vault_files WHERE project = ?')
          .all(project)
          .map(r => r.document_id)
      );
      filtered = filtered.filter(r => projectDocIds.has(r.id));
    }

    // Pull summaries from vault_files table for matched documents
    const db = getDb();
    const sources = [];
    const briefingParts = [];

    for (const doc of filtered) {
      const vf = db
        .prepare('SELECT summary, key_topics FROM vault_files WHERE document_id = ?')
        .get(doc.id);

      sources.push({ id: doc.id, title: doc.title });

      if (vf && vf.summary) {
        const topics = vf.key_topics ? ` [${vf.key_topics}]` : '';
        briefingParts.push(`### ${doc.title}${topics}\n${vf.summary}`);
      } else if (doc.snippet) {
        briefingParts.push(`### ${doc.title}\n${doc.snippet}`);
      }
    }

    const briefing =
      briefingParts.length > 0
        ? briefingParts.join('\n\n')
        : `No context found for query: "${q}"`;

    res.json({ briefing, sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /documents — list documents
router.get('/documents', (req, res) => {
  const { type, tag, source } = req.query;
  let limit = parseInt(req.query.limit, 10) || 50;
  let offset = parseInt(req.query.offset, 10) || 0;
  if (limit > 200) limit = 200;

  try {
    const documents = listDocuments({
      type: type || undefined,
      tag: tag || undefined,
      source: source || undefined,
      limit,
      offset,
    });
    res.json({ documents, total: documents.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /documents/:id — read full document
router.get('/documents/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid document id' });
  }

  try {
    const doc = getDocument(id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /documents/:id — delete a document
router.delete('/documents/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid document id' });
  }
  try {
    const doc = getDocument(id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    const filePath = deleteDocument(id);
    if (filePath && existsSync(filePath)) {
      try { unlinkSync(filePath); } catch {}
    }
    res.json({ deleted: true, id, title: doc.title, doc_type: doc.doc_type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /documents/:id — update an existing document
router.put('/documents/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid document id' });

  try {
    const existing = getDocument(id);
    if (!existing) return res.status(404).json({ error: 'Document not found' });

    const { title, content, tags, doc_type, source } = req.body ?? {};
    const merged = {
      title: title ?? existing.title,
      content: content ?? existing.content,
      tags: tags ?? existing.tags,
      doc_type: doc_type ?? existing.doc_type,
      source: source ?? existing.source,
      file_path: existing.file_path,
      file_size: content ? Buffer.byteLength(content, 'utf8') : existing.file_size,
    };
    updateDocumentFull(id, merged);

    if (content && content !== existing.content) {
      updateDocumentSummary(id, null);
    }

    res.json({ id, ...merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /documents/:id/summarize — on-demand summarization
router.post('/documents/:id/summarize', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid document id' });

  const profile = req.query.profile ?? 'default';
  const force = req.query.force === 'true';

  try {
    const doc = getDocument(id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    if (doc.summary && !force) {
      return res.json({ id, summary: doc.summary, profile, cached: true });
    }

    const { summarizeNote } = await import('../classify/summarizer.js');
    const result = await summarizeNote(doc.title, doc.content, { profile });
    if (!result.success) {
      return res.status(500).json({ error: 'summarize_failed', detail: result.error });
    }

    updateDocumentSummary(id, result.summary);
    res.json({ id, summary: result.summary, profile, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Write Endpoints ─────────────────────────────────────────────────────────

// POST /ingest — ingest text document
router.post('/ingest', (req, res) => {
  const { title, content, tags, doc_type, source } = req.body || {};

  if (!title || !content) {
    return res.status(400).json({ error: 'Missing required fields: title, content' });
  }

  try {
    const doc = ingestText(title, content, { tags, doc_type, source });
    // Fetch from DB to get the created_at timestamp set by SQLite default
    const stored = getDocument(doc.id);
    res.status(201).json({
      id: doc.id,
      title: doc.title,
      created_at: stored?.created_at || new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /capture/session — record a terminal session
router.post('/capture/session', async (req, res) => {
  const { goal, commands_worked, commands_failed, root_causes, fixes, lessons, project, machine } =
    req.body || {};

  if (!goal) {
    return res.status(400).json({ error: 'Missing required field: goal' });
  }

  try {
    const { captureSession } = await import('../capture/terminal.js');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT_PATH;
    const result = captureSession(
      { goal, commands_worked, commands_failed, root_causes, fixes, lessons, project, machine },
      vaultPath
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /capture/fix — record a fix/solution
router.post('/capture/fix', async (req, res) => {
  const { title, symptom, cause, resolution, commands, project, stack } = req.body || {};

  if (!title) {
    return res.status(400).json({ error: 'Missing required field: title' });
  }

  try {
    const { captureFix } = await import('../capture/terminal.js');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT_PATH;
    const result = captureFix(
      { title, symptom, cause, resolution, commands, project, stack },
      vaultPath
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /capture/web — capture a web article
router.post('/capture/web', async (req, res) => {
  const { title, url, content, tags, project } = req.body || {};

  if (!title || !url || !content) {
    return res.status(400).json({ error: 'Missing required fields: title, url, content' });
  }

  try {
    const { captureWeb } = await import('../capture/web.js');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT_PATH;
    const result = captureWeb({ title, url, content, tags, project }, vaultPath);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Shared brain: memory bridge (agent side) ──────────────────────────────────
// API-key / OAuth callers are agents, so provenance is fixed to 'agent' here
// (decided at the call site — the shared store cannot infer transport).

// POST /memory — agent writes a memory (enters the review queue, capped below 'verified')
router.post('/memory', (req, res) => {
  const { content, reasoning, kind, type, importance, confidence, project } = req.body || {};
  if (!content) {
    return res.status(400).json({ error: 'Missing required field: content' });
  }
  try {
    const origin = req.apiService ? `api:${req.apiService}` : 'api';
    const m = remember({ kind: kind || type, content, reasoning, importance, confidence, project, created_by: 'agent', source: { origin } });
    res.status(201).json(m);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /memory/recall — salience-ranked recall with trust signals (strengthens on recall)
router.get('/memory/recall', async (req, res) => {
  const { q, project, kind, type } = req.query;
  let limit = parseInt(req.query.limit, 10) || 8;
  if (limit > 50) limit = 50;
  const includeSuperseded = req.query.includeSuperseded === 'true';
  try {
    res.json({ results: await recall(q || '', { limit, project, kind: kind || type, includeSuperseded }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /memory/:id/outcome — record that a memory helped or burned
router.post('/memory/:id/outcome', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid memory id' });
  const { outcome } = req.body || {};
  if (!['helped', 'burned'].includes(outcome)) {
    return res.status(400).json({ error: "outcome must be 'helped' or 'burned'" });
  }
  try {
    const r = recordOutcome(id, outcome);
    if (!r) return res.status(404).json({ error: 'Memory not found' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /memory/supersede — demote-don't-delete supersession
router.post('/memory/supersede', (req, res) => {
  const { old_id, new_id, reason } = req.body || {};
  if (old_id == null) return res.status(400).json({ error: 'old_id required' });
  try {
    const r = supersede(old_id, new_id, reason);
    if (!r) return res.status(404).json({ error: 'Memory not found' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /memory/brief — session-start load (CORE + recently-used + pending count)
router.get('/memory/brief', (req, res) => {
  const core = parseInt(req.query.core, 10) || 7;
  const recent = parseInt(req.query.recent, 10) || 5;
  const { project } = req.query;
  try {
    res.json(brief({ core, recent, project }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /memory/review — list agent memories pending review
router.get('/memory/review', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  try {
    res.json({ pending: listPending({ limit }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /memory/review — accept/reject an agent memory (human audit loop)
router.post('/memory/review', (req, res) => {
  const { id, action } = req.body || {};
  if (id == null || !['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: "id and action ('accept'|'reject') required" });
  }
  try {
    const r = review(id, action);
    if (!r) return res.status(404).json({ error: 'Memory not found' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
