import { readFile } from 'node:fs/promises';

import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { OpenAPIV3 } from 'openapi-types';
import { parse as parseYaml } from 'yaml';

import type { ParamSource } from './api-client.js';
import { getEnv } from './config.js';

interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  method: string;
  path: string;
  paramSources: ParamSource[];
  annotations: ToolAnnotations;
}

const MAX_NAME_LENGTH = 128;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

// False values stay explicit: MCP defaults to destructive and non-idempotent.
const ANNOTATIONS: Record<(typeof HTTP_METHODS)[number], ToolAnnotations> = {
  get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  post: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  put: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  patch: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

// Keys whose value is a map of name → schema (not itself a schema).
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs']);
// Keys whose value is instance data, never a schema.
const DATA_KEYS = new Set(['enum', 'const', 'default', 'examples']);

/**
 * Converts an operation summary like "Create Audience" to a tool name like "create_audience".
 */
function summaryToToolName(summary: string) {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

/**
 * Generates a fallback tool name from method + path.
 * e.g., GET /audiences/{id} → "get_audiences_by_id"
 */
function fallbackToolName(method: string, path: string) {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith('{') && seg.endsWith('}')) {
        return `by_${seg.slice(1, -1)}`;
      }
      return seg;
    });
  return `${method}_${segments.join('_')}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isOpenAPIDocument(
  v: unknown,
): v is OpenAPIV3.Document<{ 'x-mcp-destructive'?: unknown }> {
  return (
    isRecord(v) &&
    typeof v.openapi === 'string' &&
    v.openapi.startsWith('3.') &&
    isRecord(v.info)
  );
}

function resolveRefs(
  obj: unknown,
  root: unknown,
  visited = new Set<string>(),
): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveRefs(item, root, visited));
  }

  if (!isRecord(obj)) return obj;

  if (typeof obj['$ref'] === 'string') {
    const ref = obj['$ref'];
    if (visited.has(ref)) return { type: 'object' };

    const parts = ref.replace('#/', '').split('/');
    let resolved: unknown = root;
    for (const part of parts) {
      if (!isRecord(resolved)) break;
      resolved = resolved[part];
    }
    const nextVisited = new Set(visited);
    nextVisited.add(ref);
    return resolveRefs(resolved, root, nextVisited);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveRefs(value, root, visited);
  }
  return result;
}

// OpenAPI 3.0 keywords → JSON Schema 2020-12.
function normalizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (!isRecord(schema)) return schema;

  const {
    nullable,
    example,
    discriminator: _discriminator,
    xml: _xml,
    externalDocs: _externalDocs,
    ...rest
  } = schema;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (DATA_KEYS.has(key)) {
      result[key] = value;
    } else if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalizeSchema(v)]),
      );
    } else {
      result[key] = normalizeSchema(value);
    }
  }

  if (example !== undefined && result.examples === undefined) {
    result.examples = [example];
  }

  for (const [exclusive, bound] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ] as const) {
    if (typeof result[exclusive] !== 'boolean') continue;
    if (result[exclusive] && typeof result[bound] === 'number') {
      result[exclusive] = result[bound];
      delete result[bound];
    } else {
      delete result[exclusive];
    }
  }

  if (nullable !== true) return result;
  // x-mcp-header requires a single primitive type, which null breaks
  delete result['x-mcp-header'];
  if (
    typeof result.type !== 'string' ||
    'allOf' in result ||
    'oneOf' in result ||
    'anyOf' in result
  ) {
    return { anyOf: [result, { type: 'null' }] };
  }
  result.type = [result.type, 'null'];
  if (Array.isArray(result.enum) && !result.enum.includes(null)) {
    result.enum = [...result.enum, null];
  }
  return result;
}

async function loadSpec(specUrl: string) {
  if (specUrl.startsWith('/') || specUrl.startsWith('file://')) {
    const filePath = specUrl.replace('file://', '');
    return readFile(filePath, 'utf-8');
  }

  const response = await fetch(specUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenAPI spec: ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

export async function parseOpenAPISpec() {
  const { OPENAPI_SPEC_URL, MCP_TOOL_PREFIX = '' } = getEnv();
  const rawSpec: unknown = parseYaml(await loadSpec(OPENAPI_SPEC_URL));

  const spec = resolveRefs(rawSpec, rawSpec);
  if (!isOpenAPIDocument(spec)) {
    throw new Error('OPENAPI_SPEC_URL must point to an OpenAPI 3.x document');
  }

  // OpenAPI 3.1 schemas are already JSON Schema 2020-12
  const toJsonSchema = spec.openapi.startsWith('3.0')
    ? normalizeSchema
    : (schema: unknown) => schema;

  const tools: ToolDefinition[] = [];
  const usedNames = new Set<string>();

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const baseName =
        operation.operationId ||
        (operation.summary && summaryToToolName(operation.summary)) ||
        fallbackToolName(method, path);
      let name = `${MCP_TOOL_PREFIX}${baseName}`
        .replace(/[^A-Za-z0-9_.-]/g, '_')
        .slice(0, MAX_NAME_LENGTH);

      // Deduplicate names
      const uniqueBase = name;
      for (let counter = 2; usedNames.has(name); counter++) {
        const suffix = `_${counter}`;
        name = uniqueBase.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
      }
      usedNames.add(name);

      const description = [
        operation.summary,
        operation.description !== operation.summary && operation.description,
      ]
        .filter(Boolean)
        .join('. ');

      const paramSources: ParamSource[] = [];
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      // Operation-level params override path-level ones
      const parameters = new Map<string, OpenAPIV3.ParameterObject>();
      for (const param of [
        ...(pathItem.parameters ?? []),
        ...(operation.parameters ?? []),
      ]) {
        if (!('$ref' in param))
          parameters.set(`${param.in}:${param.name}`, param);
      }
      for (const param of parameters.values()) {
        if (param.in !== 'path' && param.in !== 'query') continue;

        paramSources.push({ name: param.name, in: param.in });

        const schema = toJsonSchema(param.schema ?? { type: 'string' });
        properties[param.name] =
          param.description && isRecord(schema)
            ? { ...schema, description: param.description }
            : schema;
        if (param.required) required.push(param.name);
      }

      const requestBody =
        operation.requestBody && !('$ref' in operation.requestBody)
          ? operation.requestBody
          : undefined;
      const bodySchema = toJsonSchema(
        requestBody?.content?.['application/json']?.schema,
      );

      if (isRecord(bodySchema) && isRecord(bodySchema.properties)) {
        const bodyRequired = Array.isArray(bodySchema.required)
          ? bodySchema.required
          : [];

        for (const [propName, propSchema] of Object.entries(
          bodySchema.properties,
        )) {
          properties[propName] = propSchema;
          if (bodyRequired.includes(propName)) required.push(propName);
        }
      } else if (bodySchema !== undefined) {
        paramSources.push({ name: 'body', in: 'rawBody' });
        properties['body'] = bodySchema;
        if (requestBody?.required) required.push('body');
      }

      const destructiveOverride = operation['x-mcp-destructive'];

      tools.push({
        name,
        title: operation.summary,
        description,
        inputSchema: {
          type: 'object',
          properties,
          required: [...new Set(required)],
          additionalProperties: false,
        },
        method: method.toUpperCase(),
        path,
        paramSources,
        annotations: {
          ...ANNOTATIONS[method],
          ...(typeof destructiveOverride === 'boolean' && {
            destructiveHint: destructiveOverride,
          }),
          openWorldHint: false,
        },
      });
    }
  }

  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { tools, spec };
}
