'use strict';

// WHOLE-FILE NOCK GUARD for node:test and jest suites: no request may leave for a real host, and
// a request that reaches no interceptor FAILS the test it happened in. The one nock helper in
// this repo; use it rather than a hand-rolled 'no match' listener.
//
// Refusal alone is not enough. nock.disableNetConnect() makes an unmocked request reject, but code
// such as src/auroraBff/destinationResolver.js catches every fetch error and degrades to a fallback,
// so a test that silently went to the network (or tried to) still passes. nock emits 'no match' for
// every request it has no interceptor for -- a host nothing mocks, and a mocked host whose
// interceptors all missed -- and this guard records those whose host is not loopback and throws
// them from afterEach, naming the request. Loopback (127/8, ::1, localhost, *.localhost) stays open
// for supertest and local listeners.
//
// `down`: hosts that are deliberately unreachable in this file. An unmatched request to one fails
// at once with nock's NetConnectNotAllowedError -- what "that source is down" looks like to the
// caller -- and is NOT reported. Use it for a source a whole file treats as down, never as a way to
// silence a request a test should have mocked.
//
// Usage, at the top of a test file (the same line in both runners):
//   const nock = require('nock');
//   guardFileNetwork(test, nock);                       // or guardFileNetwork(test, nock, { down: ['catalog.test'] })
// Under node:test, `test` carries before/afterEach/after; under jest the global `test` does not, and
// jest's beforeAll/afterEach/afterAll are used. The net-connect setting and the listener are undone
// in the after hook.

const LOOPBACK_HOSTNAME = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|[a-z0-9.-]+\.localhost|::1|\[::1\])$/i;

function hostnameOf(host) {
  const raw = String(host || '');
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1);
  return raw.replace(/:\d+$/, '');
}

function describeRequest(reqOrOptions, options) {
  // nock 14 emits (options) when no interceptor exists for the host and (req, options, body) when the
  // host has interceptors but none matched.
  const o = options && typeof options === 'object' ? options : reqOrOptions || {};
  const hostname = String(o.hostname || hostnameOf(o.host)).toLowerCase();
  const proto = o.proto || String(o.protocol || 'http').replace(/:$/, '');
  return { hostname, text: `${o.method || 'GET'} ${proto}://${o.host || hostname}${o.path || ''}` };
}

function hooksFor(test) {
  if (test && typeof test.before === 'function') {
    return { before: test.before, afterEach: test.afterEach, after: test.after };
  }
  /* global beforeAll, afterEach, afterAll */
  if (typeof beforeAll === 'function') return { before: beforeAll, afterEach, after: afterAll };
  throw new Error('guardFileNetwork: pass node:test `test`, or call it from a jest test file');
}

function guardFileNetwork(test, nock, { down = [] } = {}) {
  const hooks = hooksFor(test);
  const downHosts = new Set(down.map((h) => String(h).toLowerCase()));
  const unmatched = [];
  const onNoMatch = (reqOrOptions, options) => {
    const { hostname, text } = describeRequest(reqOrOptions, options);
    if (!LOOPBACK_HOSTNAME.test(hostname) && !downHosts.has(hostname)) unmatched.push(text);
  };
  const flush = (where) => {
    if (!unmatched.length) return;
    const list = unmatched.splice(0);
    throw new Error(`request(s) reached no nock interceptor ${where}: ${list.join(' | ')}`);
  };

  hooks.before(() => {
    nock.disableNetConnect();
    nock.enableNetConnect((host) => LOOPBACK_HOSTNAME.test(hostnameOf(host)));
    nock.emitter.on('no match', onNoMatch);
  });
  hooks.afterEach(() => flush('during this test'));
  hooks.after(() => {
    nock.emitter.removeListener('no match', onNoMatch);
    nock.cleanAll();
    nock.enableNetConnect();
    flush('after the last test');
  });
}

module.exports = { guardFileNetwork, LOOPBACK_HOSTNAME };
