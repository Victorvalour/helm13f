// MCP server harness — wires the @modelcontextprotocol/sdk Server to our
// 11 tools (Phase 2 schemas) and the per-tool handlers (server/handlers).
//
// Calibration locks honoured here:
//   - Root /mcp route mounted on Express with createContextMiddleware()
//     when CONTEXT_MIDDLEWARE_ENABLED=true (paid-tool requirement).
//   - Tool definitions (input/output schemas + _meta) come from
//     src/server/schemas/index.ts — single source of truth.
//   - Every handler returns { content, structuredContent } per the
//     Context Data Broker Standard.
//
// Transport: HTTP-streaming (Streamable HTTP) per the official
// @modelcontextprotocol/sdk pattern. Stateful sessions keyed by
// Mcp-Session-Id.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { ALL_TOOLS } from './schemas/index.js';
import type { CallToolResult } from './handlers/index.js';

export interface BuildMcpServerOptions {
  serverName?: string;
  serverVersion?: string;
  handlers: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>>;
}

/**
 * Create a fresh MCP Server with our 11 tools registered. Each call to
 * tools/list returns the schema definitions from src/server/schemas; each
 * tools/call dispatches to the corresponding handler function.
 */
export function buildMcpServer(opts: BuildMcpServerOptions): Server {
  const server = new Server(
    {
      name: opts.serverName ?? 'helm13f',
      version: opts.serverVersion ?? '0.1.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return Promise.resolve({
      tools: ALL_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        // The Context runtime + the MCP TS SDK both accept the schema
        // object literally. The SDK widens to its own JSON-Schema subset.
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
        _meta: t._meta,
      })),
    });
  });

  // The MCP SDK's CallToolResult union now includes a managed-task variant
  // (added in 1.29). Our standard tool returns are content/structuredContent
  // shaped — the SDK's narrower union complains; the runtime contract is
  // satisfied. Suppress the type mismatch on this single call.
  // @ts-expect-error — return shape is the canonical MCP tools/call result.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const handler = opts.handlers[name];
    if (!handler) {
      // No structuredContent on errors — MCP validates it against the success
      // outputSchema and an error envelope always fails that check.
      return {
        content: [{ type: 'text', text: JSON.stringify({ errorCode: 'unknown_tool', name }) }],
        isError: true,
      };
    }
    try {
      return await handler(args);
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              errorCode: 'execution_failed',
              message: (err as Error).message,
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ------------------------------------------------------------
// HTTP transport (Streamable HTTP per MCP spec)
// ------------------------------------------------------------

import type { Request, Response } from 'express';

export interface McpTransportRegistry {
  /** Express handler for POST /mcp + GET /mcp + DELETE /mcp. */
  handle(req: Request, res: Response): Promise<void>;
}

/**
 * Build a per-server transport registry. Each MCP session is keyed by
 * the Mcp-Session-Id header; new sessions allocate a fresh transport
 * connected to a freshly-built MCP server. Per the SDK pattern.
 */
export function buildHttpTransportRegistry(buildServer: () => Server): McpTransportRegistry {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  return {
    async handle(req, res): Promise<void> {
      const sessionId = req.headers['mcp-session-id'];
      const sid = typeof sessionId === 'string' ? sessionId : undefined;

      if (sid && transports.has(sid)) {
        const transport = transports.get(sid)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // New session.
      if (req.method === 'POST') {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId: string) => {
            transports.set(newId, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        const server = buildServer();
        // SDK's Transport interface tightened onclose to non-optional in
        // recent releases; the concrete StreamableHTTPServerTransport still
        // declares it optional. Cast through unknown to bridge.
        await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32_000, message: 'No active session for non-POST request' },
        id: null,
      });
    },
  };
}
