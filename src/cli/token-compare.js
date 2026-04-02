// src/cli/token-compare.js — Compare raw document tokens vs KB summary tokens
import { getDb } from '../db.js';

/**
 * Approximate token count using chars/4 heuristic.
 * Accurate enough for comparison purposes without needing a tokenizer dependency.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

export function tokenCompare(args) {
  const db = getDb();
  const topFlag = args.find(a => a.startsWith('--top='));
  const topN = topFlag ? parseInt(topFlag.split('=')[1]) : 0;
  const showAll = args.includes('--all');

  // Join documents with vault_files to get raw content + summaries
  const rows = db.prepare(`
    SELECT d.id, d.title, d.content, vf.summary, vf.key_topics
    FROM documents d
    INNER JOIN vault_files vf ON vf.document_id = d.id
    WHERE vf.summary IS NOT NULL AND vf.summary != ''
    ORDER BY LENGTH(d.content) DESC
  `).all();

  if (rows.length === 0) {
    console.log('No documents with summaries found.');
    console.log('Run `kb summarize` first to generate summaries.');
    return;
  }

  const results = rows.map(row => {
    const rawTokens = estimateTokens(row.content);
    const summaryText = row.summary + (row.key_topics ? `\nTopics: ${row.key_topics}` : '');
    const summaryTokens = estimateTokens(summaryText);
    const saved = rawTokens - summaryTokens;
    const pct = rawTokens > 0 ? ((saved / rawTokens) * 100) : 0;
    return {
      id: row.id,
      title: row.title.length > 45 ? row.title.slice(0, 42) + '...' : row.title,
      rawTokens,
      summaryTokens,
      saved,
      pct,
    };
  });

  // Totals
  const totalRaw = results.reduce((s, r) => s + r.rawTokens, 0);
  const totalSummary = results.reduce((s, r) => s + r.summaryTokens, 0);
  const totalSaved = totalRaw - totalSummary;
  const totalPct = totalRaw > 0 ? ((totalSaved / totalRaw) * 100) : 0;

  // Count docs without summaries
  const totalDocs = db.prepare('SELECT COUNT(*) as n FROM documents').get().n;
  const unsummarized = totalDocs - rows.length;

  console.log('Token Comparison: Raw Documents vs KB Summaries');
  console.log('================================================\n');

  // Show per-document breakdown
  const displayRows = topN > 0 ? results.slice(0, topN) : (showAll ? results : results.slice(0, 20));

  if (displayRows.length > 0) {
    // Header
    const hId = 'ID'.padStart(5);
    const hTitle = 'Title'.padEnd(45);
    const hRaw = 'Raw'.padStart(8);
    const hSum = 'Summary'.padStart(8);
    const hSaved = 'Saved'.padStart(8);
    const hPct = '%'.padStart(6);
    console.log(`${hId}  ${hTitle}  ${hRaw}  ${hSum}  ${hSaved}  ${hPct}`);
    console.log('-'.repeat(87));

    for (const r of displayRows) {
      const id = String(r.id).padStart(5);
      const title = r.title.padEnd(45);
      const raw = formatNumber(r.rawTokens).padStart(8);
      const sum = formatNumber(r.summaryTokens).padStart(8);
      const saved = formatNumber(r.saved).padStart(8);
      const pct = (r.pct.toFixed(1) + '%').padStart(6);
      console.log(`${id}  ${title}  ${raw}  ${sum}  ${saved}  ${pct}`);
    }

    if (!showAll && !topN && results.length > 20) {
      console.log(`  ... and ${results.length - 20} more (use --all to show all, --top=N for top N)`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(87));
  console.log(`Total documents with summaries: ${rows.length}/${totalDocs}`);
  if (unsummarized > 0) {
    console.log(`Documents without summaries:    ${unsummarized} (run \`kb summarize\` to generate)`);
  }
  console.log(`\nRaw content tokens:    ${formatNumber(totalRaw).padStart(10)}`);
  console.log(`Summary tokens:        ${formatNumber(totalSummary).padStart(10)}`);
  console.log(`Tokens saved:          ${formatNumber(totalSaved).padStart(10)}  (${totalPct.toFixed(1)}%)`);

  if (totalRaw > 0) {
    // Cost estimate at ~$3/M input tokens (Claude Sonnet ballpark)
    const costRaw = (totalRaw / 1_000_000) * 3;
    const costSummary = (totalSummary / 1_000_000) * 3;
    const costSaved = costRaw - costSummary;
    console.log(`\nEstimated cost per full pass (~$3/M tokens):`);
    console.log(`  Raw:     $${costRaw.toFixed(4)}`);
    console.log(`  Summary: $${costSummary.toFixed(4)}`);
    console.log(`  Saved:   $${costSaved.toFixed(4)} per pass`);
  }
}
