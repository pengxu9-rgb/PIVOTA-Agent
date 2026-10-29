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
const { spawnSync, execFileSync } = require('node:child_process');
const dgram = require('node:dgram');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');

const guard = require('./_support/netGuard.cjs');
const { readRunLog } = require('./_support/netGuardRunLog.cjs');

// This suite makes blocked attempts ON PURPOSE and drains them. The runner's run log would still
// hold them and fail the run, so this process keeps out of it (the children below get their own).
delete process.env[guard.RUN_DIR_ENV];

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
  // Each child here is a run of its own, not part of this suite: without this, a nested
  // `node --test` reports in the v8 stream meant for a parent runner.
  delete env.NODE_TEST_CONTEXT;
  // An empty origin, not a missing one: the guard's spawn wrapper fills a MISSING origin with this
  // suite's, which would make the child's own suite look like a process this suite spawned.
  return { ...env, [guard.ORIGIN_ENV]: '', ...extra };
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

test('UDP to a public address literal is refused and recorded; loopback UDP is allowed', async (t) => {
  const sender = dgram.createSocket('udp4');
  const receiver = dgram.createSocket('udp4');
  t.after(() => {
    sender.close();
    receiver.close();
  });
  const sendErr = await new Promise((resolve) => sender.send(Buffer.from('x'), 53, BLOCKED_IP, resolve));
  assert.equal(sendErr && sendErr.code, guard.BLOCKED_CODE);
  const other = dgram.createSocket('udp4');
  const connectErr = await new Promise((resolve) => other.connect(53, BLOCKED_IP, resolve));
  other.close();
  assert.equal(connectErr && connectErr.code, guard.BLOCKED_CODE);
  assert.deepEqual(guard.drain().map((v) => `${v.kind} ${v.target}`), [`udp send ${BLOCKED_IP}`, `udp connect ${BLOCKED_IP}:53`]);

  await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve));
  const got = new Promise((resolve) => receiver.once('message', (m) => resolve(String(m))));
  await new Promise((resolve, reject) =>
    sender.send(Buffer.from('loop'), receiver.address().port, '127.0.0.1', (e) => (e ? reject(e) : resolve())),
  );
  assert.equal(await got, 'loop');
});

// What one UDP send came to: the callback's error, the socket's 'error' event (a refused send
// with no callback), or 'no error' -- after a moment, so a send that got through cannot hang the test.
function udpOutcome(socket, send) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('no error'), 300);
    const done = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
    socket.once('error', done);
    send((err) => done(err || 'no error'));
  });
}

async function boundUdpSocket() {
  const s = dgram.createSocket('udp4');
  await new Promise((resolve) => s.bind(0, resolve));
  return s;
}

test('UDP: every send() form is judged by where it goes, also with a string port and no callback', async (t) => {
  const receiver = dgram.createSocket('udp4');
  t.after(() => receiver.close());
  await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve));
  const loopPort = receiver.address().port;
  const m = Buffer.from('ab');
  // [form, send(socket, port, address, callback)]. The sockets are BOUND: an unbound socket
  // queues its send and replays it later in the 4-argument form, which would hide a misread.
  const forms = [
    ['(msg, port, addr)', (s, p, a) => s.send(m, p, a)],
    ['(msg, port, addr, cb)', (s, p, a, cb) => s.send(m, p, a, cb)],
    ['(msg, "port", addr, cb)', (s, p, a, cb) => s.send(m, String(p), a, cb)],
    ['([msg], port, addr, cb)', (s, p, a, cb) => s.send([m], p, a, cb)],
    ['(msg, off, len, port, addr)', (s, p, a) => s.send(m, 0, 1, p, a)],
    ['(msg, off, len, port, addr, cb)', (s, p, a, cb) => s.send(m, 0, 1, p, a, cb)],
  ];
  for (const [form, send] of forms) {
    const blocked = await boundUdpSocket();
    const err = await udpOutcome(blocked, (cb) => send(blocked, 53, BLOCKED_IP, cb));
    blocked.close();
    assert.equal(err && err.code, guard.BLOCKED_CODE, `send${form} to ${BLOCKED_IP}`);
    assert.deepEqual(guard.drain().map((v) => `${v.kind} ${v.target}`), [`udp send ${BLOCKED_IP}`], form);

    const allowed = await boundUdpSocket();
    const got = new Promise((resolve) => receiver.once('message', resolve));
    assert.equal(await udpOutcome(allowed, (cb) => send(allowed, loopPort, '127.0.0.1', cb)), 'no error', form);
    assert.ok((await got).length > 0, `send${form} to loopback is delivered`);
    allowed.close();
  }
  // No address at all goes to loopback (dgram's default), as on an unguarded socket.
  const bare = await boundUdpSocket();
  const got = new Promise((resolve) => receiver.once('message', resolve));
  bare.send(m, loopPort);
  assert.equal(String(await got), 'ab');
  bare.close();
});

