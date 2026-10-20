'use strict';

// The loopback caller assertion (src/guardrails/loopbackCallerAssertion.js): an MCP door's resolved caller,
// carried on the tool's call back into this process so the invoke limiter keys on it. The property that
// matters is that nobody OUTSIDE this process can mint or replay one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  LOOPBACK_CALLER_HEADER,
  enforcedLoopbackCaller,
  loopbackCallerHeaders,
  signLoopbackCaller,
  verifyLoopbackCaller,
} = require('../src/guardrails/loopbackCallerAssertion');

const HEADER = LOOPBACK_CALLER_HEADER.toLowerCase();
const NOW = 1_800_000_000;

function loopbackReq(value, { remote = '127.0.0.1', xff } = {}) {
  return {
    headers: { [HEADER]: value, ...(xff ? { 'x-forwarded-for': xff } : {}) },
    socket: { remoteAddress: remote },
  };
}

const CALLER = { tier: 'anonymous', key: 'anonymous:0123456789abcdef', agent_id: null };

test('a value this process signed verifies over loopback and names the caller', () => {
  const token = signLoopbackCaller({ tier: 'partner', key: 'partner:aaaa', agentId: 'agent_p' }, { nowSec: NOW });
  assert.deepEqual(verifyLoopbackCaller(loopbackReq(token), { nowSec: NOW }), {
    tier: 'partner', key: 'partner:aaaa', agent_id: 'agent_p',
  });
  assert.deepEqual(verifyLoopbackCaller(loopbackReq(token, { remote: '::1' }), { nowSec: NOW })?.key, 'partner:aaaa');
  assert.deepEqual(verifyLoopbackCaller(loopbackReq(token, { remote: '::ffff:127.0.0.1' }), { nowSec: NOW })?.key, 'partner:aaaa');
});

test('a value signed with any other secret is refused (another process, or a guess)', () => {
  const foreign = signLoopbackCaller(CALLER, { nowSec: NOW, secret: crypto.randomBytes(32) });
  assert.equal(verifyLoopbackCaller(loopbackReq(foreign), { nowSec: NOW }), null);
});

test('tampering with the payload, the signature or the version is refused', () => {
  const token = signLoopbackCaller(CALLER, { nowSec: NOW });
  const [v, payload, sig] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ t: 'partner', k: 'partner:mine', ts: NOW }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  for (const bad of [
    `${v}.${forgedPayload}.${sig}`,
    `${v}.${payload}.${sig.slice(0, -2)}AA`,
    `v2.${payload}.${sig}`,
    `${v}.${payload}`,
    `${token}.extra`,
    '',
    'x'.repeat(5000),
  ]) {
    assert.equal(verifyLoopbackCaller(loopbackReq(bad), { nowSec: NOW }), null, bad.slice(0, 40));
  }
});

test('a valid value is honoured ONLY over a loopback socket with no X-Forwarded-For', () => {
  const token = signLoopbackCaller(CALLER, { nowSec: NOW });
  // Routed in from outside: Cloud Run / the load balancer always set X-Forwarded-For.
  assert.equal(verifyLoopbackCaller(loopbackReq(token, { xff: '203.0.113.9' }), { nowSec: NOW }), null);
  assert.equal(verifyLoopbackCaller(loopbackReq(token, { remote: '169.254.1.1' }), { nowSec: NOW }), null);
  assert.equal(verifyLoopbackCaller(loopbackReq(token, { remote: '10.0.0.5' }), { nowSec: NOW }), null);
  assert.equal(verifyLoopbackCaller({ headers: { [HEADER]: token } }, { nowSec: NOW }), null);
});

test('a captured value expires: it cannot be replayed a minute later, or used before it was minted', () => {
  const token = signLoopbackCaller(CALLER, { nowSec: NOW });
  assert.ok(verifyLoopbackCaller(loopbackReq(token), { nowSec: NOW + 60 }));
  assert.equal(verifyLoopbackCaller(loopbackReq(token), { nowSec: NOW + 61 }), null);
  assert.equal(verifyLoopbackCaller(loopbackReq(token), { nowSec: NOW - 61 }), null);
});

test('only the two limited tiers can be asserted; first-party is never carried', () => {
  assert.equal(verifyLoopbackCaller(loopbackReq(signLoopbackCaller({ tier: 'first_party', key: 'k' }, { nowSec: NOW })), { nowSec: NOW }), null);
  const env = { MCP_CALLER_LIMITS_MODE: 'enforce' };
  assert.deepEqual(loopbackCallerHeaders({ limit_caller: { tier: 'first_party', key: 'first_party:x' } }, { env }), {});
  assert.deepEqual(loopbackCallerHeaders({ limit_caller: { tier: 'anonymous', key: '' } }, { env }), {});
  assert.deepEqual(loopbackCallerHeaders({}, { env }), {});
  assert.deepEqual(loopbackCallerHeaders(null, { env }), {});
});

test('headers are built from the door\'s invoke context, and not at all when limits are off', () => {
  const ctx = { limit_caller: { ...CALLER } };
  assert.deepEqual(loopbackCallerHeaders(ctx, { env: { MCP_CALLER_LIMITS_MODE: 'off' } }), {});
  assert.deepEqual(loopbackCallerHeaders(ctx, { env: {} }), {});
  for (const mode of ['observe', 'enforce']) {
    const headers = loopbackCallerHeaders(ctx, { env: { MCP_CALLER_LIMITS_MODE: mode }, nowSec: NOW });
    const value = headers[LOOPBACK_CALLER_HEADER];
    assert.ok(value, mode);
    assert.deepEqual(verifyLoopbackCaller(loopbackReq(value), { nowSec: NOW }), CALLER);
  }
});

test('the invoke limiter acts on the assertion only in enforce mode', () => {
  const token = signLoopbackCaller(CALLER);
  const prior = process.env.MCP_CALLER_LIMITS_MODE;
  try {
    process.env.MCP_CALLER_LIMITS_MODE = 'observe';
    assert.equal(enforcedLoopbackCaller(loopbackReq(token)), null);
    process.env.MCP_CALLER_LIMITS_MODE = 'enforce';
    assert.deepEqual(enforcedLoopbackCaller(loopbackReq(token)), CALLER);
    assert.equal(enforcedLoopbackCaller(loopbackReq(token, { xff: '203.0.113.9' })), null);
  } finally {
    if (prior === undefined) delete process.env.MCP_CALLER_LIMITS_MODE;
    else process.env.MCP_CALLER_LIMITS_MODE = prior;
  }
});
