export interface ParamSource {
  name: string;
  // rawBody: the arg is sent as the whole request body.
  in: 'path' | 'query' | 'rawBody';
}

// Args that aren't path or query params become the JSON body.
export async function callApi(
  method: string,
  baseUrl: string,
  pathTemplate: string,
  headers: Headers,
  params: Record<string, unknown>,
  paramSources: ParamSource[],
) {
  const pathParams = new Set<string>();
  const queryParams = new Set<string>();
  for (const source of paramSources) {
    if (source.in === 'path') pathParams.add(source.name);
    if (source.in === 'query') queryParams.add(source.name);
  }

  let path = pathTemplate;
  for (const name of pathParams) {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }

  const url = new URL(baseUrl + path);
  for (const name of queryParams) {
    const value = params[name];
    if (value !== undefined) {
      url.searchParams.set(name, String(value));
    }
  }

  const bodyParams = Object.fromEntries(
    Object.entries(params).filter(
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
  if (hasBody) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const response = await fetch(url.toString(), {
    method,
    headers: requestHeaders,
    ...(hasBody && { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`API returned ${response.status}: ${text}`);
  }
  return text;
}
