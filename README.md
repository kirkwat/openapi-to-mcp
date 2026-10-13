# openapi-to-mcp

A minimal [MCP](https://modelcontextprotocol.io) server that turns every operation in your OpenAPI spec into a tool, ready to deploy on Vercel.

Useful when you want an existing API reachable from MCP clients such as Claude Desktop or Cursor today, with no code and no changes to the API: users connect with one URL and their existing API key. It fits internal and partner APIs, prototyping an agent integration before writing custom tools, and giving your users a working MCP server while a hand-crafted one is still on the roadmap. For large specs, expose only what matters with `MCP_TAGS`, `MCP_READ_ONLY`, and the `x-mcp-*` [spec extensions](#spec-extensions).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/kirkwat/openapi-to-mcp&env=OPENAPI_SPEC_URL&envDescription=URL%20to%20your%20OpenAPI%20spec&envLink=https://github.com/kirkwat/openapi-to-mcp%23configuration)

## Quick Start

1. Fork this repo
2. Set `OPENAPI_SPEC_URL` to your OpenAPI spec URL
3. Deploy to Vercel

## Configuration

| Variable                 | Required | Description                                                                       |
| ------------------------ | -------- | --------------------------------------------------------------------------------- |
| `OPENAPI_SPEC_URL`       | Yes      | URL or file path to your OpenAPI spec (YAML or JSON)                              |
| `API_BASE_URL`           | No       | Override the API base URL (defaults to `servers[0].url` from the spec)            |
| `MCP_SERVER_NAME`        | No       | Override the MCP server name (defaults to `info.title` from the spec)             |
| `MCP_TOOL_PREFIX`        | No       | Prefix prepended to every tool name, for namespacing (e.g. `acme_`)               |
| `MCP_TAGS`               | No       | Comma-separated tags to expose; prefix a tag with `-` to exclude it (`Orders,-Admin`) |
| `MCP_READ_ONLY`          | No       | Set to `1` to register only read-only operations (GET, or `x-mcp-readonly: true`) |
| `MCP_MAX_RESPONSE_CHARS` | No       | Truncate API responses beyond this many characters (default: 40000, `0` disables) |
| `PORT`                   | No       | Local dev server port (default: 3000)                                             |

## How It Works

1. On cold start, the server fetches and parses your OpenAPI spec
2. Each API endpoint becomes an MCP tool; its JSON Schema validates arguments before your API is called (tools whose schema fails to compile are skipped with a logged error)
3. When a tool is called, the request is forwarded to your API with the caller's auth headers passed through unchanged (see [Auth](#auth))
4. Responses longer than `MCP_MAX_RESPONSE_CHARS` are cut; lists drop items from the end and a trailing line names the query params that narrow the call
5. Errors return the upstream status and body plus one line of guidance (check credentials on 401/403, path arguments on 404, back off on 429)
6. The spec and tools are cached in memory, so warm invocations skip the fetch

The server is stateless and serves both MCP 2026-07-28 and 2025-era clients from the root path. `GET` returns `405`.

## Tool Annotations

Hints are derived from the HTTP method:

| Method   | readOnly | destructive | idempotent |
| -------- | -------- | ----------- | ---------- |
| `GET`    | yes      |             | yes        |
| `POST`   |          |             |            |
| `PUT`    |          | yes         | yes        |
| `PATCH`  |          | yes         |            |
| `DELETE` |          | yes         | yes        |

`openWorldHint` is always `false`. Override per operation with `x-mcp-readonly` or `x-mcp-destructive`.

## Spec extensions

| Extension           | On                   | Effect                                                                              |
| ------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `x-mcp`             | operation, path item | `false` hides it; `true` on an operation overrides its path item                    |
| `x-mcp-readonly`    | operation            | `true` makes it read-only whatever the method (e.g. a search POST)                  |
| `x-mcp-destructive` | operation            | `true` or `false` overrides `destructiveHint`                                       |
| `x-mcp-description` | operation            | Replaces the tool description (otherwise synthesized when `description` is missing) |

## Running Locally

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

Create `.env` and set `OPENAPI_SPEC_URL` to your OpenAPI spec. For local dev, this can be a remote URL or an absolute file path:

```env
# Remote URL
OPENAPI_SPEC_URL=https://api.example.com/openapi.yaml

# Or an absolute file path (local dev only)
OPENAPI_SPEC_URL=/path/to/your/openapi.yml
```

### 3. Start the dev server

```bash
pnpm dev
```

The server starts at `http://localhost:3000`.

### 4. Connect your MCP client to the local server

How you connect to the MCP server depends on your client (Claude Code, Cursor, VS Code, etc.). Check your client's docs for where to add MCP servers. Most clients use a similar JSON format. Here's an example for Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "my-api": {
      "type": "http",
      "url": "http://localhost:3000",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

Use whatever headers your API requires. See [Auth](#auth).

## Deploying to Vercel

1. Push this repo to GitHub
2. Import it at [vercel.com/new](https://vercel.com/new)
3. Add `OPENAPI_SPEC_URL` under **Settings > Environment Variables**. The other variables in [Configuration](#configuration) are optional.

That's it. Your MCP server is live at `https://your-project.vercel.app` (or a custom domain like `mcp.example.com`). Connect clients the same way as [local](#4-connect-your-mcp-client-to-the-local-server), just swap the URL.

## Auth

Headers from your MCP client config are forwarded to the target API on every tool call. The MCP server does not validate or store credentials. Your API handles authentication.

Configure whatever headers your API expects in the client config:

```json
// API key auth
"headers": { "X-Api-Key": "<your-key>" }

// Bearer token
"headers": { "Authorization": "Bearer <your-token>" }

// Multiple headers
"headers": { "Authorization": "Bearer <token>", "X-Org-Id": "org_123" }
```
