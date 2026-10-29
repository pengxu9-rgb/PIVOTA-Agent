'use strict';

// WHOLE-FILE NOCK GUARD for node:test suites: no request may leave for a real host, and a request
// that reaches no interceptor FAILS the test it happened in.
//
// Refusal alone is not enough. nock.disableNetConnect() makes an unmocked request reject, but code
// such as src/auroraBff/destinationResolver.js catches every fetch error and degrades to a fallback,
// so a test that silently went to the network (or tried to) still passes. nock emits 'no match' for
// every request it has no interceptor for; this guard records those whose host is not loopback and
// throws them from afterEach, naming the request. Loopback stays open for supertest.
//
// Usage, at the top of a test file:
//   const nock = require('nock');
//   guardFileNetwork(test, nock);
// Both the net-connect setting and the listener are undone in an after hook.

const LOOPBACK_HOSTNAME = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|::1|\[::1\])$/i;

function hostnameOf(host) {
  const raw = String(host || '');
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1);
  return raw.replace(/:\d+$/, '');
}

function describeRequest(reqOrOptions, options) {
  // nock 14 emits (options) when no interceptor exists for the host and (req, options, body) when the
  // host has interceptors but none matched.
  const o = options && typeof options === 'object' ? options : reqOrOptions || {};
  const hostname = o.hostname || hostnameOf(o.host);
  const proto = o.proto || String(o.protocol || 'http').replace(/:$/, '');
  return { hostname, text: `${o.method || 'GET'} ${proto}://${o.host || hostname}${o.path || ''}` };
}

function guardFileNetwork(test, nock) {
  const unmatched = [];
  const onNoMatch = (reqOrOptions, options) => {
    const { hostname, text } = describeRequest(reqOrOptions, options);
    if (!LOOPBACK_HOSTNAME.test(hostname)) unmatched.push(text);
  };
  const flush = (where) => {
    if (!unmatched.length) return;
    const list = unmatched.splice(0);
    throw new Error(`request(s) reached no nock interceptor ${where}: ${list.join(' | ')}`);
  };

  test.before(() => {
    nock.disableNetConnect();
    nock.enableNetConnect((host) => LOOPBACK_HOSTNAME.test(hostnameOf(host)));
    nock.emitter.on('no match', onNoMatch);
  });
  test.afterEach(() => flush('during this test'));
  test.after(() => {
    nock.emitter.removeListener('no match', onNoMatch);
    nock.cleanAll();
    nock.enableNetConnect();
    flush('after the last test');
  });
}

module.exports = { guardFileNetwork, LOOPBACK_HOSTNAME };
