'use strict';
// Loopback-only network guard for the test suites.
//
// WHY. On 2026-10-20 a full jest run under a hand-rolled version of this guard blocked 347
// outbound connects: incidecoder, walmart, ulta, target, sephora, open-meteo, the Gemini API,
// Google's OAuth token endpoint, and .test/.example fixture hosts that only fail because DNS
// says no. Every one of those tests was green, because the code under test swallows a failed
// fetch and falls back. So "the suite passes" said nothing about whether it reached the
// internet, and a test that reaches the internet is a test whose result depends on a third
// party's uptime, rate limits and content -- and, for our own hosts, a test that can write to
// production.
//
// WHAT IT ALLOWS. A socket may go to 127.0.0.0/8, ::1 (or ::ffff:127.x), or a unix socket /
// named pipe. A hostname is allowed only if it resolves to one of those: `localhost` through
// the real resolver, or any name through a caller-supplied `lookup` (an SSRF test that maps
// `internal.example` to 127.0.0.1 is still loopback). Every other connect, and every DNS query
// for any other name, is refused with ERR_TEST_NETWORK_BLOCKED and recorded.
//
// WHERE IT HOOKS. net.Socket.prototype.connect is the one door every TCP client walks
// through: net.connect, tls.connect (a TLSSocket IS a net.Socket and connects through the same
// method), http/https agents, http2, undici and therefore global fetch, nock/msw passthrough,
// pg, ioredis. dns.lookup / dns.resolve* / dns.Resolver and their promise twins are patched
// too, because a DNS query is itself traffic and is how a fixture host leaks.
//
// HOW IT FAILS. Refusing the connect is not enough: most callers catch the error and fall
// back, which is exactly how 347 attempts hid behind green tests. So every refusal is
// RECORDED, and the runners turn a non-empty record into a failure:
//   - jest:      tests/_support/netGuardJestHooks.cjs fails the test that was running.
//   - node:test: when this file is preloaded (`node --require`), the process exits non-zero
//                at exit with the list, which fails that suite file.
//
// OPT-OUT. TEST_ALLOW_NETWORK=1 disables the guard for a local run of an opt-in integration
// test. It is IGNORED when CI=true: CI must never reach the internet.

const net = require('node:net');
const dns = require('node:dns');
// From the core module, not the global: under jest this file is evaluated inside a test
// file's sandbox, and the patches it installs outlive that sandbox. Core modules do not.
const { setImmediate: later } = require('node:timers');

const STATE_KEY = Symbol.for('pivota.tests.netGuard');
const BLOCKED_CODE = 'ERR_TEST_NETWORK_BLOCKED';

// For a test that needs an upstream which is DOWN. A `.test` hostname "never resolves" only
// after a real DNS query has gone out; a loopback port nothing listens on refuses at once,
// offline. Port 1 (tcpmux) has no listener on any CI runner or dev box we use.
const UNREACHABLE_LOOPBACK_URL = 'http://127.0.0.1:1';

// State lives on the `net` module object, not on this module. Jest gives every test file a
// fresh module registry, so this file is evaluated once per test file, but core modules (and
// the prototypes patched below) are shared by the whole worker process. Anchoring the state
// to `net` makes install idempotent and lets the jest hooks see what the patches recorded.
function state() {
  if (!net[STATE_KEY]) {
    Object.defineProperty(net, STATE_KEY, {
      value: { installed: false, violations: [], originals: null },
      enumerable: false,
    });
  }
  return net[STATE_KEY];
}

function isCi() {
  return String(process.env.CI || '').toLowerCase() === 'true';
}

function networkAllowed() {
  return process.env.TEST_ALLOW_NETWORK === '1' && !isCi();
}

