// src/consolidate.js — session-close consolidation: the continuous-learning path.
// Extract durable, reusable memories from a work session, dedupe against what's already
// known (semantically), and write the survivors as agent memories pending the user's review.
// Validated mechanism (docs/memory-bridge/01 §session-close-habit): periodic reflection
// written back to persistent memory is what makes a memory system compound.
import { runClaude } from './utils/claude.js';
import { rememberMemory, findSimilarMemory, embedMemory, findConflict, getConsolidationBatch, markConsolidated } from './db.js';

export const EXTRACT_PROMPT = `You extract durable, reusable MEMORIES from a work session for a shared Claude<->User knowledge base. Return ONLY valid JSON (no code fences):
{
  "memories": [
    {
      "title": "short title",
      "content": "the durable fact / decision / lesson / preference (1-3 sentences)",
      "reasoning": "WHY it is true and WHEN it applies, so it transfers to new situations",
      "type": "fact|decision|lesson|preference|prohibition",
      "importance": 0.0
    }
  ]
}
Rules:
- Extract only knowledge worth remembering ACROSS sessions: decisions + their rationale, hard-won lessons, stable preferences, prohibitions ("never do X because Y").
- Skip ephemeral chatter, transient state, one-off values, and anything tied only to this run.
- Prefer reasoning-rich entries; a bare fact without a "why" is low value.
- importance in [0,1]: hard prohibitions / load-bearing decisions high; minor notes low.
- If nothing is worth keeping, return {"memories": []}.`;

// Robustly pull the memories array out of model output — tolerant of code fences and of the
// model wrapping the JSON in prose (a common real-world failure of strict JSON.parse).
export function parseMemories(raw) {
  const s = String(raw || '');
  try {
    const p = JSON.parse(s.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim());
    if (p && Array.isArray(p.memories)) return p.memories;
    if (Array.isArray(p)) return p;
  } catch { /* fall through to block extraction */ }
  const key = s.indexOf('"memories"');
  if (key !== -1) {
    const start = s.lastIndexOf('{', key);
    if (start !== -1) {
      let depth = 0, inStr = false, esc = false;
      for (let j = start; j < s.length; j++) {
        const c = s[j];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { try { const p = JSON.parse(s.slice(start, j + 1)); if (Array.isArray(p.memories)) return p.memories; } catch { /* give up */ } break; }
        }
      }
    }
  }
  return [];
}

// Run the extractor LLM (or an injected fake for tests) and parse the candidate list.
export async function extractCandidates(text, { extractFn, model } = {}) {
  const run = extractFn || (async (prompt) => {
    const stdout = await runClaude(prompt, { model });
    let response;
    try { response = JSON.parse(stdout); } catch { return stdout; }   // non-JSON stdout: use raw
    if (response && typeof response === 'object' && typeof response.result === 'string') return response.result;
    return typeof response === 'string' ? response : '';
  });
  const raw = await run(`${EXTRACT_PROMPT}\n\nSESSION:\n${String(text || '').slice(0, 12000)}`);
  return parseMemories(raw);
}

// Extract → dedupe (semantic) → write as agent/pending memories. dryRun previews only.
export async function consolidate(text, { dryRun = false, project, extractFn, model, dedupeMin = 0.9 } = {}) {
  const candidates = await extractCandidates(text, { extractFn, model });
  const result = { extracted: candidates.length, written: 0, skipped: 0, items: [] };

  for (const c of candidates) {
    // Untrusted LLM output: require string title+content, and never let one bad candidate abort the run.
    if (!c || typeof c.title !== 'string' || typeof c.content !== 'string') { result.skipped++; continue; }
    try {
      let dup = null;
      try { dup = await findSimilarMemory(`${c.title}\n${c.content}`, { min: dedupeMin }); } catch { /* best-effort */ }
      if (dup) {
        result.skipped++;
        result.items.push({ title: c.title, action: 'skipped-duplicate', of: dup.id, similarity: Number(dup.similarity.toFixed(3)) });
        continue;
      }

      if (dryRun) {
        result.items.push({ title: c.title, type: c.type, importance: c.importance, action: 'would-write' });
        continue;
      }

      const doc = rememberMemory({
        title: c.title,
        content: c.content,
        reasoning: c.reasoning,
        doc_type: c.type || 'memory',
        importance: c.importance,
        created_by: 'agent',
        author_detail: 'consolidation',
        project,
      });
      // Embed now (deterministically) so a later candidate in THIS run dedupes against it.
      try { await embedMemory(doc.id); } catch { /* best-effort */ }
      // Surface a possible conflict (close-but-distinct neighbor) for human review — informational, not auto-resolved.
      let conflict = null;
      try { conflict = await findConflict(doc.id); } catch { /* best-effort */ }
      if (conflict) result.conflicts = (result.conflicts || 0) + 1;
      result.written++;
      result.items.push({ id: doc.id, title: c.title, action: 'written', conflict: conflict ? { with: conflict.id, similarity: conflict.similarity } : null });
    } catch {
      result.skipped++;
    }
  }

  return result;
}

