import { beforeEach, describe, expect, it, vi } from 'vitest';

import { callApi } from '../src/api-client.js';

describe('callApi', () => {
  const mockFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => Response.json({}));
    vi.stubGlobal('fetch', mockFetch);
  });

  it('substitutes path params and encodes them', async () => {
    await callApi(
      'GET',
      'http://x',
      '/items/{id}',
      new Headers(),
      { id: 'hello world' },
      [{ name: 'id', in: 'path' }],
    );

    expect(mockFetch.mock.calls[0][0]).toBe('http://x/items/hello%20world');
  });

  it('throws on missing required path param', async () => {
    await expect(
      callApi('GET', 'http://x', '/items/{id}', new Headers(), {}, [
        { name: 'id', in: 'path' },
      ]),
    ).rejects.toThrow('Missing required path parameter: id');
  });

  it('substitutes placeholders in the path only, never the base URL', async () => {
    await callApi(
      'GET',
      'https://{tenant}.x',
      '/tenants/{tenant}',
      new Headers(),
      { tenant: 'acme' },
      [{ name: 'tenant', in: 'path' }],
    );

    expect(mockFetch.mock.calls[0][0]).toBe('https://{tenant}.x/tenants/acme');
  });

  it('keeps the base URL path', async () => {
    await callApi(
      'GET',
      'https://api.test.com/v1',
      '/items/{id}',
      new Headers(),
      { id: '7' },
      [{ name: 'id', in: 'path' }],
    );

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/v1/items/7');
  });

  it('sends a rawBody param as the whole request body', async () => {
    await callApi(
      'POST',
      'http://x',
      '/bulk',
      new Headers(),
      { body: [{ name: 'a' }] },
      [{ name: 'body', in: 'rawBody' }],
    );

    const init = mockFetch.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual([{ name: 'a' }]);
    expect(new Headers(init?.headers).get('Content-Type')).toBe(
      'application/json',
    );
  });

  it('keeps an object body property named "body" wrapped', async () => {
    await callApi(
      'POST',
      'http://x',
      '/',
      new Headers(),
      { body: 'hello' },
      [],
    );

    const init = mockFetch.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({ body: 'hello' });
  });

  it('does not send body for GET requests', async () => {
    await callApi('GET', 'http://x', '/', new Headers(), { extra: 'x' }, []);

    expect(mockFetch.mock.calls[0][1]?.body).toBeUndefined();
  });

  it('returns the upstream body text unchanged', async () => {
    mockFetch.mockImplementationOnce(async () => new Response('{ "a": 1 }\n'));

    await expect(
      callApi('GET', 'http://x', '/', new Headers(), {}, []),
    ).resolves.toBe('{ "a": 1 }\n');
  });
});
