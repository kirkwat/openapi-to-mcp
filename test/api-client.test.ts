import { beforeEach, describe, expect, it, vi } from 'vitest';

import { callApi, type ParamSource } from '../src/api-client.js';

function call(
  {
    method = 'GET',
    path = '/',
    paramSources = [],
    bodyContentType = undefined as string | undefined,
    idempotentHint = false,
  }: {
    method?: string;
    path?: string;
    paramSources?: ParamSource[];
    bodyContentType?: string;
    idempotentHint?: boolean;
  },
  args: Record<string, unknown> = {},
  { baseUrl = 'http://x', maxChars = 0, headers = new Headers() } = {},
) {
  return callApi(
    {
      method,
      path,
      paramSources,
      bodyContentType,
      annotations: { idempotentHint },
    },
    { baseUrl, headers, args, maxChars },
  );
}

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => Response.json({}));
  vi.stubGlobal('fetch', mockFetch);
});

function respondWith(body: string, init?: ResponseInit) {
  mockFetch.mockImplementationOnce(async () => new Response(body, init));
}

const itemPath = {
  path: '/items/{id}',
  paramSources: [{ name: 'id', in: 'path' as const }],
};

describe('callApi', () => {
  it('substitutes path params and encodes them', async () => {
    await call(itemPath, { id: 'hello world' });

    expect(mockFetch.mock.calls[0][0]).toBe('http://x/items/hello%20world');
  });

  it('throws on missing required path param', async () => {
    await expect(call(itemPath)).rejects.toThrow(
      'Missing required path parameter: id',
    );
  });

  it('refuses to send a placeholder the spec never names', async () => {
    await expect(
      call(
        {
          path: '/items/{id}',
          paramSources: [{ name: 'item_id', in: 'path' }],
        },
        { item_id: '7' },
      ),
    ).rejects.toThrow('has no parameter for {id}; the spec declares item_id');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('substitutes placeholders in the path only, never the base URL', async () => {
    await call(
      {
        path: '/tenants/{tenant}',
        paramSources: [{ name: 'tenant', in: 'path' }],
      },
      { tenant: 'acme' },
      { baseUrl: 'https://{tenant}.x' },
    );

    expect(mockFetch.mock.calls[0][0]).toBe('https://{tenant}.x/tenants/acme');
  });

  it('sends a rawBody param as the whole request body', async () => {
    await call(
      {
        method: 'POST',
        path: '/bulk',
        paramSources: [{ name: 'body', in: 'rawBody' }],
      },
      { body: [{ name: 'a' }] },
    );

    const init = mockFetch.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual([{ name: 'a' }]);
    expect(new Headers(init?.headers).get('Content-Type')).toBe(
      'application/json',
    );
  });

  it('keeps an object body property named "body" wrapped', async () => {
    await call({ method: 'POST' }, { body: 'hello' });

    const init = mockFetch.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({ body: 'hello' });
  });

  it('does not send body for GET requests', async () => {
    await call({}, { extra: 'x' });

    expect(mockFetch.mock.calls[0][1]?.body).toBeUndefined();
  });

  it('asks the API for JSON', async () => {
    await call({}, {}, { headers: new Headers({ Accept: 'text/html' }) });

    const init = mockFetch.mock.calls[0][1];
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
  });

  it('sends the body with its declared media type', async () => {
    await call(
      { method: 'PATCH', bodyContentType: 'application/merge-patch+json' },
      { name: 'n' },
    );

    const init = mockFetch.mock.calls[0][1];
    expect(new Headers(init?.headers).get('Content-Type')).toBe(
      'application/merge-patch+json',
    );
  });

  describe('query values', () => {
    const query = (value: unknown) =>
      call({ paramSources: [{ name: 'tag', in: 'query' }] }, { tag: value });

    it('omits null values and null elements', async () => {
      await query(null);
      expect(new URL(String(mockFetch.mock.calls[0][0])).search).toBe('');

      await query(['a', null]);
      expect(String(mockFetch.mock.calls[1][0])).toBe('http://x/?tag=a');
    });

    it('repeats the name for each array element', async () => {
      await query(['a', 'b']);

      expect(mockFetch.mock.calls[0][0]).toBe('http://x/?tag=a&tag=b');
    });

    it('JSON-encodes an object', async () => {
      await query({ a: 1 });

      const url = new URL(String(mockFetch.mock.calls[0][0]));
      expect(url.searchParams.get('tag')).toBe('{"a":1}');
    });

    it('stringifies a scalar', async () => {
      await query(5);

      expect(mockFetch.mock.calls[0][0]).toBe('http://x/?tag=5');
    });
  });
});

describe('response truncation', () => {
  const listOperation = {
    path: '/items',
    paramSources: [
      { name: 'status', in: 'query' as const },
      { name: 'limit', in: 'query' as const },
      { name: 'org', in: 'path' as const },
    ],
  };
  const records = Array.from({ length: 50 }, (_, id) => ({
    id,
    name: `item-${id}`,
  }));

  it('leaves a body under the limit untouched', async () => {
    const body = JSON.stringify(records, null, 2);
    respondWith(body);

    await expect(
      call(listOperation, { org: 'o' }, { maxChars: body.length }),
    ).resolves.toBe(body);
  });

  it('returns a pretty-printed body compact when that fits', async () => {
    const page = { page: { number: 1, size: 50 }, owner: { id: 7 } };
    respondWith(JSON.stringify(page, null, 2));
    const compact = JSON.stringify(page);

    await expect(call({}, {}, { maxChars: compact.length })).resolves.toBe(
      compact,
    );
  });

  it('drops array elements from the end and reports counts', async () => {
    respondWith(JSON.stringify(records));
    const maxChars = 300;

    const text = await call(listOperation, { org: 'o' }, { maxChars });

    const [json, trailer] = text.split('\n');
    const kept: unknown[] = JSON.parse(json);
    expect(json.length).toBeLessThanOrEqual(maxChars);
    // One more element would not have fit.
    expect(
      JSON.stringify(records.slice(0, kept.length + 1)).length,
    ).toBeGreaterThan(maxChars);
    expect(kept).toEqual(records.slice(0, kept.length));
    expect(trailer).toBe(
      `Truncated: showing ${kept.length} of 50 items (300 char limit). Narrow with: status, limit`,
    );
  });

  it('trims the largest array field and keeps the rest', async () => {
    respondWith(JSON.stringify({ meta: [], records, page: 1 }));

    const text = await call(listOperation, { org: 'o' }, { maxChars: 400 });

    const [json, trailer] = text.split('\n');
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed)).toEqual(['meta', 'records', 'page']);
    expect(parsed.records).toEqual(records.slice(0, parsed.records.length));
    expect(trailer).toContain(`showing ${parsed.records.length} of 50 records`);
  });

  it('still trims lists when long digit runs are inside strings', async () => {
    const rows = Array.from({ length: 50 }, () => ({
      phone: '+28148187701113002',
    }));
    respondWith(JSON.stringify(rows));

    const text = await call({}, {}, { maxChars: 300 });

    expect(text).toContain('Truncated: showing');
    expect(text).not.toContain('characters');
    expect(JSON.parse(text.split('\n')[0])[0].phone).toBe('+28148187701113002');
  });

  it('cuts as text when trimming would round a 64-bit integer', async () => {
    respondWith(`[${Array(50).fill('{"id":9007199254740993}').join(',')}]`);

    const text = await call({}, {}, { maxChars: 100 });

    expect(text).toContain('9007199254740993');
    expect(text).not.toContain('9007199254740992');
    expect(text).toContain('Truncated: showing 100 of');
  });

  it('cuts as text instead of showing an empty list', async () => {
    respondWith(JSON.stringify([{ s: 'x'.repeat(1000) }]));

    const text = await call({}, {}, { maxChars: 100 });

    expect(text).not.toContain('showing 0 of');
    expect(text).toContain('showing 100 of');
  });

  it('hard-truncates a non-JSON body', async () => {
    respondWith('x'.repeat(1000));

    const text = await call({}, {}, { maxChars: 100 });

    expect(text).toBe(
      `${'x'.repeat(100)}\nTruncated: showing 100 of 1000 characters (100 char limit).`,
    );
  });

  it('returns the body byte-for-byte when the limit is 0', async () => {
    const body = `${JSON.stringify(records, null, 2)}\n`;
    respondWith(body);

    await expect(call(listOperation, { org: 'o' })).resolves.toBe(body);
  });

  it('does not apply the response cap to error bodies', async () => {
    respondWith('e'.repeat(500), { status: 500 });

    await expect(call({}, {}, { maxChars: 10 })).rejects.toThrow(
      'e'.repeat(500),
    );
  });
});

