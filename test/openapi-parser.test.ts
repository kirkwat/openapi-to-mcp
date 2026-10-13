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
    // The fixture's unresolvable refs log on every parse
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('names tools and maps them to an HTTP method and path', async () => {
    const { tools, spec } = await parseOpenAPISpec();

    expect(spec.info.title).toBe('Test API');
    expect(tools.map((t) => [t.name, t.method, t.path])).toEqual([
      ['addItemLabel', 'POST', '/items/{id}/labels'],
      ['archiveAll', 'POST', '/archive'],
      ['delete_item', 'DELETE', '/items/{id}'],
      ['getItem', 'GET', '/items/{id}'],
      ['internalReindex', 'POST', '/internal'],
      ['listWidgets', 'GET', '/widgets'],
      ['list_items', 'GET', '/items'],
      ['list_items_2', 'POST', '/reports/{reportId}'],
      ['mergeItem', 'PATCH', '/items/{id}/merge'],
      ['patch_item', 'PATCH', '/items/{id}'],
      ['post_items_bulk', 'POST', '/items/bulk'],
      ['replace_item', 'PUT', '/items/{id}'],
      ['replace_report', 'PUT', '/reports/{reportId}'],
      ['reports_get_v1', 'GET', '/reports/{reportId}'],
      ['searchWidgets', 'POST', '/widgets/search'],
      ['update_item', 'POST', '/items/{id}'],
      ['widget_history', 'GET', '/widgets/history-v0'],
      ['widget_history_2', 'GET', '/widgets/history'],
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

  it('reads JSON bodies with media-type parameters or a +json suffix', async () => {
    const addLabel = await getTool('addItemLabel');
    expect(addLabel.inputSchema.properties).toHaveProperty('label');

    const merge = await getTool('mergeItem');
    expect(merge.inputSchema.properties).toMatchObject({
      name: { type: 'string' },
    });
    expect(merge.paramSources).toEqual([{ name: 'id', in: 'path' }]);
    // The declared media type is sent back upstream, minus parameters
    expect(addLabel.bodyContentType).toBe('application/json');
    expect(merge.bodyContentType).toBe('application/merge-patch+json');
  });

  it('resolves escaped JSON-pointer refs', async () => {
    const addLabel = await getTool('addItemLabel');
    expect(addLabel.paramSources).toEqual([
      { name: 'id', in: 'path' },
      { name: 'rev', in: 'query' },
    ]);
    expect(addLabel.inputSchema.properties).toMatchObject({
      id: { type: 'string', format: 'uuid' },
      rev: { type: 'integer' },
    });
  });

  it('replaces unresolvable refs with {} and logs each once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tools } = await parseOpenAPISpec();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName.addItemLabel.inputSchema.properties).toMatchObject({
      source: {},
    });
    expect(byName.mergeItem.inputSchema.properties).toMatchObject({
      meta: {},
    });
    expect(error.mock.calls).toEqual([
      ['Unresolvable $ref #/components/parameters/Missing'],
      ['Unresolvable $ref other.yaml#/Missing'],
    ]);
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

  it('synthesizes a description when the spec has none', async () => {
    const { tools } = await parseOpenAPISpec();
    const descriptions = Object.fromEntries(
      tools.map((t) => [t.name, t.description]),
    );

    expect(descriptions).toMatchObject({
      list_items: 'List Items. Returns a list of items',
      getItem: 'Get Item. GET /items/{id}',
      reports_get_v1: 'GET /reports/{reportId}',
      listWidgets:
        'List Widgets. GET /widgets. Returns: widgets[], tags[], page, total',
      widget_history_2:
        'Widget History. GET /widgets/history. Returns: array of id, name',
      searchWidgets: 'Find widgets matching a query.',
    });
  });

  it('skips operations marked x-mcp: false and logs the count', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { tools } = await parseOpenAPISpec();
    const names = tools.map((t) => t.name);

    expect(names).not.toContain('purgeWidgets');
    expect(names).not.toContain('internalStatus');
    expect(names).toContain('internalReindex');
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^Registered \d+ of \d+ operations$/),
    );
  });

  it('logs nothing when no operation is filtered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('OPENAPI_SPEC_URL', 'https://spec.test/openapi.json');
    vi.stubGlobal('fetch', async () =>
      Response.json({
        openapi: '3.0.3',
        info: { title: 'Mini', version: '1' },
        paths: {
          '/a': { get: { responses: { '200': { description: 'OK' } } } },
        },
      }),
    );

    const { tools } = await parseOpenAPISpec();
    expect(tools.map((t) => t.name)).toEqual(['get_a']);
    expect(log).not.toHaveBeenCalled();
  });

  it('filters by MCP_TAGS, with a - prefix excluding', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('MCP_TAGS', ' Widget ,Search');
    let { tools } = await parseOpenAPISpec();
    expect(tools.map((t) => t.name)).toEqual([
      'listWidgets',
      'searchWidgets',
      'widget_history',
      'widget_history_2',
    ]);

    vi.stubEnv('MCP_TAGS', '-Legacy,-Search');
    ({ tools } = await parseOpenAPISpec());
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_items');
    expect(names).not.toContain('searchWidgets');
    // The filtered collision no longer claims the base name
    expect(tools.find((t) => t.name === 'widget_history')?.path).toBe(
      '/widgets/history',
    );
    expect(names).not.toContain('widget_history_2');

    vi.stubEnv('MCP_TAGS', 'Widget,-Legacy,-Search');
    ({ tools } = await parseOpenAPISpec());
    expect(tools.map((t) => t.name)).toEqual(['listWidgets', 'widget_history']);
  });

  it('keeps only read-only operations when MCP_READ_ONLY is set', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('MCP_READ_ONLY', 'true');
    const { tools } = await parseOpenAPISpec();

    // archiveAll is read-only but destructive, so it is dropped too
    expect(tools.map((t) => t.name)).toEqual([
      'getItem',
      'listWidgets',
      'list_items',
      'reports_get_v1',
      'searchWidgets',
      'widget_history',
      'widget_history_2',
    ]);
  });

  it('derives annotations from the method and x-mcp-* overrides', async () => {
    const { tools } = await parseOpenAPISpec();
    const annotations = Object.fromEntries(
      tools.map((t) => [t.name, t.annotations]),
    );
    const hints = (
      readOnlyHint: boolean,
      destructiveHint: boolean,
      idempotentHint: boolean,
    ) => ({
      readOnlyHint,
      destructiveHint,
      idempotentHint,
      openWorldHint: false,
    });

    expect(annotations).toMatchObject({
      list_items: hints(true, false, true),
      update_item: hints(false, false, false),
      replace_item: hints(false, true, true),
      // PATCH is destructive by default; x-mcp-destructive: false overrides
      patch_item: hints(false, false, false),
      delete_item: hints(false, true, true),
      // x-mcp-readonly: true on a POST
      searchWidgets: hints(true, false, true),
      archiveAll: hints(true, true, true),
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
