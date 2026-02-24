const http = require('http');
const https = require('https');

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isEnabled() {
  const raw = String(process.env.AGENT_AXIOS_KEEPALIVE_ENABLED || '').trim().toLowerCase();
  if (!raw) return true;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

let cachedConfig = null;

function buildConfig() {
  if (!isEnabled()) return {};

  const keepAliveMsecs = parsePositiveInt(process.env.AGENT_AXIOS_KEEPALIVE_MSECS, 60_000, {
    min: 1_000,
    max: 300_000,
  });
  const maxSockets = parsePositiveInt(process.env.AGENT_AXIOS_KEEPALIVE_MAX_SOCKETS, 128, {
    min: 8,
    max: 1024,
  });
  const maxFreeSockets = parsePositiveInt(process.env.AGENT_AXIOS_KEEPALIVE_MAX_FREE_SOCKETS, 32, {
    min: 4,
    max: 256,
  });
  const scheduling = String(process.env.AGENT_AXIOS_KEEPALIVE_SCHEDULING || 'lifo')
    .trim()
    .toLowerCase() === 'fifo'
    ? 'fifo'
    : 'lifo';

  return {
    httpAgent: new http.Agent({
      keepAlive: true,
      keepAliveMsecs,
      maxSockets,
      maxFreeSockets,
      scheduling,
    }),
    httpsAgent: new https.Agent({
      keepAlive: true,
      keepAliveMsecs,
      maxSockets,
      maxFreeSockets,
      scheduling,
    }),
  };
}

function getAxiosKeepAliveConfig() {
  if (!cachedConfig) cachedConfig = buildConfig();
  return cachedConfig;
}

module.exports = {
  getAxiosKeepAliveConfig,
};
