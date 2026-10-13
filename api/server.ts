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

// Transport, protocol, browser and proxy headers never reach the target API.
const STRIPPED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'accept-encoding',
  'connection',
  'keep-alive',
  'expect',
  'upgrade',
  'te',
  'proxy-connection',
  'proxy-authorization',
  'http2-settings',
  'forwarded',
  'via',
  'origin',
  'referer',
  'cookie',
  'user-agent',
  'x-real-ip',
  // Cloudflare-injected; CF-Access-Client-* auth headers still pass.
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'cf-ew-via',
  'cdn-loop',
  'mcp-session-id',
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
]);
// Other mcp-* headers (e.g. a custom Mcp-Api-Key) still pass through.
const STRIPPED_PREFIXES = ['mcp-param-', 'x-forwarded-', 'x-vercel-', 'sec-'];

function extractClientHeaders(req: Request | undefined) {
  const headers = new Headers();
  for (const [key, value] of req?.headers ?? []) {
    if (
      !STRIPPED_HEADERS.has(key) &&
      !STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
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
            const text = await callApi(tool, {
              baseUrl: config.apiBaseUrl,
              headers: clientHeaders,
              args,
              maxChars: config.maxResponseChars,
            });
            // A 204 or empty body is no content, not an empty text block.
            return { content: text ? [{ type: 'text', text }] : [] };
          } catch (error) {
            const text =
              error instanceof Error ? error.message : 'Unknown error';
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
