import path from 'node:path';

import { fromJsonSchema } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseOpenAPISpec } from '../src/openapi-parser.js';

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/openapi.yaml');

async function getTool(name: string) {
  const { tools } = await parseOpenAPISpec();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe('parseOpenAPISpec', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAPI_SPEC_URL', FIXTURE_PATH);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names tools and maps them to an HTTP method and path', async () => {
    const { tools, spec } = await parseOpenAPISpec();

    expect(spec.info.title).toBe('Test API');
    expect(tools.map((t) => [t.name, t.method, t.path])).toEqual([
      ['delete_item', 'DELETE', '/items/{id}'],
      ['getItem', 'GET', '/items/{id}'],
      ['list_items', 'GET', '/items'],
      ['list_items_2', 'POST', '/reports/{reportId}'],
      ['patch_item', 'PATCH', '/items/{id}'],
      ['post_items_bulk', 'POST', '/items/bulk'],
      ['replace_item', 'PUT', '/items/{id}'],
      ['replace_report', 'PUT', '/reports/{reportId}'],
      ['reports_get_v1', 'GET', '/reports/{reportId}'],
      ['update_item', 'POST', '/items/{id}'],
    ]);
    expect(tools.find((t) => t.name === 'getItem')?.title).toBe('Get Item');
    expect(
      tools.find((t) => t.name === 'post_items_bulk')?.title,
    ).toBeUndefined();
  });

  it('prepends MCP_TOOL_PREFIX to every tool name', async () => {
    vi.stubEnv('MCP_TOOL_PREFIX', 'acme_');
    const { tools } = await parseOpenAPISpec();

    expect(tools.every((t) => t.name.startsWith('acme_'))).toBe(true);
    expect(tools.map((t) => t.name)).toContain('acme_getItem');
  });

  it('records where each path and query param goes', async () => {
    const listItems = await getTool('list_items');
    expect(listItems.paramSources).toEqual([
      { name: 'limit', in: 'query' },
      { name: 'status', in: 'query' },
    ]);

    const updateItem = await getTool('update_item');
    expect(updateItem.paramSources).toEqual([{ name: 'id', in: 'path' }]);
  });

  it('builds a flat JSON Schema object preserving spec keywords', async () => {
    const listItems = await getTool('list_items');
    expect(listItems.inputSchema).toEqual({
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Max items to return',
        },
        status: { type: 'string', enum: ['active', 'archived'] },
      },
      required: ['status'],
      additionalProperties: false,
    });

    const updateItem = await getTool('update_item');
    expect(updateItem.inputSchema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', 'x-mcp-header': 'Item-Id' },
        name: { type: 'string', description: 'Item name' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'name'],
      additionalProperties: false,
    });
  });

  it('merges path-item parameters, operation-level ones winning', async () => {
    const getReport = await getTool('reports_get_v1');
    expect(getReport.paramSources.slice(0, 2)).toEqual([
      { name: 'reportId', in: 'path' },
      { name: 'format', in: 'query' },
    ]);
    expect(getReport.inputSchema.required).toEqual(['reportId']);

    const replaceReport = await getTool('replace_report');
    expect(replaceReport.inputSchema.required).toEqual(['reportId', 'format']);
  });

  it('passes non-object request bodies as a raw "body" argument', async () => {
    const bulk = await getTool('post_items_bulk');
    expect(bulk.paramSources).toEqual([{ name: 'body', in: 'rawBody' }]);
    expect(bulk.inputSchema).toMatchObject({
      properties: { body: { type: 'array' } },
      required: [],
    });

    const postReport = await getTool('list_items_2');
    expect(postReport.paramSources).toContainEqual({
      name: 'body',
      in: 'rawBody',
    });
    expect(postReport.inputSchema.required).not.toContain('body');
  });

  it('keeps an object body property named "body" as a body field', async () => {
    const replaceReport = await getTool('replace_report');
    expect(replaceReport.paramSources).not.toContainEqual({
      name: 'body',
      in: 'rawBody',
    });
    expect(replaceReport.inputSchema.properties).toMatchObject({
      body: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    });
  });

  it('converts boolean exclusive bounds and nullable x-mcp-header', async () => {
    const getReport = await getTool('reports_get_v1');
    expect(getReport.inputSchema.properties).toMatchObject({
      minScore: { type: 'number', exclusiveMinimum: 0 },
      maxScore: { type: 'number', maximum: 1 },
      cursor: { type: ['string', 'null'] },
    });
    expect(getReport.inputSchema.properties).not.toHaveProperty(
      'minScore.minimum',
    );
    expect(getReport.inputSchema.properties).not.toHaveProperty(
      'maxScore.exclusiveMaximum',
    );
    expect(getReport.inputSchema.properties).not.toHaveProperty(
      'cursor.x-mcp-header',
    );
  });

  it('normalizes OpenAPI 3.0 keywords to JSON Schema 2020-12', async () => {
    const { inputSchema } = await getTool('replace_item');
    const props = inputSchema.properties;

    expect(props).toMatchObject({
      name: { type: 'string', minLength: 1, examples: ['Widget'] },
      notes: { type: ['string', 'null'] },
      priority: { type: ['string', 'null'], enum: ['low', 'high', null] },
      owner: { anyOf: [{ allOf: [expect.any(Object)] }, { type: 'null' }] },
      sku: { type: 'string', format: 'internal-sku', 'x-internal': true },
      example: { type: 'string' },
      children: { type: 'array', items: { type: 'object' } },
    });
    expect(props).not.toHaveProperty('name.example');
    expect(props).not.toHaveProperty('notes.nullable');
    expect(inputSchema.required).toEqual(['id', 'name']);
    expect(JSON.stringify(inputSchema)).not.toMatch(
      /"(nullable|discriminator|xml|externalDocs)"/,
    );
  });

  it('sets all four annotations per HTTP method', async () => {
    const { tools } = await parseOpenAPISpec();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName['list_items']!.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName['update_item']!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName['replace_item']!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName['delete_item']!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('lets x-mcp-destructive override destructiveHint', async () => {
    const patchItem = await getTool('patch_item');
    expect(patchItem.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('produces schemas the SDK validator accepts', async () => {
    const { tools } = await parseOpenAPISpec();
    const validators = new Map(
      tools.map((t) => [
        t.name,
        fromJsonSchema(t.inputSchema)['~standard'].validate,
      ]),
    );
    for (const [name, validate] of validators) {
      expect(await validate({ unknown: 1 }), name).toHaveProperty('issues');
    }

    const replaceItem = validators.get('replace_item')!;
    const item = { id: '6f1c9a4e-2b1d-4c3a-9f0e-1a2b3c4d5e6f', name: 'W' };
    expect(await replaceItem({ ...item, priority: 'urgent' })).toHaveProperty(
      'issues',
    );
    expect(
      await replaceItem({ ...item, priority: null, notes: null, owner: null }),
    ).not.toHaveProperty('issues');

    const getReport = validators.get('reports_get_v1')!;
    expect(await getReport({ reportId: 'r1', minScore: 0 })).toHaveProperty(
      'issues',
    );
    expect(
      await getReport({ reportId: 'r1', minScore: 0.5 }),
    ).not.toHaveProperty('issues');
  });
});
