import type { OpenAPIV3 } from 'openapi-types';
import { z } from 'zod';

const envSchema = z.object({
  OPENAPI_SPEC_URL: z.string({ error: 'OPENAPI_SPEC_URL is required' }),
  API_BASE_URL: z.url().optional(),
  MCP_SERVER_NAME: z.string().optional(),
  MCP_TOOL_PREFIX: z
    .string()
    .regex(
      /^[A-Za-z0-9_.-]+$/,
      'MCP_TOOL_PREFIX may only use A-Z a-z 0-9 _ . -',
    )
    .optional(),
  PORT: z.coerce.number().int().positive().optional(),
  MCP_TAGS: z.string().optional(),
  MCP_READ_ONLY: z.stringbool().default(false),
  MCP_MAX_RESPONSE_CHARS: z.coerce.number().int().nonnegative().default(40000),
});

export function getEnv() {
  // `FOO=` means unset, not false or 0
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value?.trim()),
  );
  return envSchema.parse(env);
}

export function resolveConfig(spec: OpenAPIV3.Document) {
  const env = getEnv();

  const serverUrl = env.API_BASE_URL || spec.servers?.[0]?.url;
  if (!serverUrl) {
    throw new Error(
      'Set API_BASE_URL env var or add servers[0].url to your OpenAPI spec',
    );
  }
  // A relative servers[0].url ("/") is relative to where the spec is served
  const specUrl = env.OPENAPI_SPEC_URL;
  let apiBaseUrl: string;
  try {
    apiBaseUrl = new URL(serverUrl, URL.canParse(specUrl) ? specUrl : undefined)
      .href;
  } catch {
    throw new Error(
      `servers[0].url "${serverUrl}" cannot be resolved; set API_BASE_URL`,
    );
  }

  return {
    apiBaseUrl: apiBaseUrl.replace(/\/$/, ''),
    serverName: env.MCP_SERVER_NAME || spec.info.title || 'OpenAPI MCP Server',
    serverVersion: spec.info.version || '1.0.0',
    maxResponseChars: env.MCP_MAX_RESPONSE_CHARS,
  };
}
