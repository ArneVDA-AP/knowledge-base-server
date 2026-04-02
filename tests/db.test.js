import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
  initSchema,
  _setTestDb, _resetDb,
  insertDocument, searchDocuments, deleteDocument,
  getDocument, listDocuments,
} from '../src/db.js';

describe('document CRUD and search', () => {
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

  it('insertDocument returns correct shape', () => {
    const doc = insertDocument({ title: 'Hello World', content: 'Some content here.', doc_type: 'text' });
    assert.ok(typeof doc.id === 'number' || typeof doc.id === 'bigint');
    assert.strictEqual(doc.title, 'Hello World');
    assert.ok(typeof doc.content_hash === 'string' && doc.content_hash.length === 32);
  });

  it('insertDocument deduplicates by content hash', () => {
    const content = 'Unique content for dedup test ' + Date.now();
    const first = insertDocument({ title: 'Dedup A', content, doc_type: 'text' });
    const second = insertDocument({ title: 'Dedup B', content, doc_type: 'text' });
    assert.strictEqual(Number(first.id), Number(second.id), 'Same content should return same doc id');
  });

  it('getDocument returns correct document', () => {
    const inserted = insertDocument({ title: 'Fetch Me', content: 'Fetchable content.', doc_type: 'text' });
    const fetched = getDocument(Number(inserted.id));
    assert.ok(fetched !== null);
    assert.strictEqual(fetched.title, 'Fetch Me');
  });

  it('getDocument returns null for unknown id', () => {
    const result = getDocument(999999);
    assert.strictEqual(result, null);
  });

  it('listDocuments returns an array', () => {
    const results = listDocuments();
    assert.ok(Array.isArray(results));
  });

  it('searchDocuments finds inserted document by keyword', () => {
    const keyword = 'xyzuniquekeyword' + Date.now();
    insertDocument({ title: 'Searchable Doc', content: `Contains ${keyword} in its content.`, doc_type: 'text' });
    const results = searchDocuments(keyword);
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0, 'Should find the document by keyword');
    assert.ok(results.some(r => r.title === 'Searchable Doc'));
  });

  it('searchDocuments returns empty array for empty query', () => {
    const results = searchDocuments('');
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0);
  });

  it('searchDocuments does not crash on all-stopword query', () => {
    // All terms are stop words — should fall back to OR search without throwing
    const results = searchDocuments('the is a');
    assert.ok(Array.isArray(results));
  });

  it('deleteDocument removes doc and returns file_path', () => {
    const doc = insertDocument({ title: 'To Delete', content: 'Delete me content.', doc_type: 'text' });
    const filePath = deleteDocument(Number(doc.id));
    assert.strictEqual(filePath, null, 'file_path should be null for text-ingested docs');
    const fetched = getDocument(Number(doc.id));
    assert.strictEqual(fetched, null, 'Document should no longer exist');
  });
});

describe('vault_files schema', () => {
  let db;

  before(() => {
    db = new Database(':memory:');
    initSchema(db);
  });

  after(() => db.close());

  it('should create vault_files table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vault_files'"
    ).all();
    assert.strictEqual(tables.length, 1);
  });

  it('should track file path, hash, and frontmatter fields', () => {
    db.prepare(`
      INSERT INTO vault_files (vault_path, content_hash, title, note_type, tags, project, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('05_research/test.md', 'abc123', 'Test Note', 'research', 'ai,agents', 'kb-system', 'active');

    const row = db.prepare('SELECT * FROM vault_files WHERE vault_path = ?').get('05_research/test.md');
    assert.strictEqual(row.title, 'Test Note');
    assert.strictEqual(row.note_type, 'research');
    assert.strictEqual(row.project, 'kb-system');
  });
});
