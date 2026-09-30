'use strict';

// authThrottle in isolation: bucket arithmetic, the fail-open policy, and the kill switch.
// The HTTP behaviour is pinned in aurora_auth_throttle_routes.node.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuroraAuthThrottle, __test__ } = require('../src/auroraBff/authThrottle');

function reqFrom(ip) {
  return { headers: { 'x-forwarded-for': `${ip}, 35.190.0.1` }, socket: { remoteAddress: '10.0.0.1' } };
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(overrides)) {
    previous[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('an IP bucket refills over its period: 20/hour means one more request every 180s', () => {
  let t = 1_000_000;
  const throttle = createAuroraAuthThrottle({ now: () => t });
  for (let i = 0; i < 20; i += 1) assert.equal(throttle.checkIp(reqFrom('203.0.113.1'), 'start').ok, true);
  const blocked = throttle.checkIp(reqFrom('203.0.113.1'), 'start');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterSec, 180);
  t += 179_000;
  assert.equal(throttle.checkIp(reqFrom('203.0.113.1'), 'start').ok, false);
  t += 2_000;
  assert.equal(throttle.checkIp(reqFrom('203.0.113.1'), 'start').ok, true);
});

test('doors do not share buckets: exhausting /start leaves /verify and /password open', () => {
  const throttle = createAuroraAuthThrottle({ now: () => 5_000 });
  for (let i = 0; i < 20; i += 1) throttle.checkIp(reqFrom('203.0.113.2'), 'start');
  assert.equal(throttle.checkIp(reqFrom('203.0.113.2'), 'start').ok, false);
  assert.equal(throttle.checkIp(reqFrom('203.0.113.2'), 'verify').ok, true);
  assert.equal(throttle.checkIp(reqFrom('203.0.113.2'), 'password').ok, true);
});

test('the email key is case- and whitespace-insensitive, and not the raw address', () => {
  const throttle = createAuroraAuthThrottle({ now: () => 5_000 });
  const spellings = ['user@example.com', 'User@Example.com', '  USER@example.COM ', 'uSeR@eXaMpLe.CoM', 'user@example.com\t'];
  for (const spelling of spellings) assert.equal(throttle.checkEmail(spelling, 'start').ok, true);
  // Mutant killed: keying on the unnormalised string (a caller would dodge the bucket with case changes).
  assert.equal(throttle.checkEmail('user@example.com', 'start').ok, false);
  assert.equal(throttle.checkEmail('USER@EXAMPLE.COM', 'start').ok, false);
  assert.ok(!__test__.emailKey('user@example.com').includes('example.com'));
});

test('a limiter that throws fails OPEN (logged): the database cap, not this valve, is the bound', () => {
  const warnings = [];
  const throttle = createAuroraAuthThrottle({
    now: () => {
      throw new Error('clock unavailable');
    },
    logger: { warn: (obj, msg) => warnings.push({ obj, msg }) },
  });
  const verdict = throttle.checkIp(reqFrom('203.0.113.3'), 'verify');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.failedOpen, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /database attempt cap still applies/);
});

test('the kill switch turns the valve off only for the exact value "false"; default is on', async () => {
  for (const value of [undefined, '', 'true', '0', 'off', 'no']) {
    await withEnv({ AURORA_BFF_AUTH_THROTTLE_ENABLED: value }, async () => {
      assert.equal(__test__.isThrottleEnabled(), true, `value=${value}`);
    });
  }
  for (const value of ['false', 'FALSE', ' false ']) {
    await withEnv({ AURORA_BFF_AUTH_THROTTLE_ENABLED: value }, async () => {
      assert.equal(__test__.isThrottleEnabled(), false, `value=${value}`);
      const throttle = createAuroraAuthThrottle({ now: () => 1 });
      for (let i = 0; i < 50; i += 1) assert.equal(throttle.checkIp(reqFrom('203.0.113.4'), 'start').ok, true);
    });
  }
});

test('per-IP capacities can be raised by env for a shared address, within a ceiling', async () => {
  await withEnv({ AURORA_BFF_AUTH_IP_START_PER_HOUR: '50' }, async () => {
    assert.equal(__test__.defaultLimits().ip.start.capacity, 50);
  });
  await withEnv({ AURORA_BFF_AUTH_IP_START_PER_HOUR: '999999' }, async () => {
    assert.equal(__test__.defaultLimits().ip.start.capacity, 1000);
  });
  await withEnv({ AURORA_BFF_AUTH_IP_START_PER_HOUR: 'junk' }, async () => {
    assert.equal(__test__.defaultLimits().ip.start.capacity, 20);
  });
  // The per-email numbers have no env knob: they are the ones a person typing codes never reaches.
  assert.equal(__test__.defaultLimits().email.start.capacity, 5);
  assert.equal(__test__.defaultLimits().email.verify.capacity, 10);
});
