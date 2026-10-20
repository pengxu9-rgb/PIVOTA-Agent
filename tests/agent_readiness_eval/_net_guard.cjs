'use strict';

// GLOBAL NETWORK GUARD for every readiness-eval test. Required as the FIRST statement of each
// tests/agent_readiness_eval/*.node.test.cjs file (a test in this directory asserts that).
//
// WHY: on 2026-10-20 a refusal test called the harness with real fetch against a production hostname and
// relied on the harness's own refusal to stop it. A mutation sweep removed the refusal, and the test sent
// production traffic from a laptop. A test must never be ABLE to reach a real host, whatever the code under
// test does. So the guard sits below every client library:
//
//   * net.Socket.prototype.connect — every TCP/TLS connection in Node goes through it: http/https.request
//     (Agent -> net.createConnection), the built-in fetch (undici -> net.connect / tls.connect), tls.connect
//     (TLSSocket inherits connect), http2.connect. Only loopback IP LITERALS (127.0.0.0/8, ::1,
//     ::ffff:127.x) and IPC paths are allowed. A hostname — any hostname, including "localhost" — is refused
//     BEFORE any DNS lookup, so not even a resolver packet leaves.
//   * dns.lookup / dns.resolve* / dns.promises.* / dns.Resolver — refused for every name, so code that resolves
//     first and connects later is stopped at the resolve.
//   * dgram sockets — send/connect refused unless the address is a loopback literal.
//
// A refusal THROWS synchronously (an Error with code ERR_READINESS_NET_GUARD) and is counted in
// globalThis.__READINESS_NET_GUARD__.blocked. `passed` counts connections handed to the real connect, all of
// which are loopback by construction.

const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');

const STATE_KEY = '__READINESS_NET_GUARD__';

function isLoopbackLiteral(host) {
  if (typeof host !== 'string') return false;
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const v = net.isIP(h);
  if (v === 4) return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
  if (v === 6) return h === '::1' || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '0:0:0:0:0:0:0:1';
  return false;
}

function install() {
  if (globalThis[STATE_KEY]) return globalThis[STATE_KEY];
  const state = { installed: true, blocked: [], passed: 0, originalConnectCalls: 0 };
  globalThis[STATE_KEY] = state;

  const refuse = (what, target) => {
    const msg = `readiness-eval net guard: refused ${what} to ${target} (tests may only reach loopback IP literals)`;
    state.blocked.push({ what, target: String(target) });
    const err = new Error(msg);
    err.code = 'ERR_READINESS_NET_GUARD';
    throw err;
  };

  // ---- TCP / TLS ------------------------------------------------------------------------------------
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let a = args;
    if (Array.isArray(a[0])) a = a[0]; // net.connect() hands the prototype method its normalized [options, cb]
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
  const guardName = (fnName, target) => {
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

/** A fetch for refusal tests: counts and throws on ANY call, so "zero calls" is an assertion, not a hope. */
function throwingFetch() {
  const f = async (url) => {
    f.calls.push(String(url));
    throw new Error(`readiness-eval test: fetch must not be called (was called for ${url})`);
  };
  f.calls = [];
  return f;
}

const state = install();
module.exports = { state, isLoopbackLiteral, throwingFetch, STATE_KEY };