test('UDP: a connected socket\'s sends go to its peer, which is checked even if connect() was not', async (t) => {
  const receiver = dgram.createSocket('udp4');
  t.after(() => receiver.close());
  await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve));
  const m = Buffer.from('ab');
  // A socket connected before the guard was installed would have a public peer that connect()
  // never judged. Stand one in without dialling anything: really connected (to loopback), but
  // reporting a public peer through remoteAddress(), which is what the guard reads.
  const sock = dgram.createSocket('udp4');
  t.after(() => sock.close());
  await new Promise((resolve, reject) => sock.connect(receiver.address().port, '127.0.0.1', (e) => (e ? reject(e) : resolve())));
  sock.remoteAddress = () => ({ address: BLOCKED_IP, family: 'IPv4', port: 53 });
  for (const [form, send] of [
    ['(msg)', () => sock.send(m)],
    ['(msg, cb)', (cb) => sock.send(m, cb)],
    ['(msg, off, len, cb)', (cb) => sock.send(m, 0, 1, cb)],
  ]) {
    const err = await udpOutcome(sock, send);
    assert.equal(err && err.code, guard.BLOCKED_CODE, `connected send${form}`);
    assert.deepEqual(guard.drain().map((v) => `${v.kind} ${v.target}`), [`udp send ${BLOCKED_IP}:53`], form);
  }

  const loop = dgram.createSocket('udp4');
  t.after(() => loop.close());
  await new Promise((resolve, reject) => loop.connect(receiver.address().port, '127.0.0.1', (e) => (e ? reject(e) : resolve())));
  const got = new Promise((resolve) => receiver.once('message', resolve));
  loop.send(m);
  assert.equal(String(await got), 'ab');
});

test('UDP: a socket\'s own lookup is judged by WHERE IT POINTS, for send and connect', async (t) => {
  // Maps one name; everything else (the bind address) goes to the real resolver, as real ones do.
  const toPublic = (name, opts, cb) => (name === 'anywhere.example.test' ? cb(null, BLOCKED_IP, 4) : dns.lookup(name, opts, cb));
  const sender = dgram.createSocket({ type: 'udp4', lookup: toPublic });
  const connector = dgram.createSocket({ type: 'udp4', lookup: toPublic });
  t.after(() => {
    sender.close();
    connector.close();
  });
  const sendErr = await new Promise((resolve) => sender.send(Buffer.from('x'), 53, 'anywhere.example.test', resolve));
  assert.equal(sendErr && sendErr.code, guard.BLOCKED_CODE);
  const connectErr = await new Promise((resolve) => connector.connect(53, 'anywhere.example.test', resolve));
  assert.equal(connectErr && connectErr.code, guard.BLOCKED_CODE);
  const target = `anywhere.example.test (resolved to ${BLOCKED_IP})`;
  assert.deepEqual(guard.drain().map((v) => `${v.kind} ${v.target}`), [`udp ${target}`, `udp ${target}`]);

  const receiver = dgram.createSocket('udp4');
  t.after(() => receiver.close());
  await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve));
  const local = dgram.createSocket({
    type: 'udp4',
    lookup: (name, opts, cb) => (name === 'internal.example' ? cb(null, '127.0.0.1', 4) : dns.lookup(name, opts, cb)),
  });
  t.after(() => local.close());
  const got = new Promise((resolve) => receiver.once('message', resolve));
  await new Promise((resolve, reject) =>
    local.send(Buffer.from('mapped'), receiver.address().port, 'internal.example', (e) => (e ? reject(e) : resolve())),
  );
  assert.equal(String(await got), 'mapped');
});

test('*.localhost is loopback without asking a resolver, and a fetch to it reaches a local listener', async () => {
  assert.deepEqual(await dns.promises.lookup('api.netguard.localhost'), { address: '127.0.0.1', family: 4 });
  assert.deepEqual(await dns.promises.lookup('api.netguard.localhost', { family: 6, all: true }), [{ address: '::1', family: 6 }]);
  await withServer('127.0.0.1', async (port) => {
    const body = await (await fetch(`http://api.netguard.localhost:${port}/x`)).text();
    assert.equal(body, 'ok /x');
  });
});

