'use strict';
// The loopback-only test network guard (tests/_support/netGuard.cjs) is what stops every
// other suite from reaching the internet, so it gets its own falsifiable tests: each block
// path is driven through the transport real code uses (net, tls, http, fetch, dns), each
// allowance is proven with a real loopback listener, and the two "fail loudly" mechanisms
// (node:test exit code, jest hooks) are proven end to end in child processes.
//
// Non-loopback targets are TEST-NET-1 (192.0.2.0/24, RFC 5737) and the reserved `.test`
// TLD (RFC 2606): even if the guard regressed, nothing here could reach a real host.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const dns = require('node:dns');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');

const guard = require('./_support/netGuard.cjs');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(__dirname, '_support', 'netGuard.cjs');
const BLOCKED_IP = '192.0.2.1';
const BLOCKED_NAME = 'netguard-selftest.example.test';

// This file runs under the guard (the runner preloads it). Every deliberate violation below is
// drained by the test that caused it, so the exit reporter only ever sees accidental ones.
test.beforeEach(() => guard.drain());
test.afterEach(() => {
  const left = guard.drain();
  assert.deepEqual(left.map((v) => v.target), [], 'a test left an undrained violation');
});

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  delete env.NODE_OPTIONS;
  delete env.TEST_ALLOW_NETWORK;
  return { ...env, ...extra };
}

function onceError(emitter) {
  return new Promise((resolve, reject) => {
    emitter.once('error', resolve);
    emitter.once('connect', () => reject(new Error('connected; expected the guard to refuse')));
    emitter.once('secureConnect', () => reject(new Error('connected; expected the guard to refuse')));
  });
}

