'use strict';

// The one search-query length limit, shared by the invoke route (queryLengthCap.js) and the MCP tool
// surface (mcp-server/src/commerceToolSurface.js). No dependencies, so the MCP server can load it.

const DEFAULT_MAX_CHARS = 500;

function resolveSearchQueryMaxChars(env = process.env) {
  const n = Number.parseInt(String(env.SEARCH_QUERY_MAX_CHARS || ''), 10);
  return Number.isFinite(n) && n >= 50 ? n : DEFAULT_MAX_CHARS;
}

module.exports = { DEFAULT_MAX_CHARS, resolveSearchQueryMaxChars };
