'use strict';

/*
 * The probe's IO layer, exit codes and end-to-end verdict — driven against real HTTP servers.
 *
 * WHY SEPARATE. The evaluator tests cover the pure functions exhaustively; review pointed out that every
 * remaining gap lived in `run()`/`main()`/`fetch`, and not one line of that was under test. That is the
 * usual shape of a false green: the part that is easy to test is tested, the part that talks to the world
 * is asserted in prose. These spawn the real script as a child process against a real server and assert the
 * exit code a cron will branch on.
 *
 * THE CONTRACT UNDER TEST — a pager must be able to tell these apart:
 *   0  every invariant held
 *   1  the SURFACE is wrong (including "the profile 500s" — that is an outage, not a broken probe)
 *   2  the PROBE could not run (bad arguments, nothing listening)
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'probe-ucp-conformance.cjs');

/** Run the probe as a child process and capture {code, stdout}. Never throws on a non-zero exit. */
function probe(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const close = (s) => new Promise((r) => s.close(r));

/** A conformant profile pointing its single door at this same origin. */
function conformantProfile(base, over = {}) {
  return {
    ucp: {
      version: require('../safety-kernel/src/protocol/ucpSpecVersion.cjs').UCP_SPEC_VERSION,
      services: { 'dev.ucp.shopping': [{ transport: 'mcp', endpoint: `${base}/ucp/mcp` }] },
      capabilities: { 'dev.ucp.shopping.checkout': [{ version: '2026-04-08' }] },
      payment_handlers: {},
      ...(over.ucp || {}),
    },
    signing_keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k' }],
  };
}

/** A surface that behaves correctly end to end: profile, a door that 401s, matching metadata, intersection. */
function healthyHandler(getBase) {
  return (req, res) => {
    const base = getBase();
    const json = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/.well-known/ucp') return json(200, conformantProfile(base));
    if (req.url === '/ucp/mcp') {
      return json(401, { error: 'UNAUTHORIZED' }, {
        'www-authenticate': `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/ucp/mcp"`,
      });
    }
    if (req.url === '/.well-known/oauth-protected-resource/ucp/mcp') {
      return json(200, { resource: `${base}/ucp/mcp`, authorization_servers: ['https://api.pivota.cc'] });
    }
    if (req.url === '/ucp/capabilities') {
      return json(200, { active_capabilities: [{ id: 'dev.ucp.shopping.checkout' }] });
    }
    return json(404, { error: 'not_found' });
  };
}

describe('end-to-end: a healthy surface passes', () => {
  let ctx;
  before(async () => { ctx = await serve(healthyHandler(() => ctx.base)); });
  after(async () => { await close(ctx.server); });

  test('exit 0, PASS, and the door round trip is reported', async () => {
    const r = await probe(['--base', ctx.base]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS/);
    assert.match(r.stdout, /declares http:\/\/127\.0\.0\.1:\d+\/ucp\/mcp/);
  });

  test('--json emits a parseable document with status pass', async () => {
    const r = await probe(['--base', ctx.base, '--json']);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.status, 'pass');
    assert.equal(doc.ok, true);
    assert.equal(doc.findings.length, 0);
  });
});

describe('exit 1 — the SURFACE is wrong (never 2, which a cron may treat as retryable)', () => {
  test('the profile 500s persistently', async () => {
    const { server, base } = await serve((req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"e":1}'); });
    const r = await probe(['--base', base]);
    await close(server);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /P1_PROFILE_UNAVAILABLE/);
  });

  test('the profile REDIRECTS (#1989 — a redirected document is not the document)', async () => {
    const { server, base } = await serve((req, res) => { res.writeHead(302, { location: 'https://example.com/x' }); res.end(); });
    const r = await probe(['--base', base]);
    await close(server);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /P8_PROFILE_REDIRECTED/);
  });

  test('the profile is 200 but not JSON', async () => {
    const { server, base } = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hi</html>'); });
    const r = await probe(['--base', base]);
    await close(server);
    assert.equal(r.code, 1, r.stdout);
  });

  test('a DARK surface fails by default and passes with --allow-dark', async () => {
    const handler = (req, res) => {
      if (req.url !== '/.well-known/ucp') { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ucp: { version: '2026-04-08', services: {}, capabilities: {}, payment_handlers: {} }, signing_keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k' }] }));
    };
    const { server, base } = await serve(handler);
    const dark = await probe(['--base', base]);
    const allowed = await probe(['--base', base, '--allow-dark']);
    await close(server);
    assert.equal(dark.code, 1, dark.stdout);
    assert.match(dark.stdout, /P9_SURFACE_DARK/);
    assert.equal(allowed.code, 0, allowed.stdout);
  });

  test('an ADVERTISED door that 404s fails, and the profile findings are not discarded with it', async () => {
    let ctxBase = '';
    const { server, base } = await serve((req, res) => {
      if (req.url === '/.well-known/ucp') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(conformantProfile(ctxBase)));
      }
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
    });
    ctxBase = base;
    const r = await probe(['--base', base, '--json']);
    await close(server);
    assert.equal(r.code, 1, r.stdout);
    const doc = JSON.parse(r.stdout);
    // The door failed, AND the report still carries what was learned before it.
    assert.ok(doc.findings.some((f) => f.code === 'P4_ADVERTISED_DOOR_404'));
    assert.equal(doc.profile.version, require('../safety-kernel/src/protocol/ucpSpecVersion.cjs').UCP_SPEC_VERSION);
  });
});

describe('exit 2 — the PROBE could not run', () => {
  test('nothing listening', async () => {
    const r = await probe(['--base', 'http://127.0.0.1:1']);
    assert.equal(r.code, 2, r.stdout + r.stderr);
  });
  test('a missing --base value is a broken invocation, not a conformance verdict', async () => {
    const r = await probe(['--base']);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /could not run/);
  });
  test('an unknown flag', async () => {
    const r = await probe(['--nope']);
    assert.equal(r.code, 2);
  });
  test('--json still emits a parseable document when blocked', async () => {
    const r = await probe(['--base', 'http://127.0.0.1:1', '--json']);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.status, 'blocked');
    assert.equal(doc.ok, false);
  });
});

describe('the retry actually retries (a single transient 5xx must not page anyone)', () => {
  test('one 503 then a healthy profile still passes', async () => {
    let hits = 0;
    let ctxBase = '';
    const { server, base } = await serve((req, res) => {
      if (req.url === '/.well-known/ucp') {
        hits += 1;
        if (hits === 1) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"e":1}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(conformantProfile(ctxBase)));
      }
      return healthyHandler(() => ctxBase)(req, res);
    });
    ctxBase = base;
    const r = await probe(['--base', base]);
    await close(server);
    assert.ok(hits >= 2, `expected a retry, saw ${hits} request(s)`);
    assert.equal(r.code, 0, r.stdout);
  });
});