async function withServer(host, fn) {
  const server = http.createServer((req, res) => res.end(`ok ${req.url}`));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(options) {
  return new Promise((resolve, reject) => {
    const req = http.get(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
  });
}

test('the guard is installed in this process (the runner preloads it)', () => {
  assert.equal(guard.install(), true);
});

test('loopback classification: 127/8 and ::1 only', () => {
  for (const ok of ['127.0.0.1', '127.255.255.254', '::1', '[::1]', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) {
    assert.equal(guard.isLoopbackIp(ok), true, ok);
  }
  for (const bad of ['10.0.0.1', '169.254.169.254', '192.0.2.1', '0.0.0.0', '::', '::ffff:10.0.0.1', 'fe80::1', 'localhost']) {
    assert.equal(guard.isLoopbackIp(bad), false, bad);
  }
});

test('IPv4 loopback, IPv6 loopback and localhost-by-name all connect', async () => {
  await withServer('127.0.0.1', async (port) => {
    assert.equal(await get({ host: '127.0.0.1', port, path: '/v4' }), 'ok /v4');
    assert.equal(await get({ host: 'localhost', port, path: '/name', family: 4 }), 'ok /name');
  });
  await withServer('::1', async (port) => {
    assert.equal(await get({ host: '::1', port, path: '/v6' }), 'ok /v6');
  });
  const res = await withServer('127.0.0.1', (port) => fetch(`http://127.0.0.1:${port}/fetch`).then((r) => r.text()));
  assert.equal(res, 'ok /fetch');
});

test('dns.lookup("localhost") is allowed and answers loopback', async () => {
  const { address } = await dns.promises.lookup('localhost');
  assert.equal(guard.isLoopbackIp(address), true);
  const all = await dns.promises.lookup('localhost', { all: true });
  assert.ok(all.length >= 1 && all.every((a) => guard.isLoopbackIp(a.address)));
});

test('net.connect to a public IP literal is refused and recorded', async () => {
  const err = await onceError(net.connect(80, BLOCKED_IP));
  assert.equal(err.code, guard.BLOCKED_CODE);
  assert.deepEqual(guard.drain().map((v) => v.target), [`${BLOCKED_IP}:80`]);
});

test('tls.connect is refused through the same door', async () => {
  const err = await onceError(tls.connect({ host: BLOCKED_IP, port: 443, servername: 'x.test' }));
  assert.equal(err.code, guard.BLOCKED_CODE);
  assert.deepEqual(guard.drain().map((v) => v.target), [`${BLOCKED_IP}:443`]);
});

test('http.get to a hostname is refused at DNS, before any packet', async () => {
  await assert.rejects(get({ host: BLOCKED_NAME, port: 80, path: '/' }), { code: guard.BLOCKED_CODE });
  assert.deepEqual(guard.drain().map((v) => [v.kind, v.target]), [['dns', BLOCKED_NAME]]);
});

test('global fetch (undici) is refused for an IP literal and for a hostname', async () => {
  const a = await fetch(`http://${BLOCKED_IP}/`).then(() => null, (e) => e);
  assert.equal(a && a.cause && a.cause.code, guard.BLOCKED_CODE);
  const b = await fetch(`https://${BLOCKED_NAME}/`).then(() => null, (e) => e);
  assert.equal(b && b.cause && b.cause.code, guard.BLOCKED_CODE);
  const targets = guard.drain().map((v) => v.target);
  assert.ok(targets.includes(`${BLOCKED_IP}:80`), targets.join(','));
  assert.ok(targets.includes(BLOCKED_NAME), targets.join(','));
});

test('dns.lookup / resolve* / Resolver, callback and promise forms, are refused', async () => {
  await new Promise((resolve) => dns.lookup(BLOCKED_NAME, (err) => {
    assert.equal(err && err.code, guard.BLOCKED_CODE);
    resolve();
  }));
  await assert.rejects(dns.promises.lookup(BLOCKED_NAME), { code: guard.BLOCKED_CODE });
  await new Promise((resolve) => dns.resolve4(BLOCKED_NAME, (err) => {
    assert.equal(err && err.code, guard.BLOCKED_CODE);
    resolve();
  }));
  await assert.rejects(dns.promises.resolveTxt(BLOCKED_NAME), { code: guard.BLOCKED_CODE });
  await assert.rejects(new dns.promises.Resolver().resolve4(BLOCKED_NAME), { code: guard.BLOCKED_CODE });
  // resolve* never reads /etc/hosts, so even localhost would be a real DNS query.
  await assert.rejects(dns.promises.resolve4('localhost'), { code: guard.BLOCKED_CODE });
  assert.equal(guard.drain().length, 6);
});

test('a caller-supplied lookup is judged by WHERE IT POINTS, not by the name', async () => {
  const to = (address) => (hostname, opts, cb) => {
    if (typeof opts === 'function') cb = opts;
    if (opts && opts.all) return cb(null, [{ address, family: 4 }]);
    return cb(null, address, 4);
  };
  await withServer('127.0.0.1', async (port) => {
    assert.equal(await get({ host: 'internal.example', port, path: '/pinned', lookup: to('127.0.0.1') }), 'ok /pinned');
  });
  await assert.rejects(get({ host: 'internal.example', port: 80, path: '/', lookup: to(BLOCKED_IP) }), { code: guard.BLOCKED_CODE });
  assert.deepEqual(guard.drain().map((v) => v.target), [`internal.example:80 (resolved to ${BLOCKED_IP})`]);
});

test('a unix socket is local and allowed', async (t) => {
  if (process.platform === 'win32') return t.skip('no unix sockets');
  const sock = path.join(require('node:os').tmpdir(), `netguard-${process.pid}-${Date.now()}.sock`);
  const server = net.createServer((s) => s.end('hi'));
  await new Promise((resolve) => server.listen(sock, resolve));
  try {
    const got = await new Promise((resolve, reject) => {
      let body = '';
      net.connect(sock).on('data', (c) => { body += c; }).on('end', () => resolve(body)).on('error', reject);
    });
    assert.equal(got, 'hi');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- the "fail loudly" half -------------------------------------------------------------

const SWALLOWING_SCRIPT =
  "require('node:net').connect(80, '192.0.2.1').on('error', () => {});" +
  "require('node:dns').lookup('netguard-selftest.example.test', () => {});";

test('preloaded: a swallowed attempt still fails the process, with the target and stack', () => {
  const r = spawnSync(process.execPath, ['--require', GUARD, '-e', SWALLOWING_SCRIPT], {
    cwd: ROOT, env: cleanEnv(), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /\[netGuard\] 2 outbound network attempt\(s\) blocked/);
  assert.match(r.stderr, /connect -> 192\.0\.2\.1:80/);
  assert.match(r.stderr, /dns -> netguard-selftest\.example\.test/);
  assert.match(r.stderr, /\[eval\]/, 'the report carries the caller stack');
});

test('preloaded: a clean process exits 0 and prints nothing', () => {
  const r = spawnSync(process.execPath, ['--require', GUARD, '-e', 'void 0'], {
    cwd: ROOT, env: cleanEnv(), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('TEST_ALLOW_NETWORK=1 turns the guard off locally, and is ignored under CI=true', () => {
  const probe = "process.stdout.write(String(require(process.argv[1]).install()))";
  const local = spawnSync(process.execPath, ['-e', probe, GUARD], {
    cwd: ROOT, env: cleanEnv({ TEST_ALLOW_NETWORK: '1', CI: '' }), encoding: 'utf8',
  });
  assert.equal(local.stdout, 'false', local.stderr);
  const ci = spawnSync(process.execPath, ['-e', probe, GUARD], {
    cwd: ROOT, env: cleanEnv({ TEST_ALLOW_NETWORK: '1', CI: 'true' }), encoding: 'utf8',
  });
  assert.equal(ci.stdout, 'true', ci.stderr);
});

test('provider API keys are scrubbed from the test process and what it spawns, like CI', () => {
  const probe = "process.stdout.write(JSON.stringify(['GEMINI_API_KEY','AURORA_SKIN_GEMINI_API_KEY'," +
    "'OPENAI_API_KEY','ZENROWS_API_KEY','PIVOTA_API_KEY'].map((k) => [k, process.env[k] || null])))";
  const env = cleanEnv({
    GEMINI_API_KEY: 'x', AURORA_SKIN_GEMINI_API_KEY: 'x', OPENAI_API_KEY: 'x', ZENROWS_API_KEY: 'x',
    PIVOTA_API_KEY: 'kept: not a third-party provider key',
  });
  const r = spawnSync(process.execPath, ['--require', GUARD, '-e', probe], { cwd: ROOT, env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r.stdout), [
    ['GEMINI_API_KEY', null], ['AURORA_SKIN_GEMINI_API_KEY', null], ['OPENAI_API_KEY', null],
    ['ZENROWS_API_KEY', null], ['PIVOTA_API_KEY', 'kept: not a third-party provider key'],
  ]);
  const optedOut = spawnSync(process.execPath, ['--require', GUARD, '-e', probe], {
    cwd: ROOT, env: { ...env, TEST_ALLOW_NETWORK: '1', CI: '' }, encoding: 'utf8',
  });
  assert.equal(JSON.parse(optedOut.stdout)[0][1], 'x', 'TEST_ALLOW_NETWORK=1 keeps the keys for a live run');
});

test('the runner preloads the guard into every node:test suite', () => {
  const { buildTestEnv } = require('../scripts/run_node_test_suites.cjs');
  const env = buildTestEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=4096/);
  assert.ok(env.NODE_OPTIONS.includes(`--require=${GUARD}`), env.NODE_OPTIONS);
});

test('jest: a test that swallows a blocked fetch is RED, and the report names it; jest children are guarded', () => {
  const fixture = path.join(__dirname, '_support', 'fixtures', 'netGuardSwallowed.fixture.cjs');
  const jestBin = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
  const r = spawnSync(process.execPath, [
    jestBin, '--config', path.join(ROOT, 'jest.config.js'), '--watchman=false', '--runInBand',
    '--ci', '--testMatch=**/netGuardSwallowed.fixture.cjs', '--runTestsByPath', fixture,
  ], { cwd: ROOT, env: cleanEnv({ GEMINI_API_KEY: 'x' }), encoding: 'utf8', timeout: 120_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 1, out);
  assert.match(out, /✕ swallows a failed fetch/);
  assert.match(out, /\[netGuard\] 1 outbound network attempt\(s\) blocked/);
  assert.match(out, /dns -> netguard-selftest\.example\.test/);
  // The child-process case passes: its child was guarded (exit 1) and saw no key.
  assert.match(out, /✓ a node child spawned by a jest test is guarded too/);
  assert.match(out, /1 failed, 2 passed/);
});
