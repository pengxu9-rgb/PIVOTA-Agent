'use strict';
// Loopback-only network guard for the test suites.
//
// WHY. On 2026-10-20 a full jest run under a hand-rolled version of this guard blocked 347
// outbound connects: an ingredient database, retailer search pages, the weather API, the Gemini
// API, Google's OAuth token endpoint, and .test/.example fixture hosts that only fail because DNS
// says no. Every one of those tests was green, because the code under test swallows a failed
// fetch and falls back. So "the suite passes" said nothing about whether it reached the
// internet, and a test that reaches the internet is a test whose result depends on a third
// party's uptime, rate limits and content -- and, for our own hosts, a test that can write to
// production.
//
// WHAT IT ALLOWS. A socket may go to 127.0.0.0/8, ::1 (or ::ffff:127.x), or a unix socket /
// named pipe. A hostname is allowed only if it resolves to one of those: `localhost` through
// the real resolver, `*.localhost` answered as loopback without asking any resolver (RFC 6761
// reserves the whole zone for loopback), or any name through a caller-supplied `lookup` (an SSRF
// test that maps `internal.example` to 127.0.0.1 is still loopback). Every other connect, UDP
// send/connect, and DNS query for any other name is refused with ERR_TEST_NETWORK_BLOCKED and
// recorded.
//
// Deliberately NOT treated as loopback (refused, harmlessly -- no test needs them): the
// shorthand and numeric spellings 127.1 and 2130706433 (net.isIP says they are not addresses,
// so they go to the resolver and are refused there), the hex-mapped ::ffff:7f00:1, and 0.0.0.0
// (a bind address; dialling it is a platform quirk, not a loopback dial).
//
// WHERE IT HOOKS. net.Socket.prototype.connect is the one door every TCP client walks
// through: net.connect, tls.connect (a TLSSocket IS a net.Socket and connects through the same
// method), http/https agents, http2, undici and therefore global fetch, nock/msw passthrough,
// pg, ioredis. dns.lookup / dns.resolve* / dns.Resolver and their promise twins are patched
// too, because a DNS query is itself traffic and is how a fixture host leaks; and so are
// dgram send/connect, for UDP to an address literal (a hostname goes through dns.lookup, or
// through the socket's own `lookup`, which dgram.createSocket gets wrapped like connect's).
//
// CHILDREN. A worker thread inherits its parent's startup flags, which under jest do not
// include the guard (jest installs it from setupFiles, after start), and a child process
// started with an `env` that has no NODE_OPTIONS runs without the preload. The Worker
// constructor and the child_process entry points are wrapped to put the preload (and the
// reporting env below) back. Not covered: a child that is not node, or node started with --no-node-options / -e
// code that deletes NODE_OPTIONS before spawning; and an internal call that bypasses the
// exported functions (none in this repo).
//
// HOW IT FAILS. Refusing the connect is not enough: most callers catch the error and fall
// back, which is exactly how 347 attempts hid behind green tests. So every refusal is
// RECORDED, and the runners turn a non-empty record into a failure:
//   - jest:      tests/_support/netGuardJestHooks.cjs fails the test that was running, for
//                attempts that FILE started. An attempt a file started and left running (a
//                timer, an un-awaited fetch) that fires after the file is done -- in the next
//                file, or after the worker's last file -- is reported against the file that
//                started it by tests/_support/netGuardJestReporter.cjs, which fails the run.
//   - node:test: when this file is preloaded (`node --require`), the process exits non-zero
//                at exit with the list, which fails that suite file.
//   - anywhere:  when NETGUARD_RUN_DIR is set (the jest reporter and the node runner set it),
//                every attempt is also appended there as it happens, from any process or
//                thread, so one that a parent swallowed (a child's exit code, a worker, a
//                worker recycled by --workerIdleMemoryLimit) still fails the run at the end.
//
// OPT-OUT. TEST_ALLOW_NETWORK=1 disables the guard for a local run of an opt-in integration
// test. It is IGNORED when CI=true: CI must never reach the internet.

