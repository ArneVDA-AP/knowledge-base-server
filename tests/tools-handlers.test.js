import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initSchema, _setTestDb, _resetDb } from '../src/db.js';
import { getToolDefinitions } from '../src/tools.js';

function getTool(name) {
  return getToolDefinitions().find(t => t.name === name);
}

describe('tool handlers (DB-only, in-memory)', () => {
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

  it('kb_list returns an array', async () => {
    const tool = getTool('kb_list');
    const result = await tool.handler({});
    assert.ok(!result.isError, 'should not be an error');
    const data = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(data), 'kb_list should return an array');
  });

  it('kb_ingest creates a document', async () => {
    const tool = getTool('kb_ingest');
    const result = await tool.handler({ title: 'Test Ingest', content: 'Handler ingest test content.' });
    assert.ok(!result.isError, `should not be an error: ${result.content[0].text}`);
    const doc = JSON.parse(result.content[0].text);
    assert.ok(doc.id, 'response should have an id');
    assert.strictEqual(doc.title, 'Test Ingest');
  });

  it('kb_search finds an ingested document', async () => {
    const keyword = `handlerkeyword${Date.now()}`;
    // Ingest first
    const ingestTool = getTool('kb_ingest');
    await ingestTool.handler({ title: 'Handler Search Target', content: `Contains ${keyword} for handler test.` });

    // Then search
    const searchTool = getTool('kb_search');
    const result = await searchTool.handler({ query: keyword, limit: 10 });
    assert.ok(!result.isError, 'search should not error');
    const results = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(results), 'search result should be an array');
    assert.ok(results.length > 0, 'should find the ingested document');
    assert.ok(results.some(r => r.title === 'Handler Search Target'));
  });

  it('kb_read returns correct document by id', async () => {
    // Ingest a doc and get its id
    const ingestTool = getTool('kb_ingest');
    const ingestResult = await ingestTool.handler({ title: 'Read Me Handler', content: 'Content to read by id.' });
    const inserted = JSON.parse(ingestResult.content[0].text);

    const readTool = getTool('kb_read');
    const result = await readTool.handler({ id: Number(inserted.id) });
    assert.ok(!result.isError, 'kb_read should not error for existing doc');
    const doc = JSON.parse(result.content[0].text);
    assert.strictEqual(doc.title, 'Read Me Handler');
  });

  it('kb_read returns error for unknown id', async () => {
    const readTool = getTool('kb_read');
    const result = await readTool.handler({ id: 999999 });
    assert.ok(result.isError, 'kb_read should return isError for unknown id');
    assert.ok(result.content[0].text.includes('not found'), 'error message should mention not found');
  });

  it('kb_delete removes a document', async () => {
    // Ingest a doc to delete
    const ingestTool = getTool('kb_ingest');
    const ingestResult = await ingestTool.handler({ title: 'Delete Me Handler', content: 'To be deleted via handler.' });
    const inserted = JSON.parse(ingestResult.content[0].text);

    const deleteTool = getTool('kb_delete');
    const result = await deleteTool.handler({ id: Number(inserted.id) });
    assert.ok(!result.isError, 'kb_delete should not error for existing doc');
    const data = JSON.parse(result.content[0].text);
    assert.strictEqual(data.deleted, true);

    // Verify gone via kb_read
    const readTool = getTool('kb_read');
    const readResult = await readTool.handler({ id: Number(inserted.id) });
    assert.ok(readResult.isError, 'kb_read should error after deletion');
  });

  it('kb_delete returns error for unknown id', async () => {
    const deleteTool = getTool('kb_delete');
    const result = await deleteTool.handler({ id: 999999 });
    assert.ok(result.isError, 'kb_delete should return isError for unknown id');
  });
});
