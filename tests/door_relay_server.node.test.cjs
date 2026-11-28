'use strict';

// The merchant door relay SERVICE (src/services/doorRelay/server.js). What is pinned, and why:
//   - it opens a socket only for https on 443, to a public name or literal, with DNS resolved HERE through the
//     public-only lookup (a name that rebinds to a private address cannot pivot into the relay's VPC);
//   - a 3xx goes back to the caller, Location and all; the relay never follows one;
//   - the response cap is the transport's 2 MB;
//   - the merchant's header list reaches the upstream byte for byte, in order; the relay hop's own Authorization does
//     not, and a list that carries it is refused;
//   - a log line names the host, never the path, the query, a header or a body;
//   - it reads no environment beyond PORT and its own numeric caps (it holds no secret).
//
// No test reaches a real host: the upstream is node:https.request replaced by a fake (the real
// createPublicNetworkFetch runs on top of it), or an injected resolver that answers private addresses and so refuses
// before any connect. The relay itself listens on 127.0.0.1.

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const nodeHttps = require('node:https');
const { EventEmitter } = require('node:events');

const SERVER_PATH = path.join(__dirname, '..', 'src', 'services', 'doorRelay', 'server.js');
const { createDoorRelayHandler, configFromEnv } = require(SERVER_PATH);

const PUBLIC_LOOKUP = (_host, _opts, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]);

// A fake upstream under the REAL transport: node:https.request is swapped for an emitter that records what the
// transport handed it and answers with `reply`.
function installFakeUpstream() {
  const real = nodeHttps.request;
  const calls = [];
  let reply = { status: 200, headers: { 'content-type': 'application/json' }, chunks: [Buffer.from('{"ok":true}')] };
  nodeHttps.request = (url, opts, onResponse) => {
    const request = new EventEmitter();
    const written = [];
    const call = { url: String(url), hostname: url.hostname, method: opts.method, headers: opts.headers, lookup: opts.lookup, written };
    calls.push(call);
    request.write = (chunk) => { written.push(Buffer.from(chunk)); return true; };
    request.destroy = (err) => { call.destroyed = true; if (err) request.emit('error', err); };
    request.end = () => {
      process.nextTick(() => {
        if (reply.error) { request.emit('error', reply.error); return; }
        const response = new EventEmitter();
        response.statusCode = reply.status;
        response.headers = reply.headers;
        response.resume = () => {};
        onResponse(response);
        for (const chunk of reply.chunks) {
          if (call.destroyed) return;
          response.emit('data', chunk);
        }
        if (!call.destroyed) response.emit('end');
      });
    };
    return request;
  };
  return {
    calls,
    setReply(next) { reply = next; },
    restore() { nodeHttps.request = real; },
  };
}

