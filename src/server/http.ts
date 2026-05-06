// HTTP application factory.
//
// Wires Express + the MCP HTTP-streaming transport behind /mcp + Context
// Protocol middleware (paid-tool gate). Pure factory: no listen() — the
// caller (main.ts in production, tests inline) decides how to bind.

import express, { type Express, type Request, type Response } from 'express';
import { createContextMiddleware } from '@ctxprotocol/sdk';
import { buildHttpTransportRegistry, type McpTransportRegistry } from './mcp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface BuildHttpAppOptions {
  buildServer: () => Server;
  /**
   * When true, mounts createContextMiddleware() on /mcp. REQUIRED for
   * paid tools per Context's docs. Default: read from
   * CONTEXT_MIDDLEWARE_ENABLED env var (defaults to true in production).
   */
  contextMiddlewareEnabled?: boolean;
}

export function buildHttpApp(opts: BuildHttpAppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Health endpoint — Railway probes this; never gated by Context middleware.
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, name: 'helm13f', version: '0.1.0' });
  });

  const ctxMiddlewareEnabled =
    opts.contextMiddlewareEnabled ?? process.env['CONTEXT_MIDDLEWARE_ENABLED'] !== 'false';

  const registry: McpTransportRegistry = buildHttpTransportRegistry(opts.buildServer);

  if (ctxMiddlewareEnabled) {
    // Note (calibration): _meta.surface uses 'both' across all 11 tools.
    // Context's docs are inconsistent on whether the Query mode is named
    // 'answer' or 'query' in the metadata; we follow the SDK example
    // servers and use 'both' to expose tools on both surfaces.
    //
    // The Context SDK ships its middleware typed against an older Express
    // RequestHandler shape; under Express 5 the param-type widening needs
    // an explicit cast.
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
    app.use('/mcp', createContextMiddleware() as any);
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
  }

  app.post('/mcp', (req, res) => void registry.handle(req, res));
  app.get('/mcp', (req, res) => void registry.handle(req, res));
  app.delete('/mcp', (req, res) => void registry.handle(req, res));

  return app;
}
