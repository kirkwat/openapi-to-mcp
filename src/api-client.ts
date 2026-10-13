export interface ParamSource {
  name: string;
  // rawBody: the arg is sent as the whole request body.
  in: 'path' | 'query' | 'rawBody';
}

// JSON.parse rounds integer literals past 2^53, so bodies holding one are cut
// as text. Only bare numbers count: digit runs inside strings (phones, ids) are safe.
const BIG_INTEGER = /[:[,]\s*-?\d{16,}(?=\s*[,\]}])/;

function truncate(text: string, maxChars: number, narrowWith: string[]) {
  if (maxChars === 0 || text.length <= maxChars) return text;

  const trailer = (shown: number, total: number, unit: string) =>
    `\nTruncated: showing ${shown} of ${total} ${unit} (${maxChars} char limit).` +
    (narrowWith.length > 0 ? ` Narrow with: ${narrowWith.join(', ')}` : '');

  let json: unknown;
  try {
    if (!BIG_INTEGER.test(text)) {
      json = JSON.parse(text);
      // Compact re-serialization alone can bring a pretty-printed body under.
      const compact = JSON.stringify(json);
      if (compact.length <= maxChars) return compact;
    }
  } catch {
    // Not JSON: fall through to the character cut.
  }

  // Trim the body itself, or its largest array-valued top-level field.
  const root = Array.isArray(json)
    ? { items: json }
    : typeof json === 'object' && json !== null
      ? json
      : {};
  let field = '';
  let items: unknown[] = [];
  let size = 0;
  for (const [key, value] of Object.entries(root)) {
    if (!Array.isArray(value)) continue;
    const valueSize = JSON.stringify(value).length;
    if (valueSize > size) [field, items, size] = [key, value, valueSize];
  }

  const serialize = (count: number) => {
    const kept = items.slice(0, count);
    return JSON.stringify(
      Array.isArray(json) ? kept : { ...root, [field]: kept },
    );
  };
  // Largest prefix whose serialization fits.
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (serialize(mid).length <= maxChars) low = mid;
    else high = mid - 1;
  }
  // Showing zero items tells the model nothing; cut the text instead.
  if (low > 0) return serialize(low) + trailer(low, items.length, field);

  return text.slice(0, maxChars) + trailer(maxChars, text.length, 'characters');
}

// Args that aren't path or query params become the JSON body.
export async function callApi(
  operation: {
    method: string;
    path: string;
    paramSources: ParamSource[];
    bodyContentType?: string;
    annotations: { idempotentHint?: boolean };
  },
  {
    baseUrl,
    headers,
    args,
    maxChars,
  }: {
    baseUrl: string;
    headers: Headers;
    args: Record<string, unknown>;
    // Cap on successful body length; 0 disables.
    maxChars: number;
  },
) {
  const { method, paramSources } = operation;
  const pathParams = new Set<string>();
  const queryParams = new Set<string>();
  for (const source of paramSources) {
    if (source.in === 'path') pathParams.add(source.name);
    if (source.in === 'query') queryParams.add(source.name);
  }

  let path = operation.path;
  for (const name of pathParams) {
    const value = args[name];
    if (value === undefined) {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  // A leftover placeholder means the spec names its path param differently.
  const unfilled = path.match(/\{[^}]+\}/);
  if (unfilled) {
    throw new Error(
      `Path ${operation.path} has no parameter for ${unfilled[0]}; the spec declares ${[...pathParams].join(', ') || 'none'}`,
    );
  }

  const url = new URL(baseUrl + path);
  for (const name of queryParams) {
    const value = args[name];
    if (value == null) continue;
    // OpenAPI default (style: form, explode: true): one name=value per element.
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item == null) continue;
      url.searchParams.append(
        name,
        typeof item === 'object' && item !== null
          ? JSON.stringify(item)
          : String(item),
      );
    }
  }

  const bodyParams = Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) =>
        value !== undefined && !pathParams.has(key) && !queryParams.has(key),
    ),
  );
  const rawBody = paramSources.find((s) => s.in === 'rawBody');
  let body: unknown;
  if (rawBody) {
    body = bodyParams[rawBody.name];
  } else if (Object.keys(bodyParams).length > 0) {
    body = bodyParams;
  }

  const hasBody = body !== undefined && method !== 'GET' && method !== 'DELETE';

  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept', 'application/json');
  if (hasBody) {
    requestHeaders.set(
      'Content-Type',
      operation.bodyContentType ?? 'application/json',
    );
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers: requestHeaders,
      ...(hasBody && { body: JSON.stringify(body) }),
    });
  } catch (error) {
    // Node's fetch says only "fetch failed"; the socket reason is in `cause`.
    const cause = error instanceof Error ? error.cause : undefined;
    const reason = [error, cause]
      .map((e) =>
        e instanceof Error ? e.message : typeof e === 'string' ? e : '',
      )
      .filter(Boolean)
      .join(': ');
    throw new Error(
      `Could not reach ${url.host}: ${reason || 'unknown error'}`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    const { status, statusText } = response;
    const errorBody = text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
    const lines = [
      `Upstream returned ${[status, statusText].filter(Boolean).join(' ')}: ${errorBody}`,
    ];
    if (status === 401 || status === 403) {
      lines.push(
        'The target API rejected the credentials sent by your MCP client. Check the headers configured for this server (e.g. X-Api-Key or Authorization).',
      );
    } else if (status === 404) {
      lines.push(`No resource at ${method} ${path}.`);
    } else if (status === 429) {
      lines.push(
        'Rate limited. Wait before retrying; prefer fewer, narrower calls.',
      );
    } else if (status >= 500) {
      lines.push(
        'The API failed.' +
          (operation.annotations.idempotentHint
            ? ' Retrying once is reasonable.'
            : ''),
      );
    }
    throw new Error(lines.join('\n'));
  }

  return truncate(text, maxChars, [...queryParams]);
}
