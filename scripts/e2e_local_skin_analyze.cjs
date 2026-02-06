#!/usr/bin/env node

/**
 * E2E (offline) contract runner for POST /v1/analysis/skin
 *
 * - Runs the handler in-memory (no server, no network).
 * - Validates response envelope via Zod.
 * - Prints JSON envelope to stdout.
 *
 * Input: JSON request body on stdin.
 */

const fs = require('fs');
const express = require('express');
const nock = require('nock');

function setDefaultEnv(name, value) {
  if (process.env[name] === undefined) process.env[name] = value;
}

// Make the "available/unavailable" checks deterministic, without ever calling upstream in qc=fail cases.
setDefaultEnv('AURORA_BFF_USE_MOCK', 'false');
setDefaultEnv('AURORA_DECISION_BASE_URL', 'http://127.0.0.1:1');
setDefaultEnv('AURORA_SKIN_VISION_ENABLED', 'true');
setDefaultEnv('OPENAI_API_KEY', 'test_key');

// Ensure photo download is never attempted in our contract cases (qc=fail should gate before fetch).
setDefaultEnv('PIVOTA_BACKEND_BASE_URL', '');
setDefaultEnv('PIVOTA_API_BASE', '');
setDefaultEnv('PIVOTA_BACKEND_AGENT_API_KEY', '');
setDefaultEnv('PIVOTA_API_KEY', '');

// Hard guarantee: do not allow outbound network in this local runner.
// If a test accidentally triggers an upstream call, it should fail fast.
nock.disableNetConnect();
nock.enableNetConnect((host) => String(host || '').startsWith('127.0.0.1') || String(host || '').startsWith('localhost'));

const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
const { V1ResponseEnvelopeSchema } = require('../src/auroraBff/schemas');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function buildDefaultRequestBody() {
  return {
    use_photo: true,
    currentRoutine: {
      am: { cleanser: 'gentle', moisturizer: 'basic', spf: 'spf' },
      pm: { cleanser: 'gentle', moisturizer: 'basic' },
    },
    photos: [{ slot_id: 'front', photo_id: 'synthetic_photo_1', qc_status: 'fail' }],
  };
}

function findPostRouteHandler(app, path) {
  const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
  for (const layer of stack) {
    const route = layer && layer.route ? layer.route : null;
    if (!route || route.path !== path) continue;
    if (!route.methods || !route.methods.post) continue;
    const routeStack = Array.isArray(route.stack) ? route.stack : [];
    const last = routeStack[routeStack.length - 1];
    if (last && typeof last.handle === 'function') return last.handle;
  }
  return null;
}

function buildMockReq({ method, path, headers, body }) {
  const raw = headers && typeof headers === 'object' ? headers : {};
  const headerMap = {};
  for (const [k, v] of Object.entries(raw)) headerMap[String(k).toLowerCase()] = v;

  return {
    method,
    path,
    headers: headerMap,
    body,
    get(name) {
      return headerMap[String(name).toLowerCase()] ?? undefined;
    },
  };
}

function buildMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function main() {
  const raw = readStdin().trim();
  let body = null;
  if (!raw) body = buildDefaultRequestBody();
  else {
    try {
      body = JSON.parse(raw);
    } catch (err) {
      process.stderr.write(`Invalid JSON on stdin: ${err.message}\n`);
      process.exit(2);
      return;
    }
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  mountAuroraBffRoutes(app, { logger });

  const handler = findPostRouteHandler(app, '/v1/analysis/skin');
  if (!handler) {
    process.stderr.write('Failed to locate POST /v1/analysis/skin handler.\n');
    process.exit(5);
    return;
  }

  const req = buildMockReq({
    method: 'POST',
    path: '/v1/analysis/skin',
    headers: { 'X-Aurora-UID': 'test_uid_1', 'X-Lang': 'EN' },
    body,
  });
  const res = buildMockRes();
  await handler(req, res);

  if (res.statusCode !== 200) {
    process.stderr.write(`Unexpected status: ${res.statusCode}\n`);
    process.stderr.write(`${JSON.stringify(res.body || {}, null, 2)}\n`);
    process.exit(3);
    return;
  }

  const parsed = V1ResponseEnvelopeSchema.safeParse(res.body);
  if (!parsed.success) {
    process.stderr.write('Envelope schema validation failed.\n');
    process.stderr.write(`${JSON.stringify(parsed.error, null, 2)}\n`);
    process.exit(4);
    return;
  }

  process.stdout.write(`${JSON.stringify(res.body)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