describe('upstream errors', () => {
  async function errorFor(
    status: number,
    { statusText = '', idempotentHint = false, body = 'boom' } = {},
  ) {
    respondWith(body, { status, statusText });
    const error = await call(
      { ...itemPath, method: 'DELETE', idempotentHint },
      { id: 'a b' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    return String(error instanceof Error && error.message);
  }

  it('starts with the status line and body', async () => {
    expect(await errorFor(409, { statusText: 'Conflict' })).toBe(
      'Upstream returned 409 Conflict: boom',
    );
  });

  it.each([
    [401, 'Check the headers'],
    [403, 'Check the headers'],
    [404, 'No resource at DELETE /items/a%20b'],
    [429, 'Wait before retrying'],
  ])('adds guidance on %i', async (status, phrase) => {
    expect(await errorFor(status)).toContain(phrase);
  });

  it('suggests a retry on 5xx only for idempotent operations', async () => {
    expect(await errorFor(503, { idempotentHint: true })).toContain(
      'Retrying once',
    );
    expect(await errorFor(503)).toMatch(/\nThe API failed\.$/);
  });

  it('caps the error body at 2000 characters', async () => {
    const message = await errorFor(500, { body: 'e'.repeat(5000) });

    expect(message).toContain(`: ${'e'.repeat(2000)}...\n`);
    expect(message).not.toContain('e'.repeat(2001));
  });

  it('reports network failures with the host', async () => {
    mockFetch.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(
      call({}, {}, { baseUrl: 'https://api.test.com:8443/v1' }),
    ).rejects.toThrow('Could not reach api.test.com:8443: fetch failed');
  });
});
