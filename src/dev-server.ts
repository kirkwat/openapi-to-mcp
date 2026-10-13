import { createServer } from 'node:http';

import { toNodeHandler } from '@modelcontextprotocol/node';

import { handleRequest } from '../api/server.js';
import { getEnv } from './config.js';

const PORT = getEnv().PORT || 3000;

createServer(toNodeHandler({ fetch: handleRequest })).listen(PORT, () => {
  console.log(`MCP server running at http://localhost:${PORT}`);
});
