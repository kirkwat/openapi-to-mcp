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
  // Media type the body was declared with, e.g. application/merge-patch+json
  bodyContentType?: string;
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
 * Converts an operation summary like "Create Widget" to a tool name like "create_widget".
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
 * e.g., GET /widgets/{id} → "get_widgets_by_id"
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

type OperationExtensions = {
  'x-mcp'?: unknown;
  'x-mcp-description'?: unknown;
  'x-mcp-destructive'?: unknown;
  'x-mcp-readonly'?: unknown;
};

function isOpenAPIDocument(
  v: unknown,
): v is OpenAPIV3.Document<OperationExtensions> & {
  paths: OpenAPIV3.PathsObject<OperationExtensions, { 'x-mcp'?: unknown }>;
} {
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
  warned: Set<string>,
  visited = new Set<string>(),
): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveRefs(item, root, warned, visited));
  }

  if (!isRecord(obj)) return obj;

  if (typeof obj['$ref'] === 'string') {
    const ref = obj['$ref'];
    if (visited.has(ref)) return { type: 'object' };

    // Only local refs resolve; external files ("other.yaml#/Foo") fall through
    let resolved: unknown = ref.startsWith('#/') ? root : undefined;
    for (const part of ref.slice(2).split('/')) {
      // Arrays too: pointers index them ("parameters/0")
      if (typeof resolved !== 'object' || resolved === null) break;
      let key = part;
      try {
        key = decodeURIComponent(part);
      } catch {} // Malformed %-escape: use the raw segment
      // RFC 6901: unescape ~1 before ~0 so "~01" becomes "~1", not "/"
      key = key.replaceAll('~1', '/').replaceAll('~0', '~');
      resolved = Object.hasOwn(resolved, key)
        ? Reflect.get(resolved, key)
        : undefined;
    }
    if (!isRecord(resolved)) {
      if (!warned.has(ref)) console.error(`Unresolvable $ref ${ref}`);
      warned.add(ref);
      return {};
    }
    const nextVisited = new Set(visited);
    nextVisited.add(ref);
    return resolveRefs(resolved, root, warned, nextVisited);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveRefs(value, root, warned, visited);
  }
  return result;
}

function isArraySchema(schema: unknown) {
  return isRecord(schema) && [schema.type].flat().includes('array');
}

// e.g. "Returns: widgets[], page, total" or "Returns: array of id, name"
// First JSON entry of a content map, accepting charset params and +json suffixes
function jsonContent(content: Record<string, OpenAPIV3.MediaTypeObject> = {}) {
  return Object.entries(content).find(([type]) => {
    const base = type.split(';')[0].trim().toLowerCase();
    return base === 'application/json' || base.endsWith('+json');
  });
}

function describeResponse(operation: OpenAPIV3.OperationObject) {
  const schema = ['200', '201', '2XX']
    .map((code) => {
      const res = operation.responses?.[code];
      return res && !('$ref' in res)
        ? jsonContent(res.content)?.[1].schema
        : undefined;
    })
    .find(Boolean);

  const isArray = isArraySchema(schema);
  const shape = isArray && isRecord(schema) ? schema.items : schema;
  if (!isRecord(shape) || !isRecord(shape.properties)) return undefined;
  const fields = Object.entries(shape.properties)
    // Bound token cost
    .slice(0, 8)
    .map(([key, prop]) => key + (isArraySchema(prop) ? '[]' : ''));
  return fields.length > 0
    ? `Returns: ${isArray ? 'array of ' : ''}${fields.join(', ')}`
    : undefined;
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
  const {
    OPENAPI_SPEC_URL,
    MCP_TOOL_PREFIX = '',
    MCP_TAGS,
    MCP_READ_ONLY,
  } = getEnv();
  const rawSpec: unknown = parseYaml(await loadSpec(OPENAPI_SPEC_URL));

  const spec = resolveRefs(rawSpec, rawSpec, new Set());
  if (!isOpenAPIDocument(spec)) {
    throw new Error('OPENAPI_SPEC_URL must point to an OpenAPI 3.x document');
  }

  // OpenAPI 3.1 schemas are already JSON Schema 2020-12
  const toJsonSchema = spec.openapi.startsWith('3.0')
    ? normalizeSchema
    : (schema: unknown) => schema;
  // "A,B,-C": keep operations tagged A or B, drop any tagged C
  const tagList = (MCP_TAGS ?? '').split(',').map((t) => t.trim());
  const includeTags = tagList.filter((t) => t && !t.startsWith('-'));
  const excludeTags = tagList
    .filter((t) => t.startsWith('-'))
    .map((t) => t.slice(1));

  const tools: ToolDefinition[] = [];
  const usedNames = new Set<string>();
  let operationCount = 0;

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      operationCount++;

      const enabled = operation['x-mcp'] ?? pathItem['x-mcp'];
      const tags = operation.tags ?? [];
      const destructive = operation['x-mcp-destructive'];
      const readOnly = operation['x-mcp-readonly'];
      const annotations: ToolAnnotations = {
        ...ANNOTATIONS[method],
        ...(readOnly === true && ANNOTATIONS.get),
        ...(typeof destructive === 'boolean' && {
          destructiveHint: destructive,
        }),
        openWorldHint: false,
      };
      if (
        enabled === false ||
        (includeTags.length > 0 &&
          !tags.some((tag) => includeTags.includes(tag))) ||
        tags.some((tag) => excludeTags.includes(tag)) ||
        (MCP_READ_ONLY &&
          (!annotations.readOnlyHint || annotations.destructiveHint))
      ) {
        continue;
      }

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

      const override = operation['x-mcp-description'];
      const details =
        operation.description ||
        [`${method.toUpperCase()} ${path}`, describeResponse(operation)]
          .filter(Boolean)
          .join('. ');
      const defaultDescription = [
        operation.summary,
        details !== operation.summary && details,
      ]
        .filter(Boolean)
        .join('. ');
      const description =
        typeof override === 'string' && override.trim()
          ? override
          : defaultDescription;

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
      const [bodyType, jsonBody] = jsonContent(requestBody?.content) ?? [];
      const bodySchema = toJsonSchema(jsonBody?.schema);

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
        bodyContentType: bodyType?.split(';')[0].trim(),
        annotations,
      });
    }
  }

  if (tools.length < operationCount) {
    console.log(`Registered ${tools.length} of ${operationCount} operations`);
  }

  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { tools, spec };
}
