import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/openapi.yaml');
const XQUIK_FIXTURE_PATH = path.resolve(
  __dirname,
  'fixtures/xquik.openapi.yaml',
);

describe('parseOpenAPISpec', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAPI_SPEC_URL', FIXTURE_PATH);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadParser() {
    const mod = await import('../src/openapi-parser.js');
    return mod.parseOpenAPISpec;
  }

  it('generates tools from the fixture spec', async () => {
    const parseOpenAPISpec = await loadParser();
    const { tools, spec } = await parseOpenAPISpec();

    expect(tools).toHaveLength(3);
    expect(spec.info.title).toBe('Test API');
  });

  it('generates correct tool names', async () => {
    const parseOpenAPISpec = await loadParser();
    const { tools } = await parseOpenAPISpec();

    const names = tools.map((t) => t.name);
    expect(names).toContain('list_items');
    expect(names).toContain('update_item');
    expect(names).toContain('delete_item');
  });

  it('assigns correct HTTP methods and paths', async () => {
    const parseOpenAPISpec = await loadParser();
    const { tools } = await parseOpenAPISpec();

    const listItems = tools.find((t) => t.name === 'list_items')!;
    expect(listItems.method).toBe('GET');
    expect(listItems.path).toBe('/items');

    const updateItem = tools.find((t) => t.name === 'update_item')!;
    expect(updateItem.method).toBe('POST');
    expect(updateItem.path).toBe('/items/{id}');
  });

  it('tracks param sources correctly', async () => {
    const parseOpenAPISpec = await loadParser();
    const { tools } = await parseOpenAPISpec();

    const listItems = tools.find((t) => t.name === 'list_items')!;
    expect(listItems.paramSources).toContainEqual({
      name: 'limit',
      in: 'query',
    });
    expect(listItems.paramSources).toContainEqual({
      name: 'status',
      in: 'query',
    });

    const updateItem = tools.find((t) => t.name === 'update_item')!;
    expect(updateItem.paramSources).toContainEqual({ name: 'id', in: 'path' });
    expect(updateItem.paramSources).toContainEqual({
      name: 'name',
      in: 'body',
    });
    expect(updateItem.paramSources).toContainEqual({
      name: 'tags',
      in: 'body',
    });
  });

  it('sets annotations based on HTTP method', async () => {
    const parseOpenAPISpec = await loadParser();
    const { tools } = await parseOpenAPISpec();

    const listItems = tools.find((t) => t.name === 'list_items')!;
    expect(listItems.annotations.readOnlyHint).toBe(true);

    const deleteItem = tools.find((t) => t.name === 'delete_item')!;
    expect(deleteItem.annotations.destructiveHint).toBe(true);

    const updateItem = tools.find((t) => t.name === 'update_item')!;
    expect(updateItem.annotations.readOnlyHint).toBeUndefined();
    expect(updateItem.annotations.destructiveHint).toBeUndefined();
  });

  it('loads Xquik OpenAPI 3.1 operations and auth metadata', async () => {
    vi.stubEnv('OPENAPI_SPEC_URL', XQUIK_FIXTURE_PATH);
    const parseOpenAPISpec = await loadParser();
    const { tools, spec } = await parseOpenAPISpec();

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Xquik API');
    expect(spec.servers?.[0]?.url).toBe('https://xquik.com');
    expect(spec.components?.securitySchemes?.apiKey).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key',
    });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'create_draft',
      'get_x_user',
      'search_x_posts',
    ]);

    const searchPosts = tools.find((tool) => tool.name === 'search_x_posts')!;
    expect(searchPosts.annotations.readOnlyHint).toBe(true);
    expect(searchPosts.paramSources).toContainEqual({ name: 'q', in: 'query' });
    expect(searchPosts.paramSources).toContainEqual({
      name: 'limit',
      in: 'query',
    });

    const createDraft = tools.find((tool) => tool.name === 'create_draft')!;
    expect(createDraft.method).toBe('POST');
    expect(createDraft.paramSources).toContainEqual({
      name: 'prompt',
      in: 'body',
    });
  });
});
