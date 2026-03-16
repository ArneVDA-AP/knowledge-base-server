import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getHttpToolDefinitions } from './tools.js';

/**
 * Create a fresh MCP server instance with all HTTP-safe tools registered.
 * A new instance is created per session to keep state isolated.
 */
function createMcpServer() {
  const server = new McpServer({
    name: 'knowledge-base-brain',
    version: '1.0.0',
  });

  for (const tool of getHttpToolDefinitions()) {
    server.tool(tool.name, tool.description, tool.schema, tool.handler);
  }

  return server;
}

/**
 * Session store: maps session ID -> { server, transport }
 * Sessions are cleaned up when the transport closes.
 */
const sessions = new Map();

/**
 * Handle POST /mcp — all MCP protocol operations (initialize, tools/list, tools/call, etc.)
 *
 * Session lifecycle:
 * - First request (no Mcp-Session-Id header): creates a new server+transport pair,
 *   the transport auto-generates a session ID and includes it in the response header.
 * - Subsequent requests: looks up the existing transport by session ID and reuses it.
 */
export async function mcpHttpHandler(req, res) {
  const sessionId = req.headers['mcp-session-id'];

  let transport;

  if (sessionId && sessions.has(sessionId)) {
    // Existing session — reuse transport
    transport = sessions.get(sessionId).transport;
  } else if (!sessionId) {
    // New session — create server + transport
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = createMcpServer();

    // Clean up when transport closes
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
      }
    };

    // Connect server to transport (starts the transport internally)
    await server.connect(transport);

    // Store after connect so sessionId is populated
    const sid = transport.sessionId;
    if (sid) {
      sessions.set(sid, { server, transport });
    }
  } else {
    // Unknown session ID
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: `Session not found: ${sessionId}` },
      id: null,
    });
    return;
  }

  // Delegate to the transport — it handles parsing, routing, and response writing.
  // Pass req.body (already parsed by express.json()) as parsedBody.
  await transport.handleRequest(req, res, req.body);
}

/**
 * Handle GET /mcp — server metadata / discovery endpoint.
 * Also delegates to the transport for SSE stream support (server-initiated messages).
 * For plain GET without an existing session this returns metadata as JSON.
 */
export async function mcpGetHandler(req, res) {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && sessions.has(sessionId)) {
    // Existing session GET — let transport handle it (SSE stream, etc.)
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  // No session — return discovery metadata
  res.json({
    name: 'knowledge-base-brain',
    version: '1.0.0',
    capabilities: { tools: {} },
    toolCount: getHttpToolDefinitions().length,
  });
}