function stripBrackets(host) {
  const s = String(host);
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

function isLoopbackIp(address) {
  const a = stripBrackets(address).toLowerCase().split('%')[0];
  const family = net.isIP(a);
  if (family === 4) return a.split('.')[0] === '127';
  if (family === 6) {
    if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
    const mapped = a.match(/^(?:0:0:0:0:0:|::)ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return Boolean(mapped && mapped[1].split('.')[0] === '127');
  }
  return false;
}

function isLocalhostName(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost');
}

function captureStack() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const raw = new Error().stack;
  Error.stackTraceLimit = limit;
  const frames = String(raw || '').split('\n').slice(1).map((l) => l.trim());
  const own = frames.filter((l) => !l.includes(__filename));
  // Prefer the caller's frames; an async transport (fetch, a DNS callback) may have none, in
  // which case the internal frames are still the best clue there is.
  const useful = own.filter((l) => !l.includes('(node:') && !l.startsWith('at node:'));
  // Lead with the transport frame that dialled, then the repo's own frames: twelve frames of
  // axios/follow-redirects say how, not who.
  const app = useful.filter((l) => !l.includes('/node_modules/'));
  if (app.length) return [useful[0], ...app.filter((l) => l !== useful[0])].slice(0, 12).join('\n');
  return (useful.length ? useful : own).slice(0, 12).join('\n');
}

function blockedError(kind, target) {
  const err = new Error(
    `[netGuard] blocked ${kind} to ${target}: tests may only reach loopback. ` +
      'Mock it (nock / msw without passthrough / an injected client), or make the test ' +
      'an opt-in integration test (see tests/_support/netGuard.cjs).',
  );
  err.code = BLOCKED_CODE;
  err.errno = BLOCKED_CODE;
  return err;
}

function record(kind, target) {
  const entry = {
    kind,
    target,
    at: Date.now(),
    stack: captureStack(),
    // Set by the jest hooks (tests/_support/netGuardJestHooks.cjs); null under node:test.
    testPath: state().testPath || null,
  };
  state().violations.push(entry);
  return entry;
}

function addressesOf(address) {
  if (Array.isArray(address)) return address.map((a) => (a && typeof a === 'object' ? a.address : a));
  return [address];
}

// Wrap a lookup function (the real dns.lookup or a caller's own) so the connect proceeds
// only if EVERY address it produced is loopback.
//
// `connectStack` is captured when connect() is CALLED. The lookup itself often runs on a later
// tick (Happy Eyeballs defers it), where the stack is nothing but node internals.
function loopbackOnlyLookup(lookup, hostname, port, connectStack) {
  return function guardedLookup(name, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    lookup(name, opts, (err, address, family) => {
      if (err) {
        if (err.code === BLOCKED_CODE && err.netGuardEntry && connectStack) {
          err.netGuardEntry.stack = connectStack;
        }
        return cb(err);
      }
      const outside = addressesOf(address).find((a) => !isLoopbackIp(a));
      if (outside) {
        const target = `${hostname}:${port} (resolved to ${outside})`;
        const entry = record('connect', target);
        if (connectStack) entry.stack = connectStack;
        return cb(blockedError('connect', target));
      }
      return cb(null, address, family);
    });
  };
}

function patchSocketConnect(originals) {
  const originalConnect = net.Socket.prototype.connect;
  originals.socketConnect = originalConnect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const normalized = Array.isArray(args[0]) && args[0].length ? args[0] : net._normalizeArgs(args);
    const options = normalized[0] || {};
    const cb = normalized[1];
    if (options.path) return originalConnect.apply(this, args);

    const host = options.host == null ? 'localhost' : String(options.host);
    const port = options.port;
    const bare = stripBrackets(host);

    if (net.isIP(bare)) {
      if (isLoopbackIp(bare)) return originalConnect.apply(this, args);
      const target = `${host}:${port}`;
      record('connect', target);
      const err = blockedError('connect', target);
      // Fail the way a refused connect fails: asynchronously, on the socket. A synchronous
      // throw would escape from deep inside http.Agent and land in places no caller handles.
      this.connecting = true;
      later(() => this.destroy(err));
      return this;
    }

    const lookup = typeof options.lookup === 'function' ? options.lookup : dns.lookup;
    const connectStack = isLocalhostName(host) && !options.lookup ? null : captureStack();
    const guarded = { ...options, lookup: loopbackOnlyLookup(lookup, host, port, connectStack) };
    return cb ? originalConnect.call(this, guarded, cb) : originalConnect.call(this, guarded);
  };
}

