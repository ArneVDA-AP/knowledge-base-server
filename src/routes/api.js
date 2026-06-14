import { Router } from 'express';
import multer from 'multer';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir, homedir } from 'os';
import { randomBytes } from 'crypto';

import { authMiddleware } from '../auth.js';
import {
  listDocuments,
  searchDocuments,
  getDocument,
  updateDocument,
  deleteDocument,
  getStats,
} from '../db.js';
// Memory ops come from the first-principles store (docs/memory-bridge/07).
import {
  remember,
  recall,
  recordOutcome,
  supersede,
  listPending,
  review,
  brief,
} from '../memory/store.js';
import { ingestFile, ingestDirectory } from '../ingest.js';
import { indexVault } from '../vault/indexer.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// All API routes require auth
router.use('/api/documents', authMiddleware);
router.use('/api/ingest-directory', authMiddleware);
router.use('/api/stats', authMiddleware);
router.use('/api/memory', authMiddleware);

// GET /api/documents — list or search
router.get('/api/documents', (req, res) => {
  try {
    const { q, type, tag, limit, offset } = req.query;
    if (q) {
      const results = searchDocuments(q, limit ? parseInt(limit, 10) : 20);
      return res.json(results);
    }
    const results = listDocuments({
      type: type || undefined,
      tag: tag || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id
router.get('/api/documents/:id', (req, res) => {
  try {
    const doc = getDocument(parseInt(req.params.id, 10));
    if (!doc) return res.status(404).json({ error: 'Not found' });
    return res.json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/documents — file upload
router.post('/api/documents', upload.array('files'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const documents = [];
    const tags = req.body.tags || '';

    for (const file of req.files) {
      const tempName = `kb-upload-${randomBytes(8).toString('hex')}-${file.originalname}`;
      const tempPath = join(tmpdir(), tempName);

      try {
        writeFileSync(tempPath, file.buffer);
        const doc = await ingestFile(tempPath);
        if (doc) {
          // Fix title and source to use original filename
          const title = file.originalname.replace(/\.[^.]+$/, '');
          updateDocument(doc.id, { title, tags: tags || doc.tags });
          doc.title = title;
          doc.source = file.originalname;
          if (tags) doc.tags = tags;
          documents.push(doc);
        }
      } finally {
        try { unlinkSync(tempPath); } catch {}
      }
    }

    return res.json({ documents });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/documents/:id
router.put('/api/documents/:id', (req, res) => {
  try {
    const { title, tags } = req.body || {};
    updateDocument(parseInt(req.params.id, 10), { title, tags });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/documents/:id
router.delete('/api/documents/:id', (req, res) => {
  try {
    const filePath = deleteDocument(parseInt(req.params.id, 10));
    if (filePath && existsSync(filePath)) {
      try { unlinkSync(filePath); } catch {}
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/ingest-directory
router.post('/api/ingest-directory', async (req, res) => {
  try {
    const { path: dirPath } = req.body || {};
    if (!dirPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    const resolvedPath = resolve(dirPath);
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    const homeDir = homedir();
    const underVault = vaultPath && resolvedPath.startsWith(resolve(vaultPath));
    const underHome = resolvedPath.startsWith(homeDir);
    if (!underVault && !underHome) {
      return res.status(403).json({ error: 'Path not allowed' });
    }
    if (!existsSync(resolvedPath)) {
      return res.status(400).json({ error: `Path not found: ${dirPath}` });
    }
    const result = await ingestDirectory(resolvedPath);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/stats
router.get('/api/stats', (req, res) => {
  try {
    return res.json(getStats());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/vault/reindex — triggered by post-sync hook or manually
router.post('/api/vault/reindex', authMiddleware, async (req, res) => {
  try {
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath) {
      return res.status(400).json({ error: 'OBSIDIAN_VAULT_PATH not configured' });
    }
    const result = await indexVault(vaultPath);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/vault/status — check vault index state
router.get('/api/vault/status', authMiddleware, (req, res) => {
  try {
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
    return res.json({
      configured: !!vaultPath,
      vault_path: vaultPath || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Shared brain: memory bridge (user side) ───────────────────────────────────
// Dashboard is cookie-authenticated, so provenance is fixed to 'user' here — the
// user is authoritative on intent (decided at the call site, per the bridge contract).

// POST /api/memory — user writes an authoritative memory (accepted immediately)
router.post('/api/memory', (req, res) => {
  const { content, reasoning, kind, type, importance, confidence, project } = req.body || {};
  if (!content) {
    return res.status(400).json({ error: 'Missing required field: content' });
  }
  try {
    const m = remember({ kind: kind || type, content, reasoning, importance, confidence, project, created_by: 'user', source: { origin: 'dashboard' } });
    return res.status(201).json(m);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/memory/recall — salience-ranked recall with trust signals
router.get('/api/memory/recall', async (req, res) => {
  const { q, project, kind, type } = req.query;
  const limit = parseInt(req.query.limit, 10) || 10;
  const includeSuperseded = req.query.includeSuperseded === 'true';
  try {
    return res.json({ results: await recall(q || '', { limit, project, kind: kind || type, includeSuperseded }) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/memory/brief — session-start load (CORE + recently-used + pending count)
router.get('/api/memory/brief', (req, res) => {
  const core = parseInt(req.query.core, 10) || 7;
  const recent = parseInt(req.query.recent, 10) || 5;
  const { project } = req.query;
  try {
    return res.json(brief({ core, recent, project }));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/memory/pending — agent memories awaiting the user's review (propose/dispose)
router.get('/api/memory/pending', (req, res) => {
  try {
    return res.json({ pending: listPending({ limit: parseInt(req.query.limit, 10) || 50 }) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/memory/review — user accepts/rejects an agent memory
router.post('/api/memory/review', (req, res) => {
  const { id, action } = req.body || {};
  if (id == null || !['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: "id and action ('accept'|'reject') required" });
  }
  try {
    const r = review(id, action);
    if (!r) return res.status(404).json({ error: 'Memory not found' });
    return res.json(r);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/memory/supersede — user supersedes a memory (demote-don't-delete)
router.post('/api/memory/supersede', (req, res) => {
  const { old_id, new_id, reason } = req.body || {};
  if (old_id == null) return res.status(400).json({ error: 'old_id required' });
  try {
    const r = supersede(old_id, new_id, reason);
    if (!r) return res.status(404).json({ error: 'Memory not found' });
    return res.json(r);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/memory/:id/outcome — user records that a memory helped or burned
router.post('/api/memory/:id/outcome', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid memory id' });
  const { outcome } = req.body || {};
  if (!['helped', 'burned'].includes(outcome)) {
    return res.status(400).json({ error: "outcome must be 'helped' or 'burned'" });
  }
  try {
    const r = recordOutcome(id, outcome);
    if (!r) return res.status(404).json({ error: 'Memory not found' });
    return res.json(r);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