async function startRelay(options) {
  const lines = [];
  const handler = createDoorRelayHandler({ log: (entry) => lines.push({ ...entry }), ...options });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    lines,
    base,
    async call(payload, { authorization = 'Bearer relay-hop-id-token' } = {}) {
      const res = await fetch(`${base}/v1/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      });
      return { status: res.status, json: await res.json() };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('door relay service', () => {
  let upstream;
  let relay;
  before(async () => { relay = await startRelay({ lookup: PUBLIC_LOOKUP }); });
  after(async () => { await relay.close(); });
  beforeEach(() => { upstream = installFakeUpstream(); relay.lines.length = 0; });
  afterEach(() => { upstream.restore(); });

  test('GET /healthz answers 200', async () => {
    const res = await fetch(`${relay.base}/healthz`);
    assert.equal(res.status, 200);
  });

  test('refuses http:// with a coded error and opens nothing', async () => {
    const { status, json } = await relay.call({ url: 'http://merchant.example/.well-known/ucp', method: 'GET' });
    assert.equal(status, 403);
    assert.equal(json.error_code, 'PIVOTA_RELAY_SCHEME');
    assert.equal(upstream.calls.length, 0);
  });

  test('refuses any port but 443 (an explicit :443 is the default and passes)', async () => {
    const refused = await relay.call({ url: 'https://merchant.example:8443/x', method: 'GET' });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error_code, 'PIVOTA_RELAY_PORT');
    assert.equal(upstream.calls.length, 0);
    const ok = await relay.call({ url: 'https://merchant.example:443/x', method: 'GET' });
    assert.equal(ok.status, 200);
    assert.equal(upstream.calls.length, 1);
  });

  for (const literal of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '[::1]', '[::ffff:169.254.169.254]', '192.168.0.7']) {
    test(`refuses the private literal ${literal}`, async () => {
      const { status, json } = await relay.call({ url: `https://${literal}/x`, method: 'GET' });
      assert.equal(status, 403);
      assert.equal(json.error_code, 'PIVOTA_SSRF_LITERAL');
      assert.equal(upstream.calls.length, 0);
    });
  }

  for (const name of ['metadata.google.internal', 'metadata.google.internal.', 'svc.cluster.local', 'service-abc.a.run.app', 'x.127.0.0.1.nip.io']) {
    test(`refuses the never-a-merchant name ${name}`, async () => {
      const { status, json } = await relay.call({ url: `https://${name}/computeMetadata/v1/`, method: 'GET' });
      assert.equal(status, 403);
      assert.equal(json.error_code, 'PIVOTA_SSRF_NAME');
      assert.equal(upstream.calls.length, 0);
    });
  }

  test('refuses methods other than GET and POST, userinfo, and a GET with a body', async () => {
    const put = await relay.call({ url: 'https://merchant.example/x', method: 'PUT' });
    assert.equal(put.json.error_code, 'PIVOTA_RELAY_METHOD');
    const userinfo = await relay.call({ url: 'https://user:pw@merchant.example/x', method: 'GET' });
    assert.equal(userinfo.json.error_code, 'PIVOTA_RELAY_BAD_REQUEST');
    const getBody = await relay.call({ url: 'https://merchant.example/x', method: 'GET', body_b64: Buffer.from('x').toString('base64') });
    assert.equal(getBody.json.error_code, 'PIVOTA_RELAY_BAD_REQUEST');
    const notJson = await relay.call('{nope');
    assert.equal(notJson.json.error_code, 'PIVOTA_RELAY_BAD_REQUEST');
    assert.equal(upstream.calls.length, 0);
  });

  test('the real transport resolves through the public-only lookup (the hook it hands node:https)', async () => {
    await relay.call({ url: 'https://merchant.example/x', method: 'GET' });
    assert.equal(upstream.calls.length, 1);
    assert.equal(typeof upstream.calls[0].lookup, 'function');
    const answer = await new Promise((resolve) => {
      upstream.calls[0].lookup('merchant.example', { all: true }, (err, addrs) => resolve({ err, addrs }));
    });
    assert.equal(answer.err, null);
    assert.deepEqual(answer.addrs, [{ address: '8.8.8.8', family: 4 }]);
  });

  test('does not follow a 302: it returns the status and Location to the caller', async () => {
    upstream.setReply({ status: 302, headers: { location: 'https://elsewhere.example/next' }, chunks: [] });
    const { status, json } = await relay.call({ url: 'https://merchant.example/.well-known/ucp', method: 'GET' });
    assert.equal(status, 200);
    assert.equal(json.status, 302);
    assert.deepEqual(json.headers.find(([n]) => n === 'location'), ['location', 'https://elsewhere.example/next']);
    assert.equal(upstream.calls.length, 1, 'exactly one upstream request: the redirect target is never contacted');
  });

  test('caps the response at 2 MB with the transport\'s own code', async () => {
    const mb = Buffer.alloc(1024 * 1024);
    upstream.setReply({ status: 200, headers: {}, chunks: [mb, mb, Buffer.alloc(1)] });
    const { status, json } = await relay.call({ url: 'https://merchant.example/big', method: 'GET' });
    assert.equal(status, 502);
    assert.equal(json.error_code, 'PIVOTA_SIZE_CAP');
    assert.equal(upstream.calls[0].destroyed, true);
  });

  test('forwards a signed request\'s headers byte for byte, in order, and the body exactly', async () => {
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_cart"}}';
    const signed = [
      ['Content-Type', 'application/json'],
      ['Accept', 'application/json, text/event-stream'],
      ['UCP-Agent', 'profile="https://agent.example/.well-known/ucp-agent"'],
      ['Content-Digest', 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:'],
      ['Signature-Input', 'sig1=("@method" "@authority" "@path" "content-digest" "ucp-agent");created=1700000000;keyid="test-key";alg="ecdsa-p256-sha256"'],
      ['Signature', 'sig1=:MEUCIQDtest0signature0bytes0only0for0a0fixtureAAAAAAAAAAiBtest0more0bytes0AAAA=:'],
      ['Authorization', 'Bearer merchant-tier-token-fixture'],
    ];
    const { status, json } = await relay.call({
      url: 'https://merchant.example/api/ucp/mcp?shop=1',
      method: 'POST',
      headers: [...signed, ['Connection', 'keep-alive'], ['Host', 'other.example'], ['Transfer-Encoding', 'chunked']],
      body_b64: Buffer.from(body).toString('base64'),
    });
    assert.equal(status, 200);
    assert.equal(json.status, 200);
    const call = upstream.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.hostname, 'merchant.example');
    assert.deepEqual(Object.entries(call.headers), signed, 'same names, same case, same values, same order; hop-by-hop dropped');
    assert.equal(Buffer.concat(call.written).toString('utf8'), body);
  });

  test('the relay hop\'s own Authorization never reaches the merchant, and a list carrying it is refused', async () => {
    await relay.call({ url: 'https://merchant.example/x', method: 'GET', headers: [['accept', '*/*']] });
    const sent = Object.keys(upstream.calls[0].headers).map((n) => n.toLowerCase());
    assert.deepEqual(sent, ['accept']);
    const copied = await relay.call({
      url: 'https://merchant.example/x', method: 'GET', headers: [['Authorization', 'Bearer relay-hop-id-token']],
    });
    assert.equal(copied.status, 400);
    assert.equal(copied.json.error_code, 'PIVOTA_RELAY_BAD_REQUEST');
    assert.equal(upstream.calls.length, 1);
    const xsa = await relay.call({
      url: 'https://merchant.example/x', method: 'GET', headers: [['X-Serverless-Authorization', 'Bearer z']],
    });
    assert.equal(xsa.status, 200);
    assert.deepEqual(Object.keys(upstream.calls[1].headers), []);
  });

  test('a log line carries method, host, status, bytes, ms and error_code; never the path, query, headers or body', async () => {
    const secretPath = '/checkout/continue-token-abc123';
    const secretQuery = 'key=query-secret-xyz';
    const secretHeader = 'header-secret-value-q9';
    const secretBody = 'body-secret-value-p7';
    upstream.setReply({ status: 201, headers: { 'x-echo': 'resp-header-secret' }, chunks: [Buffer.from('resp-body-secret')] });
    await relay.call({
      url: `https://merchant.example${secretPath}?${secretQuery}`,
      method: 'POST',
      headers: [['X-Thing', secretHeader]],
      body_b64: Buffer.from(secretBody).toString('base64'),
    });
    await relay.call({ url: `https://10.0.0.1${secretPath}?${secretQuery}`, method: 'GET' });
    assert.equal(relay.lines.length, 2);
    assert.deepEqual(Object.keys(relay.lines[0]).sort(), ['bytes', 'error_code', 'event', 'host', 'method', 'ms', 'severity', 'status'].sort());
    assert.equal(relay.lines[0].host, 'merchant.example');
    assert.equal(relay.lines[0].method, 'POST');
    assert.equal(relay.lines[0].status, 201);
    assert.equal(relay.lines[0].bytes, Buffer.byteLength('resp-body-secret'));
    assert.equal(relay.lines[0].error_code, null);
    assert.equal(relay.lines[1].error_code, 'PIVOTA_SSRF_LITERAL');
    const text = JSON.stringify(relay.lines);
    for (const s of [secretPath, 'continue-token', secretQuery, secretHeader, secretBody, 'resp-header-secret', 'resp-body-secret', 'relay-hop-id-token']) {
      assert.equal(text.includes(s), false, `log carries ${s}`);
    }
  });

  test('a forwarded value carrying the relay token is refused under any name, case or scheme, merged or not', async () => {
    const lists = [
      [['X-Forwarded-Token', 'relay-hop-id-token']],
      [['authorization', 'bearer relay-hop-id-token']],
      [['AUTHORIZATION', 'Token relay-hop-id-token']],
      [['X-A', 'harmless'], ['x-a', 'prefix relay-hop-id-token suffix']],
      [['Cookie', 'sid=relay-hop-id-token']],
    ];
    for (const headers of lists) {
      const { status, json } = await relay.call({ url: 'https://merchant.example/x', method: 'GET', headers });
      assert.equal(status, 400, JSON.stringify(headers));
      assert.equal(json.error_code, 'PIVOTA_RELAY_BAD_REQUEST');
    }
    // A bare "Bearer" scheme on the inbound side is searched for as the raw token too.
    const raw = await relay.call({ url: 'https://merchant.example/x', method: 'GET', headers: [['X-T', 'abc relay-hop-id-token']] },
      { authorization: 'relay-hop-id-token' });
    assert.equal(raw.status, 400);
    // In the URL or the body it is refused as well.
    const inQuery = await relay.call({ url: 'https://merchant.example/x?t=relay-hop-id-token', method: 'GET' });
    assert.equal(inQuery.json.error_code, 'PIVOTA_RELAY_BAD_REQUEST');
    const inBody = await relay.call({
      url: 'https://merchant.example/x', method: 'POST', body_b64: Buffer.from('{"t":"relay-hop-id-token"}').toString('base64'),
    });
    assert.equal(inBody.json.error_code, 'PIVOTA_RELAY_BAD_REQUEST');
    assert.equal(upstream.calls.length, 0, 'nothing carrying the token went out');
  });

  test('Content-Length is sent once when duplicates match the body; a mismatching one is dropped', async () => {
    const body = Buffer.from('hello').toString('base64');
    await relay.call({
      url: 'https://merchant.example/x', method: 'POST', body_b64: body,
      headers: [['Content-Length', '5'], ['content-length', '5'], ['X-Other', 'a'], ['x-other', 'b']],
    });
    assert.deepEqual(Object.entries(upstream.calls[0].headers), [['Content-Length', '5'], ['X-Other', 'a, b']]);
    await relay.call({ url: 'https://merchant.example/x', method: 'POST', body_b64: body, headers: [['Content-Length', '7']] });
    assert.deepEqual(Object.entries(upstream.calls[1].headers), []);
  });

  test('an upstream network error comes back with its errno code, and a fixed message', async () => {
    const err = new Error('connect ECONNREFUSED to some address');
    err.code = 'ECONNREFUSED';
    upstream.setReply({ error: err });
    const { status, json } = await relay.call({ url: 'https://merchant.example/x', method: 'GET' });
    assert.equal(status, 502);
    assert.equal(json.error_code, 'ECONNREFUSED');
    assert.equal(json.message.includes('merchant.example'), false);
  });
});