function isPassThroughName(hostname) {
  return net.isIP(stripBrackets(hostname)) !== 0;
}

function patchLookup(originals) {
  const originalLookup = dns.lookup;
  originals.lookup = originalLookup;
  dns.lookup = function guardedDnsLookup(hostname, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    // An IP literal never leaves the process.
    if (isPassThroughName(hostname)) return originalLookup.call(dns, hostname, opts, cb);
    if (isLocalhostName(hostname)) {
      return originalLookup.call(dns, hostname, opts, (err, address, family) => {
        if (err) return cb(err);
        const outside = addressesOf(address).find((a) => !isLoopbackIp(a));
        if (outside) {
          const target = `${hostname} (resolved to ${outside})`;
          record('dns', target);
          return cb(blockedError('dns lookup', target));
        }
        return cb(null, address, family);
      });
    }
    const err = blockedError('dns lookup', String(hostname));
    Object.defineProperty(err, 'netGuardEntry', { value: record('dns', String(hostname)), enumerable: false });
    later(() => cb(err));
    return undefined;
  };

  const promises = dns.promises;
  const originalPromiseLookup = promises.lookup;
  originals.promiseLookup = originalPromiseLookup;
  promises.lookup = function guardedPromiseLookup(hostname, opts) {
    return new Promise((resolve, reject) => {
      dns.lookup(hostname, opts || {}, (err, address, family) => {
        if (err) return reject(err);
        if (Array.isArray(address)) return resolve(address);
        return resolve({ address, family });
      });
    });
  };
}

const RESOLVE_METHODS = [
  'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
  'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt',
  'resolveTlsa', 'reverse', 'lookupService',
];

// resolve* always queries a DNS server (it does not read /etc/hosts), so no name is allowed.
function blockingResolver(method, isPromise) {
  return function guardedResolve(name) {
    const target = `${method}(${name})`;
    record('dns', target);
    const err = blockedError('dns query', target);
    if (isPromise) return Promise.reject(err);
    const cb = arguments[arguments.length - 1];
    if (typeof cb === 'function') later(() => cb(err));
    return undefined;
  };
}

function patchResolvers(originals) {
  originals.resolvers = [];
  const targets = [
    [dns, false],
    [dns.Resolver && dns.Resolver.prototype, false],
    [dns.promises, true],
    [dns.promises.Resolver && dns.promises.Resolver.prototype, true],
  ];
  for (const [obj, isPromise] of targets) {
    if (!obj) continue;
    for (const method of RESOLVE_METHODS) {
      if (typeof obj[method] !== 'function') continue;
      originals.resolvers.push([obj, method, obj[method]]);
      obj[method] = blockingResolver(method, isPromise);
    }
  }
}

function install() {
  const s = state();
  if (s.installed || networkAllowed()) return s.installed;
  const originals = {};
  patchSocketConnect(originals);
  patchLookup(originals);
  patchResolvers(originals);
  s.originals = originals;
  s.installed = true;
  return true;
}

// Test-only: the guard's own suite needs to put the real functions back.
function uninstall() {
  const s = state();
  if (!s.installed) return;
  const o = s.originals;
  net.Socket.prototype.connect = o.socketConnect;
  dns.lookup = o.lookup;
  dns.promises.lookup = o.promiseLookup;
  for (const [obj, method, fn] of o.resolvers) obj[method] = fn;
  s.installed = false;
  s.originals = null;
}

// For helpers that refuse a request before it reaches a socket (nockOffline.cjs) but still
// want it reported as a test that tried to reach the network.
function recordViolation(kind, target) {
  return record(kind, target);
}

function violations() {
  return state().violations.slice();
}

// Returns and clears everything recorded so far.
function drain() {
  const s = state();
  return s.violations.splice(0, s.violations.length);
}

