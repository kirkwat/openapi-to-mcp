import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { OpenAPIV3 } from 'openapi-types';
import { parse as parseYaml } from 'yaml';
import { z, type ZodType } from 'zod';

import type { ParamSource } from './api-client.js';
import { getEnv } from './config.js';
import { jsonSchemaToZod } from './schema-to-zod.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, ZodType>;
  method: string;
  path: string;
  paramSources: ParamSource[];
  annotations: ToolAnnotations;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * Converts an operation summary like "Create Audience" to a tool name like "create_audience".
 */
function summaryToToolName(summary: string) {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 64);
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
  return `${method}_${segments.join('_')}`.slice(0, 64);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getParameterKey(param: OpenAPIV3.ParameterObject) {
  return `${param.in}:${param.name}`;
}

function getOperationParameters(
  pathItem: OpenAPIV3.PathItemObject,
  operation: OpenAPIV3.OperationObject,
) {
  const params = new Map<string, OpenAPIV3.ParameterObject>();

  for (const rawParam of pathItem.parameters ?? []) {
    if ('$ref' in rawParam) continue;
    params.set(getParameterKey(rawParam), rawParam);
  }

  for (const rawParam of operation.parameters ?? []) {
    if ('$ref' in rawParam) continue;
    params.set(getParameterKey(rawParam), rawParam);
  }

  return params.values();
}

/**
 * Resolves all $ref references in a schema inline.
 */
function resolveRefs(
  obj: unknown,
  spec: OpenAPIV3.Document,
  visited = new Set<string>(),
): unknown {
  if (obj === null || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveRefs(item, spec, visited));
  }

  if (!isRecord(obj)) return obj;

  if (typeof obj['$ref'] === 'string') {
    const ref = obj['$ref'];
    if (visited.has(ref)) return { type: 'object' };

    const parts = ref.replace('#/', '').split('/');
    let resolved: unknown = spec;
    for (const part of parts) {
      if (!isRecord(resolved)) break;
      resolved = resolved[part];
    }
    const nextVisited = new Set(visited);
    nextVisited.add(ref);
    return resolveRefs(resolved, spec, nextVisited);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveRefs(value, spec, visited);
  }
  return result;
}

/**
 * Loads the OpenAPI spec from a URL or local file path (YAML or JSON).
 */
async function loadSpec() {
  const { OPENAPI_SPEC_URL: specUrl } = getEnv();

  // Support local file paths for development
  if (specUrl.startsWith('/') || specUrl.startsWith('file://')) {
    const { readFile } = await import('node:fs/promises');
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

/**
 * Fetches the OpenAPI spec and generates MCP tool definitions.
 */
export async function parseOpenAPISpec() {
  const specText = await loadSpec();
  const rawSpec = parseYaml(specText) as OpenAPIV3.Document;

  // Resolve all $refs inline
  const spec = resolveRefs(rawSpec, rawSpec) as OpenAPIV3.Document;

  const tools: ToolDefinition[] = [];
  const usedNames = new Set<string>();

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;

      // Generate tool name
      let name = operation.summary
        ? summaryToToolName(operation.summary)
        : fallbackToolName(method, path);

      // Deduplicate names
      if (usedNames.has(name)) {
        let counter = 2;
        while (usedNames.has(`${name}_${counter}`)) counter++;
        name = `${name}_${counter}`;
      }
      usedNames.add(name);

      // Build description
      let description = operation.summary ?? '';
      if (
        operation.description &&
        operation.description !== operation.summary
      ) {
        description += description
          ? `. ${operation.description}`
          : operation.description;
      }

      // Collect param sources and build flat Zod shape
      const paramSources: ParamSource[] = [];
      const shape: Record<string, ZodType> = {};

      // Path and query parameters
      for (const param of getOperationParameters(pathItem, operation)) {
        if (param.in === 'header' || param.in === 'cookie') continue;

        paramSources.push({
          name: param.name,
          in: param.in as 'path' | 'query',
        });

        if (param.schema) {
          let fieldSchema = jsonSchemaToZod(param.schema);
          if (param.description) {
            fieldSchema = fieldSchema.describe(param.description);
          }
          if (!param.required) {
            fieldSchema = fieldSchema.optional();
          }
          shape[param.name] = fieldSchema;
        } else {
          shape[param.name] = param.required
            ? z.string()
            : z.string().optional();
        }
      }

      // Request body — inline properties into the flat shape
      const requestBody = operation.requestBody;
      const bodySchema =
        requestBody && !('$ref' in requestBody)
          ? requestBody.content?.['application/json']?.schema
          : undefined;

      if (bodySchema && !('$ref' in bodySchema)) {
        if (bodySchema.properties) {
          const requiredFields = new Set(bodySchema.required ?? []);

          for (const [propName, propSchema] of Object.entries(
            bodySchema.properties,
          )) {
            paramSources.push({ name: propName, in: 'body' });

            let fieldSchema = jsonSchemaToZod(propSchema);
            if (!requiredFields.has(propName)) {
              fieldSchema = fieldSchema.optional();
            }
            shape[propName] = fieldSchema;
          }
        } else {
          // Non-object body — put under "body" key
          paramSources.push({ name: 'body', in: 'body' });
          shape['body'] = jsonSchemaToZod(bodySchema);
        }
      }

      // Annotations based on HTTP method
      const annotations: ToolDefinition['annotations'] = {};
      if (method === 'get') {
        annotations.readOnlyHint = true;
      } else if (method === 'delete') {
        annotations.destructiveHint = true;
      }

      tools.push({
        name,
        description,
        inputSchema: shape,
        method: method.toUpperCase(),
        path,
        paramSources,
        annotations,
      });
    }
  }

  return { tools, spec };
}