describe('door relay service: DNS and time caps', () => {
  test('a name that resolves to a private address is refused before any connect', async () => {
    const relay = await startRelay({ lookup: (_h, _o, cb) => cb(null, [{ address: '10.20.30.40', family: 4 }]) });
    try {
      const { status, json } = await relay.call({ url: 'https://rebind.example/x', method: 'GET' });
      assert.equal(status, 403);
      assert.equal(json.error_code, 'PIVOTA_SSRF_REFUSED');
    } finally { await relay.close(); }
  });

  test('a mixed public/private answer is refused too', async () => {
    const relay = await startRelay({
      lookup: (_h, _o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]),
    });
    try {
      const { json } = await relay.call({ url: 'https://rebind.example/x', method: 'GET' });
      assert.equal(json.error_code, 'PIVOTA_SSRF_REFUSED');
    } finally { await relay.close(); }
  });

  const hangingTransport = (seen) => (_url, init) => new Promise((_resolve, reject) => {
    seen.signal = init.signal;
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });

  test('the caller\'s timeout_ms is the call\'s cap', async () => {
    const seen = {};
    const relay = await startRelay({ maxTimeoutMs: 10_000, transport: hangingTransport(seen) });
    try {
      const started = Date.now();
      const { status, json } = await relay.call({ url: 'https://slow.example/x', method: 'GET', timeout_ms: 40 });
      assert.equal(status, 504);
      assert.equal(json.error_code, 'PIVOTA_RELAY_TIMEOUT');
      assert.ok(Date.now() - started < 5_000, 'stopped at the caller budget, not the ceiling');
      assert.equal(seen.signal.aborted, true);
    } finally { await relay.close(); }
  });

  test('a timeout_ms above the ceiling is held to the ceiling; a malformed one is refused', async () => {
    const seen = {};
    const relay = await startRelay({ maxTimeoutMs: 40, transport: hangingTransport(seen) });
    try {
      const started = Date.now();
      const capped = await relay.call({ url: 'https://slow.example/x', method: 'GET', timeout_ms: 600_000 });
      assert.equal(capped.json.error_code, 'PIVOTA_RELAY_TIMEOUT');
      assert.ok(Date.now() - started < 5_000);
      for (const bad of [0, -1, 1.5, '100']) {
        const { status, json } = await relay.call({ url: 'https://slow.example/x', method: 'GET', timeout_ms: bad });
        assert.equal(status, 400, String(bad));
        assert.equal(json.error_code, 'PIVOTA_RELAY_BAD_REQUEST');
      }
    } finally { await relay.close(); }
  });

  test('the default ceiling is 30 s, above the buyer client\'s 15 s default budget', () => {
    const { DEFAULT_MAX_TIMEOUT_MS } = require(SERVER_PATH);
    assert.equal(DEFAULT_MAX_TIMEOUT_MS, 30_000);
  });

  test('a caller that hangs up aborts the upstream request', async () => {
    const seen = {};
    const relay = await startRelay({ transport: hangingTransport(seen) });
    try {
      const ac = new AbortController();
      const pending = fetch(`${relay.base}/v1/fetch`, {
        method: 'POST', body: JSON.stringify({ url: 'https://slow.example/x', method: 'GET' }), signal: ac.signal,
      }).catch((e) => e);
      for (let i = 0; i < 100 && !seen.signal; i += 1) await new Promise((r) => setTimeout(r, 5));
      ac.abort();
      await pending;
      for (let i = 0; i < 100 && !seen.signal.aborted; i += 1) await new Promise((r) => setTimeout(r, 5));
      assert.equal(seen.signal.aborted, true);
      for (let i = 0; i < 100 && !relay.lines.length; i += 1) await new Promise((r) => setTimeout(r, 5));
      assert.equal(relay.lines[0].error_code, 'PIVOTA_RELAY_CALLER_GONE');
    } finally { await relay.close(); }
  });

  test('the total time cap answers PIVOTA_RELAY_TIMEOUT and aborts the upstream', async () => {
    let seenSignal = null;
    const relay = await startRelay({
      maxTimeoutMs: 50,
      transport: (_url, init) => new Promise((_resolve, reject) => {
        seenSignal = init.signal;
        init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      }),
    });
    try {
      const { status, json } = await relay.call({ url: 'https://slow.example/x', method: 'GET' });
      assert.equal(status, 504);
      assert.equal(json.error_code, 'PIVOTA_RELAY_TIMEOUT');
      assert.equal(seenSignal.aborted, true);
    } finally { await relay.close(); }
  });

  test('a request body over the cap is refused', async () => {
    const relay = await startRelay({ maxBodyBytes: 16, transport: async () => { throw new Error('not reached'); } });
    try {
      const { status, json } = await relay.call({
        url: 'https://merchant.example/x', method: 'POST', body_b64: Buffer.alloc(64).toString('base64'),
      });
      assert.equal(status, 413);
      assert.equal(json.error_code, 'PIVOTA_RELAY_REQUEST_TOO_LARGE');
    } finally { await relay.close(); }
  });
});

