'use strict';

// WHO is knocking on the public doors.
//
// Written 2026-07-31 after a measurement that could not be completed: the ACP
// feed showed only `/` and `/favicon.ico`, and `/mcp` showed 20 POSTs that
// could not be attributed to ANYONE — the access log carried method, path,
// status and duration, and nothing about the caller. Some of those 20 were our
// own probes. "Is an external agent calling our doors?" was therefore not a
// question the system could answer, which is worse than a bad answer: it looks
// like data.
//
// The raw User-Agent alone does not fix that — it requires a human to squint at
// strings. `caller_class` is the field that makes the question COUNTABLE, so a
// single log query answers "did anything but us call this week".
//
// PRIVACY: headers only, and deliberately NOT the client IP. A key is never
// logged — only whether one was present. This is standard access-log material.

const AI_AGENT_UA = [
  // on-demand answer fetchers — the class that produces grounded citations
  'chatgpt-user', 'oai-searchbot', 'perplexitybot', 'claude-web', 'claude-user',
  // training / bulk crawlers
  'gptbot', 'claudebot', 'anthropic-ai', 'ccbot', 'google-extended',
  'applebot-extended', 'bytespider', 'meta-externalagent',
  // agent runtimes + MCP clients
  'mcp', 'modelcontextprotocol', 'claude-desktop', 'cursor', 'cline',
  'langchain', 'llamaindex', 'openai-python', 'anthropic-sdk',
];

// Our own tooling. Counting these as external traffic is the exact mistake the
// unattributable /mcp hits invited.
const SELF_UA = ['pivota', 'aeo-probe', 'conformance', 'railway', 'curl/', 'python-requests', 'node-fetch', 'undici'];

const SCANNER_PATH = /^\/(\.env|wp-|wap-|admin|phpmyadmin|vendor\/|views\/|template\/|xy\/|zq)/i;

function classifyCaller({ userAgent = '', origin = '', path = '', hasKey = false } = {}) {
  const ua = String(userAgent || '').toLowerCase();
  if (SCANNER_PATH.test(String(path || ''))) return 'scanner';
  if (!ua) return hasKey ? 'unknown_authed' : 'unknown';
  if (AI_AGENT_UA.some((n) => ua.includes(n))) return 'ai_agent';
  // Self checks run AFTER ai_agent: a generic http client is ours, but an
  // agent runtime that happens to embed one is not.
  if (SELF_UA.some((n) => ua.includes(n))) return 'self_tooling';
  if (ua.startsWith('mozilla/')) return origin ? 'browser_app' : 'browser';
  return 'unknown';
}

function describeCaller(req) {
  const h = (req && req.headers) || {};
  const userAgent = String(h['user-agent'] || '');
  const origin = String(h['origin'] || '');
  const hasKey = Boolean(
    h['x-pivota-internal-key'] || h['x-api-key'] || h['authorization'],
  );
  return {
    // truncated: a UA is attacker-controlled free text on a public door
    ua: userAgent ? userAgent.slice(0, 160) : null,
    origin: origin ? origin.slice(0, 120) : null,
    authed: hasKey,
    caller_class: classifyCaller({
      userAgent, origin, path: (req && req.path) || '', hasKey,
    }),
  };
}

module.exports = { classifyCaller, describeCaller, AI_AGENT_UA };
