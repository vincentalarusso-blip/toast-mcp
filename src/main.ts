#!/usr/bin/env node

import { ToastMCPServer } from './server.js';

/**
 * Toast MCP Server Entry Point
 * Supports both stdio and HTTP modes
 */

interface Config {
  clientId?: string;
  clientSecret?: string;
  restaurantGuid?: string;
  environment?: 'production' | 'sandbox';
  mode?: 'stdio' | 'http';
  port?: number;
}

function loadConfig(): Config {
  const config: Config = {
    mode: (process.env.TOAST_MCP_MODE as 'stdio' | 'http') || 'stdio',
    port: parseInt(process.env.TOAST_MCP_PORT || process.env.PORT || '3000'),
  };

  // Load from environment variables
  config.clientId = process.env.TOAST_CLIENT_ID;
  config.clientSecret = process.env.TOAST_CLIENT_SECRET;
  config.restaurantGuid = process.env.TOAST_RESTAURANT_GUID;
  config.environment = (process.env.TOAST_ENVIRONMENT as 'production' | 'sandbox') || 'production';

  // Validate required fields
  if (!config.clientId) {
    console.error('Error: TOAST_CLIENT_ID environment variable is required');
    process.exit(1);
  }

  if (!config.clientSecret) {
    console.error('Error: TOAST_CLIENT_SECRET environment variable is required');
    process.exit(1);
  }

  return config;
}

async function main() {
  const config = loadConfig();

  console.error('[Toast MCP] Starting server...');
  console.error(`[Toast MCP] Mode: ${config.mode}`);
  console.error(`[Toast MCP] Environment: ${config.environment}`);
  if (config.restaurantGuid) {
    console.error(`[Toast MCP] Restaurant GUID: ${config.restaurantGuid}`);
  }

  try {
    if (config.mode === 'stdio') {
      // Stdio mode - standard MCP server
      const server = new ToastMCPServer({
        clientId: config.clientId!,
        clientSecret: config.clientSecret!,
        restaurantGuid: config.restaurantGuid,
        environment: config.environment,
      });

      await server.run();
    } else if (config.mode === 'http') {
      // HTTP mode - remote MCP server (streamable HTTP transport, stateless)
      const express = await import('express');
      const { StreamableHTTPServerTransport } = await import(
        '@modelcontextprotocol/sdk/server/streamableHttp.js'
      );
      const app = express.default();
      app.use(express.json({ limit: '4mb' }));

      // Auth: requests must carry the shared secret, either as a URL path
      // prefix (/<secret>/mcp — for clients that cannot send custom headers)
      // or as an Authorization: Bearer header on /mcp.
      const secret = process.env.TOAST_MCP_SECRET;
      if (!secret || secret.length < 16) {
        console.error(
          'Error: TOAST_MCP_SECRET (min 16 chars) is required in http mode. ' +
            'Generate one with: node -e "console.log(crypto.randomUUID().replaceAll(\'-\',\'\'))"'
        );
        process.exit(1);
      }

      // One shared Toast client so the API auth token is fetched once, not per request.
      const sharedClient = new ToastMCPServer({
        clientId: config.clientId!,
        clientSecret: config.clientSecret!,
        restaurantGuid: config.restaurantGuid,
        environment: config.environment,
      }).getClient();

      // F&B dashboard sync: backfills and refreshes Toast sales on a schedule
      // and serves them at /dashboard/* (see src/tools/dashboard.ts).
      const { startDashboardSync, mountDashboardRoutes } = await import('./tools/dashboard.js');
      startDashboardSync(sharedClient);
      mountDashboardRoutes(app);

      const handleMcp = async (req: any, res: any) => {
        try {
          // Stateless: fresh server + transport per request, shared Toast client.
          const server = new ToastMCPServer({
            clientId: config.clientId!,
            clientSecret: config.clientSecret!,
            restaurantGuid: config.restaurantGuid,
            environment: config.environment,
            client: sharedClient,
          });
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          res.on('close', () => {
            transport.close();
            server.close();
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (error: any) {
          console.error('[Toast MCP] Request error:', error?.message || error);
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            });
          }
        }
      };

      const bearerOk = (req: any) =>
        req.headers.authorization === `Bearer ${secret}`;

      app.post(`/${secret}/mcp`, handleMcp);
      app.post('/mcp', (req, res) => {
        if (!bearerOk(req)) {
          res.status(401).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized' },
            id: null,
          });
          return;
        }
        void handleMcp(req, res);
      });
      // Stateless transport: no server-initiated streams or sessions.
      const reject = (_req: any, res: any) =>
        res.status(405).set('Allow', 'POST').send('Method Not Allowed');
      app.get(['/mcp', `/${secret}/mcp`], reject);
      app.delete(['/mcp', `/${secret}/mcp`], reject);

      // Health check (no secret required, reveals nothing sensitive)
      app.get('/health', (_req, res) => {
        res.json({ status: 'ok', service: 'toast-mcp-server', version: '1.4.0' });
      });

      const port = config.port || 3000;
      app.listen(port, () => {
        console.error(`[Toast MCP] Remote MCP server listening on port ${port}`);
        console.error(`[Toast MCP] Endpoint: /<secret>/mcp or /mcp with Authorization: Bearer <secret>`);
      });
    }
  } catch (error) {
    console.error('[Toast MCP] Fatal error:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('[Toast MCP] Unhandled error:', error);
  process.exit(1);
});
