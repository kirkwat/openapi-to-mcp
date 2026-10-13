import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from '@modelcontextprotocol/server';

import { callApi } from '../src/api-client.js';
import { resolveConfig } from '../src/config.js';
import { parseOpenAPISpec } from '../src/openapi-parser.js';

// Cached promise: concurrent cold requests share one load; cleared on failure.
let toolsPromise: ReturnType<typeof loadTools> | undefined;

async function loadTools() {
  const { tools, spec } = await parseOpenAPISpec();
  return {
    config: resolveConfig(spec),
    tools: tools.flatMap((tool) => {
      try {
        const inputSchema = fromJsonSchema<Record<string, unknown>>(
          tool.inputSchema,
        );
        return [{ tool, inputSchema }];
      } catch (error) {
        console.error(
          `Skipping tool ${tool.name}: invalid input schema`,
          error,
        );
        return [];
      }
    }),
  };
}

function getTools() {
  toolsPromise ??= loadTools().catch((error: unknown) => {
    toolsPromise = undefined;
    throw error;
  });
  return toolsPromise;
}

// Transport and MCP protocol headers never reach the target API.
const STRIPPED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'accept-encoding',
  'connection',
  'keep-alive',
  'mcp-session-id',
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
]);

function extractClientHeaders(req: Request | undefined) {
  const headers = new Headers();
  for (const [key, value] of req?.headers ?? []) {
    if (!STRIPPED_HEADERS.has(key) && !key.startsWith('mcp-param-')) {
      headers.set(key, value);
    }
  }
  return headers;
}

const handler = createMcpHandler(
  async ({ requestInfo }) => {
    const { config, tools } = await getTools();
    const clientHeaders = extractClientHeaders(requestInfo);
    const server = new McpServer(
      { name: config.serverName, version: config.serverVersion },
      {
        capabilities: { tools: { listChanged: false } },
        cacheHints: {
          'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
        },
      },
    );

    for (const { tool, inputSchema } of tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema,
          annotations: tool.annotations,
        },
        async (args) => {
          try {
            const text = await callApi(
              tool.method,
              config.apiBaseUrl,
              tool.path,
              clientHeaders,
              args,
              tool.paramSources,
            );
            return { content: [{ type: 'text', text }] };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Unknown error';
            const text = JSON.stringify({ error: message });
            return { content: [{ type: 'text', text }], isError: true };
          }
        },
      );
    }

    return server;
  },
  { onerror: (error) => console.error(error) },
);

// The SDK sets no CORS headers and answers GET/DELETE with 405 (stateless).
export async function handleRequest(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        // `*` never covers Authorization, so echo what the browser asked for.
        'Access-Control-Allow-Headers':
          req.headers.get('Access-Control-Request-Headers') ?? '*',
        Vary: 'Access-Control-Request-Headers',
      },
    });
  }

  const res = await handler.fetch(req);
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export const POST = handleRequest;
export const GET = handleRequest;
export const DELETE = handleRequest;
export const OPTIONS = handleRequest;
