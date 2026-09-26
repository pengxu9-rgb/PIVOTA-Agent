'use strict';

// The heartbeat exists because Railway's edge resets any response whose first BODY byte arrives later than
// ~13s (measured 2026-08-04; headers alone don't stop the clock). Its failure modes are (a) never
// committing — the cold-search kill comes back, and (b) committing but corrupting the body — every client
// breaks. So we assert both the timing protocol (fake timers) and the real bytes on the wire (real server).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createMcpResponseHeartbeat } = require('../src/services/publicReadMcpHeartbeat');

// -- fake-timer harness ------------------------------------------------------------------------------------

function fakeTimers() {
  let seq = 0;
  const pending = new Map(); // id -> { fn, kind }
  return {
    setTimeout(fn) { const id = ++seq; pending.set(id, { fn, kind: 'timeout' }); return id; },
    clearTimeout(id) { pending.delete(id); },
    setInterval(fn) { const id = ++seq; pending.set(id, { fn, kind: 'interval' }); return id; },
    clearInterval(id) { pending.delete(id); },
    fire(kind) {
      for (const [id, t] of [...pending]) {
        if (t.kind !== kind) continue;
        if (kind === 'timeout') pending.delete(id);
        t.fn();
      }
    },
    count(kind) { return [...pending.values()].filter((t) => t.kind === kind).length; },
  };
}

function fakeRes() {
  return {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    written: [],
    head: null,
    writeHead(status, headers) { this.headersSent = true; this.head = { status, headers }; },
    write(chunk) { this.written.push(String(chunk)); },
    end(chunk) { if (chunk != null) this.written.push(String(chunk)); this.writableEnded = true; },
  };
}

// -- timing protocol ---------------------------------------------------------------------------------------

test('fast path: finish before the delay fires never touches res', () => {
  const timers = fakeTimers();
  const res = fakeRes();
  const hb = createMcpResponseHeartbeat(res, { timers });
  assert.equal(hb.finish({ status: 200, body: { ok: true } }), false);
  timers.fire('timeout'); // a late timer firing after stop() must be inert
  assert.equal(res.headersSent, false);
  assert.deepEqual(res.written, []);
  assert.equal(timers.count('interval'), 0);
});

test('slow path: delay commits 200 + first body byte, interval keeps writing, finish appends the JSON', () => {
  const timers = fakeTimers();
  const res = fakeRes();
  const hb = createMcpResponseHeartbeat(res, { timers });
  timers.fire('timeout');
  assert.equal(hb.committed(), true);
  assert.equal(res.head.status, 200);
  assert.match(res.head.headers['Content-Type'], /application\/json/);
  assert.deepEqual(res.written, ['\n']); // the first body byte goes out WITH the commit, not an interval later
  timers.fire('interval');
  timers.fire('interval');
  assert.equal(hb.finish({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }), true);
  assert.equal(res.writableEnded, true);
  assert.equal(timers.count('interval'), 0);
  // The wire total must still parse as the JSON-RPC body — leading whitespace only.
  const parsed = JSON.parse(res.written.join(''));
  assert.equal(parsed.jsonrpc, '2.0');
});

test('slow path failure: fail() delivers a JSON-RPC error body on the committed 200 wire', () => {
  const timers = fakeTimers();
  const res = fakeRes();
  const hb = createMcpResponseHeartbeat(res, { timers });
  timers.fire('timeout');
  const errorBody = { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error.' } };
  assert.equal(hb.fail(errorBody), true);
  assert.equal(JSON.parse(res.written.join('')).error.code, -32603);
});

test('uncommitted failure: fail() returns false so the caller can send its own 503', () => {
  const timers = fakeTimers();
  const res = fakeRes();
  const hb = createMcpResponseHeartbeat(res, { timers });
  assert.equal(hb.fail({ error: {} }), false);
  assert.equal(res.headersSent, false);
});

test('disabled: never commits no matter how long compute runs', () => {
  const timers = fakeTimers();
  const res = fakeRes();
  const hb = createMcpResponseHeartbeat(res, { enabled: false, timers });
  timers.fire('timeout');
  assert.equal(hb.committed(), false);
  assert.equal(hb.finish({ status: 200, body: {} }), false);
  assert.equal(res.headersSent, false);
});

test('client already gone: commit and writes are skipped, finish still reports committed=false', () => {
  const timers = fakeTimers();
  const res = fakeRes();
  res.destroyed = true;
  const hb = createMcpResponseHeartbeat(res, { timers });
  timers.fire('timeout');
  assert.equal(hb.committed(), false);
  assert.equal(res.headersSent, false);
});

test('headers already sent by another path: commit backs off', () => {
  const timers = fakeTimers();
  const res = fakeRes();
  res.headersSent = true;
  const hb = createMcpResponseHeartbeat(res, { timers });
  timers.fire('timeout');
  assert.equal(hb.committed(), false);
  assert.deepEqual(res.written, []);
});

// -- real wire ---------------------------------------------------------------------------------------------

test('real HTTP server: heartbeated slow response reaches the client as parseable JSON', async () => {
  const server = http.createServer((req, res) => {
    const hb = createMcpResponseHeartbeat(res, { delayMs: 30, intervalMs: 20 });
    setTimeout(() => {
      const handled = hb.finish({ status: 200, body: { jsonrpc: '2.0', id: 7, result: { hello: 'world' } } });
      assert.equal(handled, true); // 150ms compute vs 30ms delay: the heartbeat MUST have committed
    }, 150);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const { status, text } = await new Promise((resolve, reject) => {
      const req = http.request(
        { port: server.address().port, method: 'POST', path: '/mcp' },
        (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 200);
    assert.match(text, /^\n/); // heartbeat bytes really preceded the body
    const parsed = JSON.parse(text);
    assert.equal(parsed.result.hello, 'world');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