test('a node child started with an env of its own (no NODE_OPTIONS) is still guarded', () => {
  const code = "require('node:net').connect(80, '192.0.2.1').on('error', () => {})";
  const r = spawnSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /\[netGuard\] 1 outbound network attempt\(s\) blocked/);
  // execFileSync reaches spawnSync from inside node, not through the export: covered too.
  assert.throws(() => execFileSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH }, stdio: 'pipe' }), (e) => e.status === 1);
});

test('promisified exec/execFile still resolve {stdout, stderr}, and their children are guarded', async () => {
  const { promisify } = require('node:util');
  const cp = require('node:child_process');
  const ok = await promisify(cp.execFile)(process.execPath, ['-e', 'process.stdout.write("hi")'], { env: { PATH: process.env.PATH } });
  assert.deepEqual(ok, { stdout: 'hi', stderr: '' });
  const code = "require('node:net').connect(80, '192.0.2.1').on('error', () => {})";
  await assert.rejects(promisify(cp.execFile)(process.execPath, ['-e', code], { env: { PATH: process.env.PATH } }), (e) => e.code === 1);
  const viaShell = await promisify(cp.exec)(`"${process.execPath}" -e "process.stdout.write('sh')"`, { env: { PATH: process.env.PATH } });
  assert.equal(viaShell.stdout, 'sh');
});

test('a worker thread started with execArgv: [] is still guarded', async () => {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(
    "require('node:net').connect(80, '192.0.2.1').on('error', (e) => require('node:worker_threads').parentPort.postMessage(e.code))",
    { eval: true, execArgv: [] },
  );
  const code = await new Promise((resolve) => worker.once('message', resolve));
  await worker.terminate();
  assert.equal(code, guard.BLOCKED_CODE);
});

