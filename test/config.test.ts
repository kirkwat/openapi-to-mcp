import { afterEach, describe, expect, it, vi } from 'vitest';

import { getEnv, resolveConfig } from '../src/config.js';

const spec = {
  openapi: '3.0.3',
  info: { title: 'Test API', version: '1.0.0' },
  servers: [{ url: 'https://api.test.com/' }],
  paths: {},
};

describe('config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('treats empty values as unset', () => {
    vi.stubEnv('OPENAPI_SPEC_URL', '/spec.yaml');
    vi.stubEnv('MCP_READ_ONLY', '');
    vi.stubEnv('MCP_MAX_RESPONSE_CHARS', ' ');

    expect(getEnv()).toMatchObject({
      MCP_READ_ONLY: false,
      MCP_MAX_RESPONSE_CHARS: 40000,
    });
    expect(resolveConfig(spec)).toEqual({
      apiBaseUrl: 'https://api.test.com',
      serverName: 'Test API',
      serverVersion: '1.0.0',
      maxResponseChars: 40000,
    });
  });

  it('reports a missing OPENAPI_SPEC_URL', () => {
    vi.stubEnv('OPENAPI_SPEC_URL', '');
    expect(() => getEnv()).toThrow('OPENAPI_SPEC_URL is required');
  });
});
