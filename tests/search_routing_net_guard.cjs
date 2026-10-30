'use strict';

// LOOPBACK-ONLY NETWORK GUARD for the find_products_multi search-routing tests. Required as the FIRST
// statement of tests/find_products_multi_search_routing_terms.node.test.cjs and
// tests/integration/invoke.find_products_multi_search_routing.test.js; it can also be preloaded into
// any test process with NODE_OPTIONS=--require=<this file>. Same shape as the readiness-eval guard.
//
// WHY: these tests drive the real invoke route, whose lanes can reach a database, an upstream API and
// an LLM provider. nock and a mocked db stop the ones they know about; a test must never be ABLE to reach
// a real host, whatever the code under test (or a mutant of it) does. So the guard sits below every
// client library:
//
//   * net.Socket.prototype.connect — every TCP/TLS connection in Node goes through it: http/https.request
//     (Agent -> net.createConnection), the built-in fetch (undici -> net.connect / tls.connect), tls.connect
//     (TLSSocket inherits connect), http2.connect. Only loopback IP LITERALS (127.0.0.0/8, ::1,
//     ::ffff:127.x) and IPC paths are allowed. A hostname — any hostname, including "localhost" — is refused
//     BEFORE any DNS lookup, so not even a resolver packet leaves.
//   * dns.lookup / dns.resolve* / dns.promises.* / dns.Resolver — refused for every name, so code that resolves
//     first and connects later is stopped at the resolve. A lookup of an IP literal passes (it resolves
//     nothing): that is how server.listen(port, '::') binds, and a dial to the address meets the connect guard.
//   * dgram sockets — send/connect refused unless the address is a loopback literal.
//
// A refusal THROWS synchronously (an Error with code ERR_SEARCH_ROUTING_NET_GUARD) and is counted in
// `state.blocked` (this module's export). `passed` counts connections handed to the real connect, all of
// which are loopback by construction.
//
// ONE GUARD PER PROCESS, AND ITS STATE NEVER ON globalThis: under jest, globalThis is the test file's
// sandbox, which jest 30 tears down after the file (globalsCleanup 'soft'), turning state left there into
// a self-recursing setter that every later socket in the worker trips over. The state hangs off the
// node:net module object instead (one per process, never sandboxed); see
// tests/agent_readiness_eval/_net_guard.cjs, which has the same shape.

const net = require('node:net');
const { AsyncLocalStorage } = require('node:async_hooks');
const dns = require('node:dns');
const dgram = require('node:dgram');

const STATE_KEY = '__SEARCH_ROUTING_NET_GUARD__';
const HOLDER = Symbol.for('searchRouting.netGuard');
const ErrorCtor = Error;
const StringCtor = String;
const isArray = Array.isArray;

// ATTRIBUTION. A refusal records the async context it happened in. A test file runs its own work inside
// `attribution.run({ owner }, fn)` -- the app boot and every request -- and asserts on the refusals
// that carry its owner: everything the routing code it drives tries, synchronously or later, carries
// that context, while another suite's late timer in a shared Jest worker does not.
// It lives ON the shared state object, so a preloaded guard (NODE_OPTIONS=--require) and a test file's
// own require of this module -- which finds that state and installs nothing -- use ONE storage, as do
// all the test files one jest worker runs.

function isLoopbackLiteral(host) {
  if (typeof host !== 'string') return false;
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const v = net.isIP(h);
  if (v === 4) return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
  if (v === 6) return h === '::1' || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '0:0:0:0:0:0:0:1';
  return false;
}

function install() {
  if (net[HOLDER]) return net[HOLDER];
  const state = { installed: true, blocked: [], passed: 0, originalConnectCalls: 0, attribution: new AsyncLocalStorage() };
  Object.defineProperty(net, HOLDER, { value: state, enumerable: false, configurable: false, writable: false });

  const refuse = (what, target) => {
    const msg = `search-routing net guard: refused ${what} to ${target} (tests may only reach loopback IP literals)`;
    const store = state.attribution.getStore();
    state.blocked.push({ what, target: StringCtor(target), owner: store && store.owner ? store.owner : null });
    const err = new ErrorCtor(msg);
    err.code = 'ERR_SEARCH_ROUTING_NET_GUARD';
    throw err;
  };

  // ---- TCP / TLS ------------------------------------------------------------------------------------
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let a = args;
    if (isArray(a[0])) a = a[0]; // net.connect() hands the prototype method its normalized [options, cb]
    let opts;
    if (a[0] !== null && typeof a[0] === 'object') opts = a[0];
    else if (typeof a[0] === 'string' && !/^\d+$/.test(a[0])) opts = { path: a[0] };
    else opts = { port: a[0], host: typeof a[1] === 'string' ? a[1] : undefined };
    if (opts.path !== undefined && opts.path !== null && opts.port === undefined) {
      state.passed += 1;
      state.originalConnectCalls += 1;
      return originalConnect.apply(this, args);
    }
    // Node's default host is "localhost", which needs a DNS lookup: refused like any other name.
    const host = opts.host === undefined || opts.host === null ? 'localhost' : opts.host;
    if (!isLoopbackLiteral(host)) refuse('connect', `${host}:${opts.port}`);
    state.passed += 1;
    state.originalConnectCalls += 1;
    return originalConnect.apply(this, args);
  };

  // ---- DNS ------------------------------------------------------------------------------------------
  // A lookup of an IP LITERAL answers with the literal itself and never reaches a resolver. It is how
  // server.listen(port, '::') or '0.0.0.0' binds, so it passes; a dial to that address still meets the
  // connect guard above. Names, lookupService, reverse and every resolve* stay refused.
  const guardName = (fnName, target) => {
    if ((fnName === 'lookup' || fnName === 'promises.lookup') && typeof target === 'string' && net.isIP(target) !== 0) return;
    if (!isLoopbackLiteral(target)) refuse(`dns.${fnName}`, target);
  };
  const wrapDns = (obj, label) => {
    for (const fn of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname',
      'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'resolvePtr', 'resolveNaptr', 'resolveSoa', 'resolveCaa', 'reverse']) {
      if (typeof obj[fn] !== 'function') continue;
      const original = obj[fn];
      obj[fn] = function guardedDns(name, ...rest) {
        guardName(`${label}${fn}`, name);
        return original.call(this, name, ...rest);
      };
    }
  };
  wrapDns(dns, '');
  wrapDns(dns.promises, 'promises.');
  if (dns.Resolver && dns.Resolver.prototype) wrapDns(dns.Resolver.prototype, 'Resolver.');
  if (dns.promises.Resolver && dns.promises.Resolver.prototype) wrapDns(dns.promises.Resolver.prototype, 'promises.Resolver.');

  // ---- UDP ------------------------------------------------------------------------------------------
  const originalSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function guardedSend(msg, ...rest) {
    const address = rest.find((x) => typeof x === 'string');
    if (!isLoopbackLiteral(address || 'localhost')) refuse('udp send', address);
    return originalSend.call(this, msg, ...rest);
  };
  const originalUdpConnect = dgram.Socket.prototype.connect;
  if (typeof originalUdpConnect === 'function') {
    dgram.Socket.prototype.connect = function guardedUdpConnect(port, address, ...rest) {
      if (!isLoopbackLiteral(typeof address === 'string' ? address : 'localhost')) refuse('udp connect', `${address}:${port}`);
      return originalUdpConnect.call(this, port, address, ...rest);
    };
  }
  return state;
}

const state = install();
module.exports = { state, isLoopbackLiteral, STATE_KEY, attribution: state.attribution };