export const GENERALISE_PROMPT = `You are the consolidator (the "sleep" pass). Generalise specific EPISODIC memories
into durable SEMANTIC memories — merge repeated patterns across episodes into reusable facts/decisions/lessons.
Return ONLY JSON (no fences):
{ "memories": [ { "title": "...", "content": "the durable generalisation", "reasoning": "why/when it applies", "importance": 0.0, "source_ids": [<the episodic ids this generalises>] } ] }
Rules: merge recurring patterns into ONE semantic memory; do NOT duplicate an existing semantic (they are listed for
context); cite the source episodic ids you actually generalised in source_ids; if nothing is worth generalising, return {"memories":[]}.`;

// CLS consolidation: turn the highest-priority episodic memories into semantic generalisations, linking
// provenance (derived_from) and demoting the sources (consolidated_into). The real "continuous learning"
// loop. Unit-verified with an injectable extractor; the real-LLM run uses the same runClaude as the summarizer.
export async function consolidateEpisodics({ batchSize = 12, extractFn, model, project, dryRun = false } = {}) {
  const { episodics, semantics } = getConsolidationBatch({ limit: batchSize, project });
  const result = { episodics: episodics.length, written: 0, demoted: 0, items: [] };
  if (!episodics.length) return result;

  const run = extractFn || (async (prompt) => {
    const stdout = await runClaude(prompt, { model });
    let r; try { r = JSON.parse(stdout); } catch { return stdout; }
    return (r && typeof r === 'object' && typeof r.result === 'string') ? r.result : (typeof r === 'string' ? r : '');
  });

  const epiBlock = episodics.map(e => `[${e.id}] ${e.title}: ${e.content}`).join('\n');
  const semBlock = semantics.map(s => `- ${s.title}: ${s.content}`).join('\n') || '(none yet)';
  const raw = await run(`${GENERALISE_PROMPT}\n\nEXISTING SEMANTIC MEMORIES (context — do not duplicate):\n${semBlock}\n\nEPISODIC MEMORIES TO GENERALISE:\n${epiBlock}`);

  const validIds = new Set(episodics.map(e => e.id));
  for (const g of parseMemories(raw)) {
    if (!g || typeof g.title !== 'string' || typeof g.content !== 'string') continue;
    const sourceIds = (Array.isArray(g.source_ids) ? g.source_ids : []).map(Number).filter(n => validIds.has(n));
    if (dryRun) { result.items.push({ title: g.title, source_ids: sourceIds, action: 'would-write' }); continue; }
    try {
      const doc = rememberMemory({
        title: g.title, content: g.content, reasoning: g.reasoning, doc_type: 'memory',
        memory_system: 'semantic', importance: g.importance, created_by: 'agent', author_detail: 'consolidator', project,
      });
      try { await embedMemory(doc.id); } catch { /* best-effort */ }
      if (sourceIds.length) { markConsolidated(sourceIds, doc.id); result.demoted += sourceIds.length; }
      result.written++;
      result.items.push({ id: doc.id, title: g.title, source_ids: sourceIds, action: 'written' });
    } catch { /* skip a bad generalisation, keep going */ }
  }
  return result;
}