function formatViolations(list) {
  const lines = [
    `[netGuard] ${list.length} outbound network attempt(s) blocked. Tests may only reach loopback.`,
  ];
  list.forEach((v, i) => {
    lines.push(`  ${i + 1}. ${v.kind} -> ${v.target}${v.testPath ? `  (during ${v.testPath})` : ''}`);
    // `| ` keeps jest from mistaking these for its own stack frames and filtering them out.
    if (v.stack) lines.push(v.stack.split('\n').map((l) => `       | ${l}`).join('\n'));
  });
  lines.push(
    'Fix: mock the call (nock / msw without passthrough / dependency injection), or make the test ' +
      'an opt-in integration test skipped unless an env var is set. TEST_ALLOW_NETWORK=1 turns the ' +
      'guard off for a local run (never in CI).',
  );
  return lines.join('\n');
}

// `node --require tests/_support/netGuard.cjs` (the node:test runner): report and fail the
// process at exit. Under jest this file runs inside a test context where the `jest` object is
// injected, and the jest hooks do the reporting instead.
function installExitReporter() {
  const s = state();
  if (s.exitReporter) return;
  s.exitReporter = true;
  process.on('exit', (code) => {
    const list = drain();
    if (!list.length) return;
    process.stderr.write(`\n${formatViolations(list)}\n`);
    if (!code) process.exitCode = 1;
  });
}

// THE SAME RUN ON A LAPTOP AS IN CI. CI has no provider credentials, so every suite runs its
// "no key configured" path there. A developer shell usually exports one, and on 2026-10-21 that
// alone sent 20 suites (9 jest, 11 node:test) to the live Gemini API -- and changed what a
// selfie-extraction test asserted against. With the guard on, those keys are removed from the
// test process (and from anything it spawns), so local and CI runs take the same paths. A test
// that needs a key sets its own, against a mock. Third-party provider API keys only.
const PROVIDER_CREDENTIAL_ENV_RE = /^(?:[A-Z0-9_]+_)?(?:GEMINI|GOOGLE|GOOGLE_GENAI|OPENAI|ANTHROPIC|ZENROWS)_API_KEY$/;

function scrubProviderCredentials(env) {
  const removed = [];
  for (const key of Object.keys(env)) {
    if (PROVIDER_CREDENTIAL_ENV_RE.test(key)) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

// `--require=<this file>` appended to a NODE_OPTIONS value, once. NODE_OPTIONS splits on
// whitespace, so a checkout path containing a space cannot be carried; that is refused loudly
// rather than silently running children unguarded.
function withGuardPreload(nodeOptions) {
  const preload = `--require=${__filename}`;
  if (/\s/.test(__filename)) {
    throw new Error(`[netGuard] cannot preload from a path with whitespace: ${__filename}`);
  }
  const existing = String(nodeOptions || '').trim();
  return existing.includes(preload) ? existing : [existing, preload].filter(Boolean).join(' ');
}

// Under jest, `process` is a per-file sandbox copy; a child process a test spawns inherits the
// worker's REAL environment instead. Give that environment the preload and the scrub too, so a
// `node` child of a jest test (a script test) is guarded and fails the same way. vm's main
// context is the worker's own realm, where `process` is the real one.
function guardRealProcessEnv() {
  const realProcess = require('node:vm').runInThisContext('process');
  if (!realProcess || !realProcess.env || realProcess === process) return;
  realProcess.env.NODE_OPTIONS = withGuardPreload(realProcess.env.NODE_OPTIONS);
  scrubProviderCredentials(realProcess.env);
}

install();
if (!networkAllowed()) {
  // Every load, not only the first: under jest each test file gets its own copy of process.env.
  scrubProviderCredentials(process.env);
  // eslint-disable-next-line no-undef
  if (typeof jest !== 'undefined') {
    process.env.NODE_OPTIONS = withGuardPreload(process.env.NODE_OPTIONS);
    guardRealProcessEnv();
  }
}
// eslint-disable-next-line no-undef
if (typeof jest === 'undefined' && state().installed) installExitReporter();

module.exports = {
  BLOCKED_CODE,
  UNREACHABLE_LOOPBACK_URL,
  install,
  uninstall,
  violations,
  recordViolation,
  drain,
  formatViolations,
  isLoopbackIp,
  isLocalhostName,
  networkAllowed,
  scrubProviderCredentials,
  PROVIDER_CREDENTIAL_ENV_RE,
  withGuardPreload,
};
