import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initSchema, _setTestDb, _resetDb, insertDocument } from '../src/db.js';
import { tokenCompare } from '../src/cli/token-compare.js';

describe('token-compare', () => {
  let testDb;

  before(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
    _setTestDb(testDb);
  });

  after(() => {
    testDb.close();
    _resetDb();
  });

  it('prints "no summaries" message when none exist', () => {
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      tokenCompare([]);
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.some(l => l.includes('No documents with summaries')));
  });

  it('shows token comparison when summaries exist', () => {
    // Insert a document
    const doc = insertDocument({
      title: 'Long Article',
      content: 'A'.repeat(4000), // ~1000 tokens
      doc_type: 'text',
    });

    // Link it with a summary via vault_files
    testDb.prepare(`
      INSERT INTO vault_files (vault_path, content_hash, document_id, title, summary, key_topics)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('test/long-article.md', 'abc123', Number(doc.id), 'Long Article', 'A short summary.', '["testing"]');

    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      tokenCompare([]);
    } finally {
      console.log = origLog;
    }

    const output = lines.join('\n');
    assert.ok(output.includes('Token Comparison'), 'Should show header');
    assert.ok(output.includes('Long Article'), 'Should list the document');
    assert.ok(output.includes('Tokens saved'), 'Should show savings');
    assert.ok(output.includes('1/1'), 'Should show 1/1 docs with summaries');
  });
});