const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
// From the core module, not the global: under jest this file is evaluated inside a test
// file's sandbox, and the patches it installs outlive that sandbox. Core modules do not.
const { setImmediate: later } = require('node:timers');

const STATE_KEY = Symbol.for('pivota.tests.netGuard');
const BLOCKED_CODE = 'ERR_TEST_NETWORK_BLOCKED';

// The run log (NETGUARD_RUN_DIR) and the report format, shared with the runners that read them.
const { RUN_DIR_ENV, ORIGIN_ENV, readRunLog, formatViolations, withGuardPreload } = require('./netGuardRunLog.cjs');

// The worker's own `process` and `Error`. Under jest the module-level ones belong to the sandbox
// of the test file that happened to load this module first, and the patches below outlive that
// file: an attempt that fires after its teardown got an empty stack from the sandbox's Error.
function fromMainRealm(name, fallback) {
  try {
    return require('node:vm').runInThisContext(name) || fallback;
  } catch (_) {
    return fallback;
  }
}
const realProcess = fromMainRealm('process', process);
const RealError = fromMainRealm('Error', Error);

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
  const s = net[STATE_KEY];
  // Added lazily: a review harness may pre-create the state with only the three fields above.
  // `attribution` carries the test file that STARTED the async work an attempt comes from: the
  // jest hooks enter it once per file, and timers, sockets and promises created by that file
  // keep it after the file is done.
  if (!s.attribution) s.attribution = new AsyncLocalStorage();
  if (!s.seq) s.seq = 0;
  return s;
}

function currentOrigin() {
  const store = state().attribution.getStore();
  return (store && store.origin) || realProcess.env[ORIGIN_ENV] || null;
}

// The test file THIS process or thread runs (a jest file, a node:test suite file). It goes into
// the env so children inherit it, and is remembered so this process's own attempts are not
// labelled as a child's.
function setOwnOrigin(origin) {
  realProcess.env[ORIGIN_ENV] = origin;
  state().ownOrigin = origin;
}

// One file per process AND thread: appends from two writers never interleave inside a line.
function runLogPath() {
  const dir = realProcess.env[RUN_DIR_ENV];
  if (!dir) return null;
  const threadId = require('node:worker_threads').threadId;
  return path.join(dir, `${process.pid}-${threadId}.jsonl`);
}

function appendRunLog(obj) {
  const file = runLogPath();
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
  } catch (_) {
    // The run dir is gone (the run ended while a straggler fired). Nothing left to fail.
  }
}

