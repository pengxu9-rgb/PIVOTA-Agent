'use strict';
// For nock-based suites: no unmatched request leaves the process, and the ones nobody expected
// are still reported.
//
// nock's default is to PASS THROUGH any request whose host has no interceptor. A suite that
// mocks the backend but not the enrichment sources behind it (INCIDecoder, retailer search
// pages, DailyMed, the product page itself) therefore sent those to the real internet: on a
// runner with egress the test asserted against whatever the live site answered that day, and
// offline it saw a network error. The loopback guard (netGuard.cjs) catches the passthrough at
// the socket, but the stack is lost inside msw's interceptor, so the report cannot say which
// URL was asked for.
//
// `nockOffline(nock, { down })` turns passthrough off (loopback stays allowed, for supertest
// and local listeners) and declares the hosts in `down` as unreachable: an unmatched request
// to one of them fails at once with nock's NetConnectNotAllowedError, which is what "that
// source is down" looks like to the caller. An unmatched request to any OTHER host fails the
// same way and is ALSO recorded as a guard violation with its full URL, so the test goes red
// and names it. Interceptors a test registers still win: only unmatched requests reach here.
//
// Returns a restore function for afterAll.

const guard = require('./netGuard.cjs');

function hostOnly(hostPort) {
  const s = String(hostPort || '').toLowerCase();
  if (s.startsWith('[')) return s.slice(1, s.indexOf(']'));
  const parts = s.split(':');
  // A bare IPv6 literal has several colons; host:port has exactly one.
  return parts.length === 2 ? parts[0] : s;
}

function isLoopbackHost(host) {
  const h = hostOnly(host);
  return guard.isLoopbackIp(h) || guard.isLocalhostName(h);
}

function nockOffline(nock, { down = [] } = {}) {
  const downHosts = new Set(down.map((h) => String(h).toLowerCase()));
  nock.disableNetConnect();
  nock.enableNetConnect((hostPort) => isLoopbackHost(hostPort));

  // nock emits 'no match' with ONE argument (the request options) when no interceptor exists
  // for the host -- the passthrough case. Its router also emits it, with three arguments, when
  // the host IS mocked but no interceptor matched; that request fails inside nock and never
  // touches the network, so it is not ours to report.
  const onNoMatch = (...args) => {
    if (args.length !== 1) return;
    const o = args[0] || {};
    const host = String(o.hostname || hostOnly(o.host) || '').toLowerCase();
    if (!host || isLoopbackHost(host) || downHosts.has(host)) return;
    const url = `${o.proto || String(o.protocol || 'http:').replace(/:$/, '')}://${o.host || host}${o.path || ''}`;
    guard.recordViolation('unmocked request (nock)', `${o.method || 'GET'} ${url}`);
  };
  nock.emitter.on('no match', onNoMatch);

  return function restore() {
    nock.emitter.removeListener('no match', onNoMatch);
    nock.enableNetConnect();
  };
}

module.exports = { nockOffline };
