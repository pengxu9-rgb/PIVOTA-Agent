'use strict';

// The public (auth:none) doors key their rate limit on the client address by the ONE rule the invoke
// limiter uses (gatewayGuardrails clientIpFromRequest), and log only the X-Forwarded-For entry COUNT so the
// trusted-hop default can be confirmed in prod. Route-level behaviour: public_read_client_ip_route.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createForwardedForShapeRecorder, XFF_ENTRIES_CAP } = require('../src/services/publicReadRateLimit');

function captureLog() {
  const lines = [];
  return { lines, log: { info: (obj, msg) => lines.push({ obj, msg }) } };
}

const req = (xff) => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });

test('the XFF shape log carries the entry count and the door, never an address', () => {
  const { lines, log } = captureLog();
  const record = createForwardedForShapeRecorder({ log });
  record(req('198.51.100.7, 203.0.113.9, 34.8.67.235'), 'public_mcp');
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].obj, { event: 'public_read_xff_shape', door: 'public_mcp', xff_entries: 3 });
  const serialized = JSON.stringify(lines);
  for (const ip of ['198.51.100.7', '203.0.113.9', '34.8.67.235']) {
    assert.ok(!serialized.includes(ip), `the log must not carry ${ip}`);
  }
});

test('an absent header and empty entries count as what the parser keys on', () => {
  const { lines, log } = captureLog();
  const record = createForwardedForShapeRecorder({ log });
  record(req(undefined), 'public_mcp');
  record(req(' , 203.0.113.9 ,, 34.8.67.235 '), 'acp_public_feed');
  assert.deepEqual(lines.map((l) => l.obj.xff_entries), [0, 2]);
});

test('each (door, count) logs once per process, so traffic volume never becomes log volume', () => {
  const { lines, log } = captureLog();
  const record = createForwardedForShapeRecorder({ log });
  for (let i = 0; i < 50; i += 1) record(req(`203.0.113.${i}, 34.8.67.235`), 'public_mcp');
  record(req('203.0.113.1, 34.8.67.235'), 'ucp_order_webhook');
  record(req('203.0.113.1'), 'public_mcp');
  assert.deepEqual(
    lines.map((l) => [l.obj.door, l.obj.xff_entries]),
    [
      ['public_mcp', 2],
      ['ucp_order_webhook', 2],
      ['public_mcp', 1],
    ],
  );
});

test('a padded header cannot mint unbounded log lines: counts clamp at the cap', () => {
  const { lines, log } = captureLog();
  const record = createForwardedForShapeRecorder({ log });
  for (let n = 1; n <= 200; n += 1) {
    record(req(Array.from({ length: n }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`).join(',')), 'public_mcp');
  }
  assert.equal(lines.length, XFF_ENTRIES_CAP);
  assert.equal(Math.max(...lines.map((l) => l.obj.xff_entries)), XFF_ENTRIES_CAP);
});

// ---- wiring: one client-IP rule in server.js ----------------------------------------------------------

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('every public-door limiter keys on publicReadMcpClientKey, labelled with its door', () => {
  const calls = [...SERVER_SRC.matchAll(/get(\w+)Limiter\(\)\.allow\(([^)]*\)?)\)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(calls.sort(), [
    ['AcpPublicFeed', "publicReadMcpClientKey(req, 'acp_public_feed')"],
    ['PublicReadMcp', "publicReadMcpClientKey(req, 'public_mcp')"],
    ['UcpOrderWebhook', "publicReadMcpClientKey(req, 'ucp_order_webhook')"],
  ]);
});

test('publicReadMcpClientKey delegates to the shared clientIpFromRequest; server.js parses no XFF itself', () => {
  const body = SERVER_SRC.match(/function publicReadMcpClientKey\(req, door\) \{([\s\S]*?)\n\}/);
  assert.ok(body, 'publicReadMcpClientKey(req, door) exists');
  assert.match(body[1], /return clientIpFromRequest\(req\);/);
  assert.match(SERVER_SRC, /const \{[^}]*\bclientIpFromRequest\b[^}]*\} = require\('\.\/guardrails\/gatewayGuardrails'\)/);
  assert.doesNotMatch(SERVER_SRC, /['"`]x-forwarded-for['"`]/i, 'a second XFF parser in server.js is a second client-IP rule');
  assert.doesNotMatch(SERVER_SRC, /PUBLIC_READ_TRUSTED_PROXIES/, 'the retired hop knob must not come back');
});
