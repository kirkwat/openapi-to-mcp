import path from 'node:path';

import {
  Client,
  StreamableHTTPClientTransport,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/openapi.yaml');
const ITEM_ID = '3f2b1c9e-8a4d-4e6f-9b1a-2c3d4e5f6a7b';

// Mock target API; the MCP client calls handleRequest directly, not fetch.
const upstream = vi.fn<typeof fetch>();

let clients: Client[] = [];

beforeEach(() => {
  vi.stubEnv('OPENAPI_SPEC_URL', FIXTURE_PATH);
  vi.stubGlobal('fetch', upstream);
  upstream.mockReset();
  upstream.mockImplementation(async () => Response.json({ ok: true }));
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  vi.doUnmock('../src/openapi-parser.js');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function connect(versionNegotiation?: VersionNegotiationOptions) {
  const { handleRequest } = await import('../api/server.js');
  const transport = new StreamableHTTPClientTransport(
    new URL('http://localhost'),
    {
      fetch: (url, init) => handleRequest(new Request(url, init)),
      requestInit: {
        headers: { Authorization: 'Bearer tok123', 'Mcp-Api-Key': 'k1' },
      },
    },
  );
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { versionNegotiation },
  );
  clients.push(client);
  await client.connect(transport);
  return client;
}

const textContent = z.tuple([
  z.object({ type: z.literal('text'), text: z.string() }),
]);

function parseText(content: unknown) {
  return JSON.parse(textContent.parse(content)[0].text);
}

describe('handleRequest', () => {
  it('answers preflight, echoing the requested headers', async () => {
    const { OPTIONS } = await import('../api/server.js');

    const preflight = await OPTIONS(
      new Request('http://localhost', {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Headers': 'authorization' },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe(
      'authorization',
    );
  });

  it('adds CORS headers to MCP responses and rejects GET', async () => {
    const { GET } = await import('../api/server.js');

    const res = await GET(new Request('http://localhost'));
    expect(res.status).toBe(405);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('loads the spec once for concurrent cold-start requests', async () => {
    const parse = vi.fn();
    vi.doMock('../src/openapi-parser.js', async (importOriginal) => {
      const mod =
        await importOriginal<typeof import('../src/openapi-parser.js')>();
      parse.mockImplementation(mod.parseOpenAPISpec);
      return { parseOpenAPISpec: parse };
    });

    const [a, b] = await Promise.all([connect(), connect()]);
    await Promise.all([a.listTools(), b.listTools()]);

    expect(parse).toHaveBeenCalledOnce();
  });

  it('skips a tool whose input schema fails to compile', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tool = {
      description: '',
      method: 'GET',
      path: '/x',
      paramSources: [],
      annotations: {},
    };
    vi.doMock('../src/openapi-parser.js', () => ({
      parseOpenAPISpec: async () => ({
        spec: {
          info: { title: 'Mock', version: '1.0.0' },
          servers: [{ url: 'https://api.test.com' }],
        },
        tools: [
          { ...tool, name: 'good', inputSchema: { type: 'object' } },
          {
            ...tool,
            name: 'bad',
            inputSchema: {
              type: 'object',
              properties: { slug: { type: 'string', pattern: '^[\\w-.]+$' } },
            },
          },
        ],
      }),
    }));

    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['good']);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('bad'),
      expect.anything(),
    );
  });
});

describe.each([
  { era: 'modern', versionNegotiation: { mode: 'auto' as const } },
  { era: 'legacy', versionNegotiation: undefined },
])('$era era', ({ era, versionNegotiation }) => {
  it('negotiates the expected protocol era', async () => {
    const client = await connect(versionNegotiation);
    expect(client.getProtocolEra()).toBe(era);
  });

  it('lists the fixture tools with annotations', async () => {
    const client = await connect(versionNegotiation);
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['delete_item', 'list_items', 'update_item']),
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_items.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(byName.delete_item.annotations).toMatchObject({
      destructiveHint: true,
    });
    expect(byName.list_items.inputSchema.required).toEqual(['status']);
  });

  it('forwards path, body and client headers to the API', async () => {
    upstream.mockImplementationOnce(async () => Response.json({ id: ITEM_ID }));
    const client = await connect(versionNegotiation);

    const result = await client.callTool({
      name: 'update_item',
      arguments: { id: ITEM_ID, name: 'Widget', tags: ['a'] },
    });

    expect(result.isError).toBeFalsy();
    expect(parseText(result.content)).toEqual({ id: ITEM_ID });
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe(`https://api.test.com/items/${ITEM_ID}`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Widget',
      tags: ['a'],
    });

    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok123');
    expect(headers.get('Mcp-Api-Key')).toBe('k1');
    expect(headers.get('Content-Type')).toBe('application/json');
    for (const name of [
      'mcp-session-id',
      'mcp-protocol-version',
      'mcp-method',
      'mcp-name',
    ]) {
      expect(headers.has(name)).toBe(false);
    }
    expect([...headers.keys()].some((k) => k.startsWith('mcp-param-'))).toBe(
      false,
    );
  });

  it('rejects invalid arguments before calling the API', async () => {
    const client = await connect(versionNegotiation);

    const result = await client.callTool({
      name: 'list_items',
      arguments: { status: 'bogus' },
    });

    expect(result.isError).toBe(true);
    expect(textContent.parse(result.content)[0].text).toContain(
      'Input validation error',
    );
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('tools/call', () => {
  it('sends a non-object request body unwrapped', async () => {
    const client = await connect();
    await client.callTool({
      name: 'post_items_bulk',
      arguments: { body: [{ name: 'Widget' }] },
    });

    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://api.test.com/items/bulk');
    expect(JSON.parse(String(init?.body))).toEqual([{ name: 'Widget' }]);
  });

  it('forwards query params', async () => {
    const client = await connect();
    await client.callTool({
      name: 'list_items',
      arguments: { status: 'active', limit: 5 },
    });

    const [url, init] = upstream.mock.calls[0];
    const { searchParams } = new URL(String(url));
    expect(searchParams.get('status')).toBe('active');
    expect(searchParams.get('limit')).toBe('5');
    expect(init?.method).toBe('GET');
  });

  it('calls API_BASE_URL instead of the spec server when set', async () => {
    vi.stubEnv('API_BASE_URL', 'https://api.test.com/v1');
    const client = await connect();
    await client.callTool({ name: 'getItem', arguments: { id: ITEM_ID } });

    expect(upstream.mock.calls[0][0]).toBe(
      `https://api.test.com/v1/items/${ITEM_ID}`,
    );
  });

  it('returns isError when the API responds non-2xx', async () => {
    upstream.mockImplementationOnce(
      async () => new Response('Not Found', { status: 404 }),
    );
    const client = await connect();

    const result = await client.callTool({
      name: 'delete_item',
      arguments: { id: ITEM_ID },
    });

    expect(result.isError).toBe(true);
    expect(parseText(result.content)).toEqual({
      error: 'API returned 404: Not Found',
    });
  });
});