test('run log: an attempt by a child the suite ignored is logged, unreported, and names the suite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netguard-selftest-'));
  try {
    const fixture = path.join('tests', '_support', 'fixtures', 'netGuardChildEscape.fixture.cjs');
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', fixture], {
      cwd: ROOT,
      env: cleanEnv({ NODE_OPTIONS: guard.withGuardPreload(''), [guard.RUN_DIR_ENV]: dir }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); // the suite itself passes...
    const rows = readRunLog(dir);
    assert.deepEqual(rows.map((v) => [v.target, v.origin, v.inChild]), [['192.0.2.8:80', fixture, true]]); // ...the log does not
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a suite process\'s own attempt names the suite, and not as a child process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netguard-selftest-'));
  try {
    const fixture = path.join('tests', '_support', 'fixtures', 'netGuardSuiteAttempt.fixture.cjs');
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', fixture], {
      cwd: ROOT,
      env: cleanEnv({ NODE_OPTIONS: guard.withGuardPreload(''), [guard.RUN_DIR_ENV]: dir }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 1, out);
    assert.match(out, /connect -> 192\.0\.2\.10:80 {2}\(started by tests\/_support\/fixtures\/netGuardSuiteAttempt\.fixture\.cjs\)/);
    assert.doesNotMatch(out, /in a child process/);
    assert.deepEqual(readRunLog(dir), []); // the suite failed on it itself: nothing left over
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the runner fails a run on an attempt no suite caught, naming the suite', () => {
  const runner = path.join(ROOT, 'scripts', 'run_node_test_suites.cjs');
  const fixture = path.join('tests', '_support', 'fixtures', 'netGuardChildEscape.fixture.cjs');
  const r = spawnSync(
    process.execPath,
    ['-e', `process.exitCode = require(${JSON.stringify(runner)}).runSuites([${JSON.stringify(fixture)}])`],
    { cwd: ROOT, env: cleanEnv(), encoding: 'utf8', timeout: 60_000 },
  );
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 1, out);
  assert.match(out, /(ℹ|#) pass 1\b/); // spec on a TTY-less node 24, TAP on node 20
  assert.match(out, /connect -> 192\.0\.2\.8:80 {2}\(started by tests\/_support\/fixtures\/netGuardChildEscape\.fixture\.cjs; in a child process/);
});

function runJestFixtures(fixtures, args, env = {}) {
  const jestBin = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
  const files = fixtures.map((f) => path.join(__dirname, '_support', 'fixtures', f));
  // As CI starts jest: with no preload in jest's own process. (The guard's spawn wrapper would
  // add one to the env given here, and in band the preloaded exit reporter would then catch what
  // the jest reporter is under test for.) `env -u` drops it after the wrapper has run.
  const r = spawnSync('/usr/bin/env', [
    '-u', 'NODE_OPTIONS', process.execPath,
    jestBin, '--config', path.join(ROOT, 'jest.config.js'), '--watchman=false', '--ci', ...args,
    '--testSequencer', path.join(__dirname, '_support', 'fixtures', 'byPathSequencer.fixture.cjs'),
    '--testMatch=**/*.fixture.cjs', '--runTestsByPath', ...files,
  ], { cwd: ROOT, env: cleanEnv(env), encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// A leaves a fetch on a timer; B (after A, by path) is offline and slow enough to be running when it fires.
const LATE = 'netGuardLeftoverA.fixture.cjs';
const NEXT = 'netGuardLeftoverB.fixture.cjs';
// One worker that --workerIdleMemoryLimit recycles, as CI runs the shards; and in band.
for (const [mode, args] of [['CI worker', ['--maxWorkers=1', '--workerIdleMemoryLimit=768MB']], ['in band', ['--runInBand']]]) {
  test(`jest (${mode}): a file's leftover attempt fails the RUN and names that file; the next file stays green`, () => {
    const { status, out } = runJestFixtures([LATE, NEXT], args);
    assert.equal(status, 1, out);
    assert.match(out, /PASS .*netGuardLeftoverA\.fixture\.cjs/);
    assert.match(out, /PASS .*netGuardLeftoverB\.fixture\.cjs/);
    assert.match(out, /connect -> 192\.0\.2\.7:80 {2}\(started by \S*netGuardLeftoverA\.fixture\.cjs/);
    // With the stack of the call, though the file that made it was torn down by then.
    assert.match(out, /\| at .*netGuardLeftoverA\.fixture\.cjs:\d+/);
  });

  test(`jest (${mode}): an attempt that fires after the worker's last file still fails the run`, () => {
    const { status, out } = runJestFixtures([LATE], args);
    assert.equal(status, 1, out);
    assert.match(out, /Tests: +1 passed, 1 total/);
    assert.match(out, /connect -> 192\.0\.2\.7:80 {2}\(started by \S*netGuardLeftoverA\.fixture\.cjs/);
  });

  test(`jest (${mode}): worker threads a test starts with inherited flags or a shared env are guarded, and fail the run`, () => {
    const { status, out } = runJestFixtures(['netGuardWorker.fixture.cjs'], args);
    assert.equal(status, 1, out);
    assert.match(out, /Tests: +2 passed, 2 total/); // each worker's connect was refused...
    for (const ip of ['192\\.0\\.2\\.20', '192\\.0\\.2\\.27']) {
      // ...and recorded against the file that started it.
      assert.match(out, new RegExp(`connect -> ${ip}:80 {2}\\(started by \\S*netGuardWorker\\.fixture\\.cjs; in a child process or worker`));
    }
  });
}

test('jest: a run dir inherited from the environment is not used; a stale row in it does not fail a clean run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netguard-selftest-'));
  try {
    const stale = { id: '1:0:1', kind: 'connect', target: '192.0.2.99:80', origin: 'tests/old.test.js' };
    fs.writeFileSync(path.join(dir, '1-0.jsonl'), `${JSON.stringify(stale)}\n`);
    const { status, out } = runJestFixtures([NEXT], ['--runInBand'], { [guard.RUN_DIR_ENV]: dir });
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /192\.0\.2\.99/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jest (in band): an attempt that fires after the run was reported still fails it', () => {
  const { status, out } = runJestFixtures(['netGuardLeftoverAfterRun.fixture.cjs'], ['--runInBand']);
  assert.equal(status, 1, out);
  assert.match(out, /Tests: +1 passed, 1 total/);
  assert.match(out, /connect -> 192\.0\.2\.9:80 {2}\(started by \S*netGuardLeftoverAfterRun\.fixture\.cjs/);
});

test('nock_file_net_guard: unmatched requests fail their test, mocked host or not; a declared down host does not', () => {
  const fixture = path.join('tests', '_support', 'fixtures', 'nockGuard.fixture.cjs');
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', fixture], {
    cwd: ROOT,
    env: cleanEnv(),
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 1, out);
  assert.match(out, /✔ a down host fails fast and is not reported/);
  assert.match(out, /✖ a mocked host whose interceptors all missed is reported/);
  assert.match(out, /reached no nock interceptor during this test: GET http:\/\/mocked\.example\.test(:80)?\/other/);
  assert.match(out, /✖ an unmocked host is reported/);
  assert.match(out, /reached no nock interceptor during this test: GET http:\/\/unmocked\.example\.test(:80)?\/y/);
  assert.match(out, /✔ a matched request passes/);
  assert.doesNotMatch(out, /down\.example\.test\/x/);
});
