import { z } from 'zod';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { searchDocuments, listDocuments, getDocument, getStats, getDb, deleteDocument } from './db.js';
// Memory ops live in the first-principles store (docs/memory-bridge/07). db.js owns only the documents domain now.
import { remember, recall, recordOutcome, supersede, listPending, review, brief, consolidate } from './memory/store.js';
import { ingestText } from './ingest.js';
import { formatYamlTags } from './utils/frontmatter.js';
import { indexVault } from './vault/indexer.js';
import { captureYouTube } from './capture/youtube.js';
import { captureWeb } from './capture/web.js';
import { captureSession, captureFix } from './capture/terminal.js';
import { hybridSearch } from './embeddings/search.js';
import { getRecentNotes, generateSynthesisPrompt } from './synthesis/weekly-review.js';
import { processNewClippings } from './classify/processor.js';
import { reviewDestructiveAction } from './safety/review.js';

const ADMIN_ONLY_TOOLS = new Set([
  'kb_classify',
  'kb_promote',
  'kb_synthesize',
  'kb_safety_check',
  'kb_capture_youtube',
  'kb_delete',
  'kb_memory_review',
  'kb_consolidate',
]);

export function getToolDefinitions() {
  return [
    {
      name: 'kb_search',
      description: 'Search the knowledge base using full-text search. Returns ranked results with highlighted snippets.',
      schema: {
        query: z.string().describe('Full-text search query'),
        limit: z.number().optional().default(20).describe('Maximum number of results to return'),
      },
      handler: async ({ query, limit }) => {
        try {
          const results = searchDocuments(query, limit);
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_list',
      description: 'List documents in the knowledge base, optionally filtered by type or tag.',
      schema: {
        type: z.string().optional().describe('Filter by document type (e.g. text, markdown, code, pdf)'),
        tag: z.string().optional().describe('Filter by tag'),
        limit: z.number().optional().default(50).describe('Maximum number of results to return'),
      },
      handler: async ({ type, tag, limit }) => {
        try {
          const results = listDocuments({ type, tag, limit });
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_read',
      description: 'Read the full content of a specific document by its ID.',
      schema: {
        id: z.number().describe('Document ID'),
      },
      handler: async ({ id }) => {
        try {
          const doc = getDocument(id);
          if (!doc) {
            return { content: [{ type: 'text', text: `Error: Document with ID ${id} not found.` }], isError: true };
          }
          return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_ingest',
      description: 'Ingest a new document into the knowledge base from text content.',
      schema: {
        title: z.string().describe('Document title'),
        content: z.string().describe('Document text content'),
        tags: z.string().optional().describe('Comma-separated tags'),
      },
      handler: async ({ title, content, tags }) => {
        try {
          const doc = ingestText(title, content, { tags });
          return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_write',
      description: 'Write a new note to the Obsidian vault. Use this to capture knowledge, ideas, lessons, or research that should persist across sessions. The note will be synced to all devices via Obsidian Sync.',
      schema: {
        title: z.string().describe('Note title'),
        content: z.string().describe('Markdown content (body text, no frontmatter needed)'),
        type: z.enum(['research', 'idea', 'workflow', 'lesson', 'fix', 'decision', 'session', 'capture'])
          .optional().default('capture').describe('Note type — determines vault folder destination'),
        tags: z.string().optional().describe('Comma-separated tags'),
        project: z.string().optional().describe('Project name (e.g. my-app, backend, frontend)'),
      },
      handler: async ({ title, content, type, tags, project }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };

          const folderMap = {
            capture: 'inbox',
            research: 'research',
            idea: 'ideas',
            workflow: 'workflows',
            lesson: 'agents/lessons',
            fix: 'builds/fixes',
            decision: 'decisions',
            session: 'builds/sessions',
          };
          const folder = folderMap[type] || 'inbox';
          const destDir = join(vaultPath, folder);
          mkdirSync(destDir, { recursive: true });

          const date = new Date().toISOString().split('T')[0];
          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
          const filename = `${date}-${slug}.md`;
          const filePath = join(destDir, filename);

          const tagList = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
          const fm = [
            '---',
            `title: "${title}"`,
            `type: ${type}`,
            `created: "${date}"`,
            `updated: "${date}"`,
            formatYamlTags(tagList),
          ];
          if (project) fm.push(`project: ${project}`);
          fm.push('status: active');
          fm.push('---');

          writeFileSync(filePath, fm.join('\n') + '\n\n' + content);

          // Index immediately so the note is searchable right away
          try { await indexVault(vaultPath); } catch { /* non-fatal */ }

          return { content: [{ type: 'text', text: `Note saved to ${folder}/${filename}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_vault_status',
      description: 'Show vault indexing status — how many notes are indexed, by type and project.',
      schema: {},
      handler: async () => {
        try {
          const stats = getStats();
          const db = getDb();
          const byType = db.prepare(
            'SELECT note_type, COUNT(*) as count FROM vault_files GROUP BY note_type ORDER BY count DESC'
          ).all();
          const byProject = db.prepare(
            'SELECT project, COUNT(*) as count FROM vault_files WHERE project IS NOT NULL GROUP BY project ORDER BY count DESC'
          ).all();
          return { content: [{ type: 'text', text: JSON.stringify({ ...stats, byType, byProject }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_youtube',
      description: 'Capture a YouTube video transcript into the knowledge base. Creates a structured note with metadata.',
      schema: {
        title: z.string().describe('Video title'),
        url: z.string().describe('YouTube URL'),
        transcript: z.string().describe('Video transcript text'),
        channel: z.string().optional().describe('Channel name'),
        tags: z.string().optional().describe('Comma-separated tags'),
      },
      handler: async ({ title, url, transcript, channel, tags }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const result = captureYouTube({ title, url, transcript, channel, tags }, vaultPath);
          try { await indexVault(vaultPath); } catch { /* non-fatal */ }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_web',
      description: 'Capture a web article or URL into the knowledge base. Use this whenever you find useful information during research.',
      schema: {
        title: z.string().describe('Article/page title'),
        url: z.string().describe('Source URL'),
        content: z.string().describe('Article content or summary in markdown'),
        tags: z.string().optional().describe('Comma-separated tags'),
        project: z.string().optional().describe('Related project'),
      },
      handler: async ({ title, url, content, tags, project }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const result = captureWeb({ title, url, content, tags, project }, vaultPath);
          try { await indexVault(vaultPath); } catch { /* non-fatal */ }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_session',
      description: 'Record a terminal/coding session summary — what you tried, what worked, what failed, and lessons learned. IMPORTANT: Call this at the end of every significant debugging or implementation session.',
      schema: {
        goal: z.string().describe('What was the session trying to accomplish'),
        commands_failed: z.string().optional().describe('Commands that failed (markdown list)'),
        commands_worked: z.string().optional().describe('Commands that worked (markdown list)'),
        root_causes: z.string().optional().describe('Root cause analysis'),
        fixes: z.string().optional().describe('Fixes applied'),
        lessons: z.string().optional().describe('Key takeaways and lessons learned'),
        project: z.string().optional().describe('Project name'),
        machine: z.string().optional().describe('Machine/environment identifier'),
      },
      handler: async ({ goal, commands_failed, commands_worked, root_causes, fixes, lessons, project, machine }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const result = captureSession({ goal, commands_failed, commands_worked, root_causes, fixes, lessons, project, machine }, vaultPath);
          try { await indexVault(vaultPath); } catch { /* non-fatal */ }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_capture_fix',
      description: 'Record a bug fix with symptom, cause, and resolution. Creates a searchable fix note for future reference.',
      schema: {
        title: z.string().describe('Short title for the fix'),
        symptom: z.string().optional().describe('What the symptom/error was'),
        cause: z.string().optional().describe('Root cause'),
        resolution: z.string().optional().describe('How it was fixed'),
        commands: z.string().optional().describe('Key commands used'),
        project: z.string().optional().describe('Project name'),
        stack: z.string().optional().describe('Tech stack (e.g. node, docker, postgres)'),
      },
      handler: async ({ title, symptom, cause, resolution, commands, project, stack }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const result = captureFix({ title, symptom, cause, resolution, commands, project, stack }, vaultPath);
          try { await indexVault(vaultPath); } catch { /* non-fatal */ }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_search_smart',
      description: 'Smart search combining keyword matching and semantic similarity. Better than kb_search for conceptual queries like "how do we handle authentication" vs exact keyword matches.',
      schema: {
        query: z.string().describe('Search query — can be a question or topic'),
        limit: z.number().optional().default(10),
        project: z.string().optional().describe('Filter by project'),
        type: z.string().optional().describe('Filter by note type'),
      },
      handler: async ({ query, limit, project, type }) => {
        try {
          const results = await hybridSearch(query, { limit, project, type });
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_promote',
      description: 'Analyze a source/inbox note and promote it into structured knowledge. Read the note, classify it, then use kb_write to create promoted notes (research, ideas, workflows, lessons).',
      schema: {
        note_path: z.string().describe('Vault-relative path to the source note (e.g. sources/web/article.md)'),
      },
      handler: async ({ note_path }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          return { content: [{ type: 'text', text: `To promote this note, read it and use kb_write to create the appropriate output notes (research, idea, workflow, lesson, decision) based on what you extract. Source note: ${note_path}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_synthesize',
      description: 'Generate a synthesis of recent knowledge. Connects dots across sources to find themes, opportunities, and improvements.',
      schema: {
        days: z.number().optional().default(7).describe('How many days back to look'),
      },
      handler: async ({ days }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const notes = getRecentNotes(vaultPath, days);
          if (notes.length === 0) return { content: [{ type: 'text', text: 'No recent notes to synthesize.' }] };
          const prompt = generateSynthesisPrompt(notes);
          return { content: [{ type: 'text', text: prompt }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_classify',
      description: 'Auto-classify new clippings and inbox notes using AI. Reads unprocessed notes, classifies them (type, tags, project, summary), and updates their frontmatter. Run this after syncing new content.',
      schema: {
        dry_run: z.boolean().optional().default(false).describe('Preview classifications without writing changes'),
      },
      handler: async ({ dry_run }) => {
        try {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
          if (!vaultPath) return { content: [{ type: 'text', text: 'Error: OBSIDIAN_VAULT_PATH not configured' }], isError: true };
          const result = await processNewClippings(vaultPath, { dryRun: dry_run });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_context',
      description: 'Get a token-efficient briefing on a topic. Returns summaries and metadata for matching docs WITHOUT full content. Use this BEFORE kb_read to decide which docs are worth reading in full. Saves 90%+ tokens vs reading everything.',
      schema: {
        query: z.string().describe('Topic or question to get context on'),
        limit: z.number().optional().default(15).describe('Max docs to include'),
        project: z.string().optional().describe('Filter by project'),
        type: z.string().optional().describe('Filter by note type'),
      },
      handler: async ({ query, limit, project, type }) => {
        try {
          const db = getDb();
          const ftsResults = searchDocuments(query, limit);

          const briefings = ftsResults.map(r => {
            const vf = db.prepare('SELECT vault_path, note_type, tags, project, summary, key_topics FROM vault_files WHERE document_id = ?').get(r.id);
            return {
              id: r.id,
              title: r.title,
              type: vf?.note_type || r.doc_type,
              tags: vf?.tags || r.tags,
              project: vf?.project || null,
              created_by: r.created_by,
              confidence: r.confidence,
              summary: vf?.summary || r.snippet?.replace(/<\/?mark>/g, '').slice(0, 200),
              key_topics: vf?.key_topics || null,
              created_at: r.created_at,
              updated_at: r.updated_at,
            };
          });

          if (project || type) {
            let sql = `SELECT vf.document_id as id, vf.title, vf.note_type, vf.tags, vf.project, vf.summary, vf.key_topics,
              d.created_at, d.updated_at
              FROM vault_files vf
              LEFT JOIN documents d ON d.id = vf.document_id
              WHERE 1=1`;
            const params = [];
            if (project) { sql += ' AND vf.project = ?'; params.push(project); }
            if (type) { sql += ' AND vf.note_type = ?'; params.push(type); }
            sql += ' LIMIT ?';
            params.push(limit);
            const filtered = db.prepare(sql).all(...params);
            const seenIds = new Set(briefings.map(b => b.id));
            for (const f of filtered) {
              if (!seenIds.has(f.id)) {
                briefings.push({ id: f.id, title: f.title, type: f.note_type, tags: f.tags, project: f.project, summary: f.summary, key_topics: f.key_topics, created_at: f.created_at, updated_at: f.updated_at });
              }
            }
          }

          const header = `Found ${briefings.length} relevant docs. Use kb_read(id) for full content on any that look useful.`;
          return { content: [{ type: 'text', text: header + '\n\n' + JSON.stringify(briefings, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_safety_check',
      description: 'Review a potentially destructive action before executing it. Searches KB for past incidents, evaluates risk, and returns a safety verdict. Use this before ANY destroy, delete, drop, or force-push operation.',
      schema: {
        action: z.string().describe('The destructive action about to be taken (e.g. "destroy vast.ai instance 12345")'),
        context: z.string().optional().describe('Additional context about why this is being done'),
      },
      handler: async ({ action, context }) => {
        try {
          const result = await reviewDestructiveAction(action, context);
          const prefix = result.safe ? 'SAFE' : 'BLOCKED';
          return { content: [{ type: 'text', text: `[${prefix}] Risk: ${result.risk_level}\n\n${JSON.stringify(result, null, 2)}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_delete',
      description: 'Delete a document from the knowledge base by ID. Removes the document, its FTS index entries, and any embeddings. If the document was ingested from a file, the stored copy is also deleted. Use kb_list or kb_search to find document IDs first.',
      schema: {
        id: z.number().describe('Document ID to delete'),
      },
      handler: async ({ id }) => {
        try {
          const doc = getDocument(id);
          if (!doc) {
            return { content: [{ type: 'text', text: `Error: Document with ID ${id} not found.` }], isError: true };
          }
          const filePath = deleteDocument(id);
          if (filePath && existsSync(filePath)) {
            try { unlinkSync(filePath); } catch { /* non-fatal */ }
          }
          return {
            content: [{ type: 'text', text: JSON.stringify({ deleted: true, id, title: doc.title, doc_type: doc.doc_type }) }],
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    // --- The shared brain: memory bridge (Claude <-> User), backed by src/memory/store.js ---
    {
      name: 'kb_remember',
      description: 'Write a memory to the shared Claude<->User brain. Persist a durable learning, decision, preference, prohibition, or fact — WITH its reasoning (the "why"), so it transfers to new situations instead of being misapplied. Agent-written memories enter a review queue at "inferred" confidence (agents can never self-declare "verified") until the user accepts them. Prefer this over kb_ingest for knowledge that should compound across sessions.',
      schema: {
        content: z.string().describe('The memory itself — the durable fact/decision/lesson/preference (1-3 sentences)'),
        reasoning: z.string().optional().describe('The WHY — what makes it true and when it applies. Strongly recommended: bare facts get misapplied.'),
        kind: z.enum(['episodic', 'semantic', 'procedural']).optional().describe('semantic = durable fact/decision (default); episodic = a specific event; procedural = a how-to/skill'),
        importance: z.number().optional().describe('0..1; high-importance memories stay salient even when unread (default 0.5)'),
        confidence: z.enum(['asserted', 'inferred', 'unverified']).optional().describe('inferred = best guess (agent default); asserted = stated with grounds'),
        project: z.string().optional().describe('Project scope'),
      },
      handler: async ({ content, reasoning, kind, importance, confidence, project }) => {
        try {
          // Provenance is hardcoded 'agent' — an MCP caller cannot forge 'user' (which would bypass review).
          // User-authored memories come only from the dashboard (cookie auth). store.remember also caps
          // agent confidence below 'verified'.
          const m = remember({ kind, content, reasoning, importance, confidence, created_by: 'agent', project, source: { origin: 'mcp' } });
          return { content: [{ type: 'text', text: JSON.stringify(m, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_recall',
      description: 'Recall memories from the shared brain, ranked by salience (relevance × recency × importance × confidence × outcome). Returns trust signals — who wrote it (user/agent), confidence, importance, outcome — so you know how much to trust each one before acting. Recalling a memory strengthens it ("pays rent"). Use this at the start of work to load what is already known about a topic.',
      schema: {
        query: z.string().optional().describe('Topic/question to recall about (omit for the most-salient recent memories)'),
        limit: z.number().optional().default(8),
        project: z.string().optional().describe('Filter by project'),
        kind: z.enum(['episodic', 'semantic', 'procedural']).optional().describe('Filter by memory kind'),
        includeSuperseded: z.boolean().optional().default(false).describe('Include superseded (demoted) memories'),
      },
      handler: async ({ query, limit, project, kind, includeSuperseded }) => {
        try {
          const results = await recall(query || '', { limit, project, kind, includeSuperseded });
          const header = `Recalled ${results.length} memories, salience-ranked. Trust signals included (created_by, confidence, importance, outcome).`;
          return { content: [{ type: 'text', text: header + '\n\n' + JSON.stringify(results, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_memory_outcome',
      description: 'Record that acting on a memory helped or burned you. A burn lowers its confidence one notch (never deletes it). This is how the brain learns which advice keeps paying off and which has gone stale — turning outcomes into calibrated trust over time.',
      schema: {
        id: z.number().describe('Memory ID'),
        outcome: z.enum(['helped', 'burned']).describe('Did acting on this memory help or burn you?'),
      },
      handler: async ({ id, outcome }) => {
        try {
          const r = recordOutcome(id, outcome);
          if (!r) return { content: [{ type: 'text', text: `Error: memory ${id} not found` }], isError: true };
          return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_supersede',
      description: 'Mark an old memory as superseded by a newer one (demote, do NOT delete). The old memory leaves default recall but stays queryable, so a corrected belief is remembered AS corrected and never silently relearned. Use when you learn a stored memory was wrong or outdated.',
      schema: {
        old_id: z.number().describe('The memory being replaced'),
        new_id: z.number().optional().describe('The replacement memory ID (optional)'),
        reason: z.string().optional().describe('Why it was superseded (kept visible)'),
      },
      handler: async ({ old_id, new_id, reason }) => {
        try {
          const r = supersede(old_id, new_id, reason);
          if (!r) return { content: [{ type: 'text', text: `Error: memory ${old_id} not found` }], isError: true };
          return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_memory_review',
      description: 'Human-audit loop for the brain (admin-only): list agent-written memories awaiting review, or accept/reject one. This is the propose/dispose contract — Claude proposes memories, the user disposes. Rejected memories drop out of recall.',
      schema: {
        action: z.enum(['list', 'accept', 'reject']).describe('list pending memories, or accept/reject one'),
        id: z.number().optional().describe('Memory ID (required for accept/reject)'),
        limit: z.number().optional().default(50).describe('Max pending memories to list'),
      },
      handler: async ({ action, id, limit }) => {
        try {
          if (action === 'list') {
            return { content: [{ type: 'text', text: JSON.stringify(listPending({ limit }), null, 2) }] };
          }
          if (id == null) return { content: [{ type: 'text', text: 'Error: id required for accept/reject' }], isError: true };
          const r = review(id, action);
          if (!r) return { content: [{ type: 'text', text: `Error: memory ${id} not found` }], isError: true };
          return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_consolidate',
      description: 'Session-close consolidation (continuous learning): extract durable, reusable memories (facts/decisions/lessons/preferences/prohibitions, each WITH its reasoning) from a work session, dedupe them, and write the survivors as agent memories pending review. Call this at the END of a significant session. Admin-only. (The spine also runs this automatically via the Stop hook.)',
      schema: {
        text: z.string().describe('The session transcript or notes to consolidate into memories'),
        dry_run: z.boolean().optional().default(false).describe('Preview the extracted memories without writing'),
        project: z.string().optional().describe('Project scope for the resulting memories'),
      },
      handler: async ({ text, dry_run, project }) => {
        try {
          const result = await consolidate(text, { dryRun: dry_run, project });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'kb_session_brief',
      description: 'Session-start briefing from the shared brain: a small CORE (highest-importance accepted memories — prohibitions, key decisions, preferences) plus RECENTLY-USED memories and a count pending your review. Call this at the START of a session to load what matters without scanning everything. (The spine injects this automatically via the SessionStart hook.)',
      schema: {
        core: z.number().optional().default(7).describe('Max CORE (load-bearing) memories'),
        recent: z.number().optional().default(5).describe('Max recently-used memories'),
        project: z.string().optional().describe('Project scope'),
      },
      handler: async ({ core, recent, project }) => {
        try {
          const b = brief({ core, recent, project });
          const header = `Session brief: ${b.core.length} CORE + ${b.recent.length} recent memories, ${b.pending} pending review.`;
          return { content: [{ type: 'text', text: header + '\n\n' + JSON.stringify(b, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },
  ];
}

export function getHttpToolDefinitions() {
  return getToolDefinitions().filter(tool => !ADMIN_ONLY_TOOLS.has(tool.name));
}
