// tests/v1.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { createApiKeyMiddleware } from '../src/middleware/api-key.js';
import v1Router from '../src/routes/v1.js';

process.env.KB_API_KEY_CLAUDE = 'test-key-123';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createApiKeyMiddleware(), v1Router);
  return app;
}

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const AUTH = { 'X-API-Key': 'test-key-123', 'Content-Type': 'application/json' };

describe('v1 API', () => {
  it('GET /api/v1/health returns ok', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/health`, {
        headers: { 'X-API-Key': 'test-key-123' },
      });
      const data = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.status, 'ok');
      assert.ok(typeof data.uptime === 'number', 'uptime should be a number');
    });
  });

  it('GET /api/v1/stats returns total_documents', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/stats`, {
        headers: { 'X-API-Key': 'test-key-123' },
      });
      const data = await res.json();
      assert.strictEqual(res.status, 200);
      assert.ok('total_documents' in data, 'response should have total_documents');
      assert.ok('total_size_bytes' in data, 'response should have total_size_bytes');
      assert.ok('db_size_bytes' in data, 'response should have db_size_bytes');
    });
  });

  it('GET /api/v1/search requires q param (400)', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/search`, {
        headers: { 'X-API-Key': 'test-key-123' },
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error, 'should have error message');
    });
  });

  it('GET /api/v1/search returns results array', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/search?q=test`, {
        headers: { 'X-API-Key': 'test-key-123' },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.results), 'results should be an array');
    });
  });

  it('GET /api/v1/search/smart requires q param (400)', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/search/smart`, {
        headers: { 'X-API-Key': 'test-key-123' },
      });
      assert.strictEqual(res.status, 400);
    });
  });

  it('GET /api/v1/context requires q param (400)', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/context`, {
        headers: { 'X-API-Key': 'test-key-123' },
      });
      assert.strictEqual(res.status, 400);
    });
  });

  it('GET /api/v1/documents returns documents array', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/documents`, {
        headers: { 'X-API-Key': 'test-key-123' },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.documents), 'documents should be an array');
      assert.ok(typeof data.total === 'number', 'total should be a number');
    });
  });

  it('GET /api/v1/documents/:id returns 404 for unknown id', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/documents/999999`, {
        headers: { 'X-API-Key': 'test-key-123' },
      });
      assert.strictEqual(res.status, 404);
    });
  });

  it('POST /api/v1/ingest creates document (201)', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/ingest`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          title: 'Test Document',
          content: 'This is test content for the v1 API integration test.',
          tags: 'test,integration',
        }),
      });
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.ok(data.id, 'response should have id');
      assert.strictEqual(data.title, 'Test Document');
      assert.ok(data.created_at, 'response should have created_at');
    });
  });

  it('POST /api/v1/ingest returns 400 if missing title or content', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/ingest`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'No Content' }),
      });
      assert.strictEqual(res.status, 400);
    });
  });

  it('GET /api/v1/documents/:id returns created document', async () => {
    await withServer(async (port) => {
      // First ingest
      const ingestRes = await fetch(`http://localhost:${port}/api/v1/ingest`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          title: 'Fetch By ID Test',
          content: 'Content to verify fetch by ID.',
        }),
      });
      const { id } = await ingestRes.json();

      // Then fetch by ID
      const getRes = await fetch(`http://localhost:${port}/api/v1/documents/${id}`, {
        headers: { 'X-API-Key': 'test-key-123' },
      });
      assert.strictEqual(getRes.status, 200);
      const doc = await getRes.json();
      assert.strictEqual(doc.id, id);
      assert.strictEqual(doc.title, 'Fetch By ID Test');
    });
  });

  it('rejects request without API key (401)', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/health`);
      assert.strictEqual(res.status, 401);
    });
  });

  it('rejects request with invalid API key (403)', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/health`, {
        headers: { 'X-API-Key': 'wrong-key' },
      });
      assert.strictEqual(res.status, 403);
    });
  });

  it('DELETE /api/v1/documents/:id deletes a document (200)', async () => {
    await withServer(async (port) => {
      // Create a document first
      const ingestRes = await fetch(`http://localhost:${port}/api/v1/ingest`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Delete Me', content: 'Content to be deleted via API.' }),
      });
      assert.strictEqual(ingestRes.status, 201);
      const { id } = await ingestRes.json();

      // Delete it
      const delRes = await fetch(`http://localhost:${port}/api/v1/documents/${id}`, {
        method: 'DELETE',
        headers: { 'X-API-Key': 'test-key-123' },
      });
      assert.strictEqual(delRes.status, 200);
      const data = await delRes.json();
      assert.strictEqual(data.deleted, true);
      assert.strictEqual(data.id, id);

      // Verify it's gone
      const getRes = await fetch(`http://localhost:${port}/api/v1/documents/${id}`, {
        headers: { 'X-API-Key': 'test-key-123' },
      });
      assert.strictEqual(getRes.status, 404);
    });
  });

  it('DELETE /api/v1/documents/:id returns 404 for unknown id', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/v1/documents/999999`, {
        method: 'DELETE',
        headers: { 'X-API-Key': 'test-key-123' },
      });
      assert.strictEqual(res.status, 404);
    });
  });

  it('POST /api/v1/ingest deduplicates identical content', async () => {
    await withServer(async (port) => {
      const unique = `Dedup test content ${Date.now()} ${Math.random()}`;
      const body = JSON.stringify({ title: 'Dedup Test', content: unique });

      const first = await fetch(`http://localhost:${port}/api/v1/ingest`, {
        method: 'POST', headers: AUTH, body,
      });
      const second = await fetch(`http://localhost:${port}/api/v1/ingest`, {
        method: 'POST', headers: AUTH, body,
      });

      const d1 = await first.json();
      const d2 = await second.json();
      assert.strictEqual(d1.id, d2.id, 'Duplicate content should return same document id');
    });
  });

  it('GET /api/v1/search finds a freshly ingested document', async () => {
    await withServer(async (port) => {
      const keyword = `searchable${Date.now()}`;
      await fetch(`http://localhost:${port}/api/v1/ingest`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Search Target', content: `Contains the keyword ${keyword}.` }),
      });

      const res = await fetch(`http://localhost:${port}/api/v1/search?q=${keyword}`, {
        headers: { 'X-API-Key': 'test-key-123' },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.results));
      assert.ok(data.results.length > 0, 'Should find the ingested document');
      assert.ok(data.results.some(r => r.title === 'Search Target'));
    });
  });
});