describe('door relay service reads no secret', () => {
  const ALLOWED_ENV = ['PORT', 'DOOR_RELAY_MAX_TIMEOUT_MS', 'DOOR_RELAY_MAX_BODY_BYTES'];

  test('its source names only PORT and its own numeric caps', () => {
    const source = fs.readFileSync(SERVER_PATH, 'utf8');
    const uses = source.match(/process\.env\b[^\n]{0,40}/g) || [];
    const named = [];
    for (const use of uses) {
      const m = /^process\.env\.([A-Z0-9_]+)\b/.exec(use);
      assert.ok(m, `process.env read in a form this test cannot name: ${use}`);
      named.push(m[1]);
    }
    assert.ok(named.length > 0);
    for (const name of named) assert.ok(ALLOWED_ENV.includes(name), `server.js reads ${name}`);
    assert.equal(/\benv\s*\[/.test(source), false, 'no computed env read');
    assert.equal(/require\(['"][^'"]*logger['"]\)/.test(source), false, 'no gateway logger (it reads LOG_LEVEL)');
  });

  test('at run time, loading it and serving calls reads no env key outside the allowlist from repo code', async () => {
    const repoSrc = path.join(__dirname, '..', 'src') + path.sep;
    const read = new Set();
    const realEnv = process.env;
    const fakeSecrets = { ...realEnv, UCP_AGENT_CREDENTIAL: 'x', UCP_AGENT_CLIENT_SECRET: 'x', MERCHANT_DOOR_RELAY: 'on' };
    process.env = new Proxy(fakeSecrets, {
      get(target, key) {
        if (typeof key === 'string' && (new Error().stack || '').includes(repoSrc)) read.add(key);
        return target[key];
      },
    });
    const upstream = installFakeUpstream();
    let relay;
    try {
      for (const id of Object.keys(require.cache)) if (id.startsWith(repoSrc)) delete require.cache[id];
      const fresh = require(SERVER_PATH);
      const config = fresh.configFromEnv();
      assert.equal(config.maxTimeoutMs > 0, true);
      const lines = [];
      const server = http.createServer(fresh.createDoorRelayHandler({ lookup: PUBLIC_LOOKUP, log: (l) => lines.push(l) }));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      relay = { close: () => new Promise((resolve) => server.close(resolve)), base: `http://127.0.0.1:${server.address().port}` };
      for (const payload of [
        { url: 'https://merchant.example/x', method: 'POST', headers: [['a', 'b']], body_b64: 'eA==' },
        { url: 'https://10.0.0.1/x', method: 'GET' },
        { url: 'http://merchant.example/x', method: 'GET' },
      ]) {
        const res = await fetch(`${relay.base}/v1/fetch`, { method: 'POST', body: JSON.stringify(payload) });
        await res.text();
      }
      assert.equal(lines.length, 3);
    } finally {
      process.env = realEnv;
      upstream.restore();
      if (relay) await relay.close();
    }
    // The probe works: the one read we expect was seen.
    assert.ok(read.has('PORT'), 'the env probe saw configFromEnv read PORT');
    for (const key of read) assert.ok(ALLOWED_ENV.includes(key), `the relay read process.env.${key}`);
  });

  test('configFromEnv falls back to the defaults on non-numeric caps', () => {
    const saved = { PORT: process.env.PORT, T: process.env.DOOR_RELAY_MAX_TIMEOUT_MS };
    try {
      process.env.PORT = 'not-a-port';
      process.env.DOOR_RELAY_MAX_TIMEOUT_MS = '-5';
      const config = configFromEnv();
      assert.equal(config.port, 8080);
      assert.equal(config.maxTimeoutMs, 30000);
    } finally {
      if (saved.PORT === undefined) delete process.env.PORT; else process.env.PORT = saved.PORT;
      if (saved.T === undefined) delete process.env.DOOR_RELAY_MAX_TIMEOUT_MS; else process.env.DOOR_RELAY_MAX_TIMEOUT_MS = saved.T;
    }
  });
});