// The ids a test failed on, so the end-of-run check does not report them a second time.
function markReported(list) {
  for (const v of list) if (v.id) appendRunLog({ reported: v.id });
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
  const limit = RealError.stackTraceLimit;
  RealError.stackTraceLimit = 50;
  const raw = new RealError().stack;
  RealError.stackTraceLimit = limit;
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

// `stack`, when given, is where the attempt was made: a lookup often runs on a later tick than
// the connect() or send() that needs it, where the stack is nothing but node internals.
function record(kind, target, stack) {
  const s = state();
  s.seq += 1;
  const entry = {
    id: `${process.pid}:${require('node:worker_threads').threadId}:${s.seq}`,
    kind,
    target,
    at: Date.now(),
    stack: stack || s.pendingStack || captureStack(),
    // The test file whose work made the attempt (see `attribution`); under node:test, the
    // suite file a child process was spawned for, or null in the suite process itself.
    origin: currentOrigin(),
    // True when the origin came from the env a parent handed this process (a child or worker),
    // not from this process's own test file.
    inChild:
      !(s.attribution.getStore() || {}).origin &&
      Boolean(realProcess.env[ORIGIN_ENV]) &&
      realProcess.env[ORIGIN_ENV] !== s.ownOrigin,
    // Set by the jest hooks (tests/_support/netGuardJestHooks.cjs): what was RUNNING when the
    // attempt happened, which is not always what started it. Null under node:test.
    testPath: s.testPath || null,
  };
  s.violations.push(entry);
  appendRunLog({
    id: entry.id,
    kind,
    target,
    origin: entry.origin,
    inChild: entry.inChild,
    testPath: entry.testPath,
    argv: process.argv.slice(1, 3).join(' '),
    stack: entry.stack,
  });
  return entry;
}

function addressesOf(address) {
  if (Array.isArray(address)) return address.map((a) => (a && typeof a === 'object' ? a.address : a));
  return [address];
}

// Wrap a lookup function (the real dns.lookup or a caller's own) so the connect or UDP send
// proceeds only if EVERY address it produced is loopback. `describe(name)` names the target in
// the report.
//
// `stack` is captured when connect() is CALLED. The lookup itself often runs on a later tick
// (Happy Eyeballs defers it), where the stack is nothing but node internals; a refusal inside
// the lookup (guarded dns.lookup records synchronously) picks it up from `pendingStack`.
function loopbackOnlyLookup(lookup, kind, describe, stack) {
  return function guardedLookup(name, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    const s = state();
    const outer = s.pendingStack;
    s.pendingStack = stack || outer;
    try {
      lookup(name, opts, (err, address, family) => {
        if (err) return cb(err);
        const outside = addressesOf(address).find((a) => !isLoopbackIp(a));
        if (outside) {
          const target = `${describe(name)} (resolved to ${outside})`;
          record(kind, target, stack);
          return cb(blockedError(kind, target));
        }
        return cb(null, address, family);
      });
    } finally {
      s.pendingStack = outer;
    }
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
    const guarded = { ...options, lookup: loopbackOnlyLookup(lookup, 'connect', () => `${host}:${port}`, connectStack) };
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
    // `x.localhost` is loopback by definition (RFC 6761), but the system resolver may still
    // send it to a DNS server. Answer it here instead.
    if (isLocalhostName(hostname) && String(hostname).toLowerCase().replace(/\.$/, '') !== 'localhost') {
      const options = typeof opts === 'number' ? { family: opts } : opts || {};
      const v6 = options.family === 6 || options.family === 'IPv6';
      const address = v6 ? '::1' : '127.0.0.1';
      const family = v6 ? 6 : 4;
      later(() => (options.all ? cb(null, [{ address, family }]) : cb(null, address, family)));
      return undefined;
    }
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
    record('dns', String(hostname));
    const err = blockedError('dns lookup', String(hostname));
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

// UDP. A hostname target goes through the socket's lookup (dns.lookup, guarded above, or the
// caller's own, wrapped in createSocket below); an address literal does not, so it is checked
// here. Fails the way a send to a dead address fails: on the callback, or as an 'error' event on
// the socket when there is no callback.
//
// Where an unconnected send goes, read the way dgram's own send() reads its arguments:
// send(msg[, offset, length], port[, address][, callback]). The port may be a numeric string, so
// "the first string" is not the address. No address means loopback (dgram's default).
function udpSendTarget(args) {
  const [, offset, length, port, address, callback] = args;
  let target;
  let cb;
  if (address || (port && typeof port !== 'function')) {
    target = address;
    cb = callback;
  } else {
    target = length;
    cb = port;
  }
  if (typeof target === 'function') {
    cb = target;
    target = undefined;
  }
  return { address: target, cb: typeof cb === 'function' ? cb : undefined };
}

// The peer of a connected socket, or null. A connected send takes no address: it goes to the
// peer, which connect() checked -- unless the socket was connected before the guard was installed.
function udpPeer(socket) {
  try {
    return socket.remoteAddress();
  } catch (_) {
    return null;
  }
}

function failUdp(socket, kind, target, cb) {
  record(kind, target);
  const err = blockedError(kind, target);
  later(() => (cb ? cb(err) : socket.emit('error', err)));
}

function patchDgram(originals) {
  const proto = dgram.Socket.prototype;
  originals.udpSend = proto.send;
  proto.send = function guardedUdpSend(...args) {
    const peer = udpPeer(this);
    if (peer) {
      if (!isLoopbackIp(peer.address)) {
        return failUdp(this, 'udp send', `${peer.address}:${peer.port}`, args.slice(1).find((x) => typeof x === 'function'));
      }
      return originals.udpSend.apply(this, args);
    }
    const { address, cb } = udpSendTarget(args);
    if (typeof address === 'string' && net.isIP(stripBrackets(address)) && !isLoopbackIp(address)) {
      return failUdp(this, 'udp send', address, cb);
    }
    return originals.udpSend.apply(this, args);
  };
  originals.udpConnect = proto.connect;
  if (typeof originals.udpConnect === 'function') {
    proto.connect = function guardedUdpConnect(port, address, cb) {
      const callback = typeof address === 'function' ? address : cb;
      const host = typeof address === 'string' ? address : null;
      if (host && net.isIP(stripBrackets(host)) && !isLoopbackIp(host)) {
        return failUdp(this, 'udp connect', `${host}:${port}`, callback);
      }
      return originals.udpConnect.apply(this, arguments);
    };
  }
  // createSocket({ lookup }) resolves every hostname send/connect through the caller's function,
  // which may map any name anywhere: judge where it points, as for a TCP connect. The same
  // function resolves the BIND address ('0.0.0.0' unless given), so an IP literal passes through
  // unjudged: as a destination it was already judged above, as itself.
  originals.createSocket = dgram.createSocket;
  dgram.createSocket = function guardedCreateSocket(type, listener) {
    if (type && typeof type === 'object' && typeof type.lookup === 'function') {
      const own = type.lookup;
      const judged = loopbackOnlyLookup(own, 'udp', (name) => String(name), null);
      type = { ...type, lookup: (name, ...rest) => (isPassThroughName(name) ? own(name, ...rest) : judged(name, ...rest)) };
    }
    return originals.createSocket.call(this, type, listener);
  };
}

// CHILDREN AND WORKERS: put the preload (and the run dir / origin) back into an `env` or
// `execArgv` the caller replaced. Without them a child runs unguarded, and a blocked attempt
// inside one shows up, at best, as its exit code.
function reportingEnv() {
  const out = {};
  for (const key of [RUN_DIR_ENV, ORIGIN_ENV]) {
    if (realProcess.env[key]) out[key] = realProcess.env[key];
  }
  const origin = currentOrigin();
  if (origin) out[ORIGIN_ENV] = origin;
  return out;
}

function guardedEnv(env) {
  if (!env || typeof env !== 'object') return env;
  return { ...reportingEnv(), ...env, NODE_OPTIONS: withGuardPreload(env.NODE_OPTIONS) };
}

const CHILD_ENTRY_POINTS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

// The options object is the one plain object among the arguments. With no `env` the child
// inherits the real process env, which already carries the preload and origin.
function withGuardedOptions(args) {
  const i = args.findIndex((a) => a && typeof a === 'object' && !Array.isArray(a));
  if (i >= 0 && args[i].env) {
    const copy = args.slice();
    copy[i] = { ...args[i], env: guardedEnv(args[i].env) };
    return copy;
  }
  return args;
}

function patchChildProcess(originals) {
  const cp = require('node:child_process');
  const { promisify } = require('node:util');
  originals.childProcess = {};
  for (const name of CHILD_ENTRY_POINTS) {
    const original = cp[name];
    if (typeof original !== 'function') continue;
    originals.childProcess[name] = original;
    const guarded = function guardedChildEntry(...args) {
      return original.apply(this, withGuardedOptions(args));
    };
    // exec and execFile carry a util.promisify.custom that resolves {stdout, stderr}; a wrapper
    // without it would promisify to a bare stdout string. Keep it, guarded the same way.
    const custom = original[promisify.custom];
    if (typeof custom === 'function') {
      Object.defineProperty(guarded, promisify.custom, {
        value: function guardedPromisified(...args) {
          return custom.apply(this, withGuardedOptions(args));
        },
        configurable: true,
      });
    }
    cp[name] = guarded;
  }
}

function patchWorkers(originals) {
  const wt = require('node:worker_threads');
  const OriginalWorker = wt.Worker;
  originals.Worker = OriginalWorker;
  class GuardedWorker extends OriginalWorker {
    constructor(filename, options = {}) {
      const opts = { ...options };
      const preload = `--require=${__filename}`;
      // An explicit execArgv replaces the parent's, preload included. With none, the worker
      // inherits the flags this process STARTED with, which under jest do not include the guard
      // (it comes from setupFiles): pass them explicitly, plus the preload.
      const inherited = !Array.isArray(opts.execArgv);
      const execArgv = inherited ? realProcess.execArgv : opts.execArgv;
      if (!execArgv.some((a) => String(a).includes(__filename))) opts.execArgv = [...execArgv, preload];
      // A worker's own env object (not SHARE_ENV) gets the run dir and origin too.
      if (opts.env && typeof opts.env === 'object') opts.env = { ...reportingEnv(), ...opts.env };
      try {
        super(filename, opts);
      } catch (err) {
        // Some startup flags (--expose-gc, ...) are process-wide and a worker refuses them when
        // passed explicitly, though it inherits them silently. Keep the preload, drop the rest.
        if (!inherited || !err || err.code !== 'ERR_WORKER_INVALID_EXEC_ARGV') throw err;
        super(filename, { ...opts, execArgv: [preload] });
      }
    }
  }
  wt.Worker = GuardedWorker;
}

function install() {
  const s = state();
  if (s.installed || networkAllowed()) return s.installed;
  const originals = {};
  patchSocketConnect(originals);
  patchLookup(originals);
  patchResolvers(originals);
  patchDgram(originals);
  patchChildProcess(originals);
  patchWorkers(originals);
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
  dgram.Socket.prototype.send = o.udpSend;
  if (o.udpConnect) dgram.Socket.prototype.connect = o.udpConnect;
  dgram.createSocket = o.createSocket;
  Object.assign(require('node:child_process'), o.childProcess);
  require('node:worker_threads').Worker = o.Worker;
  s.installed = false;
  s.originals = null;
}

function violations() {
  return state().violations.slice();
}

// Returns and clears everything recorded so far.
function drain() {
  const s = state();
  return s.violations.splice(0, s.violations.length);
}

// `node --require tests/_support/netGuard.cjs` (the node:test runner): report and fail the
// process at exit. Under jest this file runs inside a test context where the `jest` object is
// injected, and the jest hooks do the reporting instead.
//
// A suite file's own process fails itself, so what it prints is marked reported. A process it
// spawned (no NODE_TEST_CONTEXT of its own, or an origin already set) fails only itself, which
// its parent may ignore; those attempts stay in the run dir for the runner's end-of-run check.
function installExitReporter() {
  const s = state();
  if (s.exitReporter) return;
  s.exitReporter = true;
  const isSuiteProcess = Boolean(process.env.NODE_TEST_CONTEXT) && !process.env[ORIGIN_ENV];
  if (isSuiteProcess && process.argv[1]) {
    setOwnOrigin(path.relative(process.cwd(), process.argv[1]) || process.argv[1]);
  }
  process.on('exit', (code) => {
    const list = drain();
    if (!list.length) return;
    process.stderr.write(`\n${formatViolations(list)}\n`);
    if (isSuiteProcess) markReported(list);
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

// Under jest, `process` is a per-file sandbox copy; a child process a test spawns inherits the
// worker's REAL environment instead. Give that environment the preload and the scrub too, so a
// `node` child of a jest test (a script test) is guarded and fails the same way. vm's main
// context is the worker's own realm, where `process` is the real one.
function guardRealProcessEnv() {
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
  drain,
  markReported,
  setOwnOrigin,
  readRunLog,
  attribution: () => state().attribution,
  RUN_DIR_ENV,
  ORIGIN_ENV,
  formatViolations,
  isLoopbackIp,
  isLocalhostName,
  networkAllowed,
  scrubProviderCredentials,
  PROVIDER_CREDENTIAL_ENV_RE,
  withGuardPreload,
};
