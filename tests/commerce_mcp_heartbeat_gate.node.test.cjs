'use strict';

// The safety properties of the MCP edge-timeout guard's WIRING, asserted directly on the exported
// predicates rather than through the route.
//
// Why not through the route: committing locks the response to 200 forever, so the interesting question is
// "which requests may arm the heartbeat at all". A route-level test cannot answer it. Everything the
// commerce handler does before the JSON-RPC dispatch — adapter construction (~28ms measured, all
// synchronous CPU) and identity derivation — never yields to the timer phase, so the commit timer does not
// fire there even with the delay forced to 1ms and the gate removed. A route test of
// `notifications/initialized` therefore passes whether or not the gate exists; it is a regression lock (it
// lives in tests/commerce_mcp_route_heartbeat.node.test.cjs), not a proof. These are the proof.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';

const {
  isMcpHeartbeatEligibleRequest,
  mcpHeartbeatOptionsFromEnv,
  resolveBlockedCommerceMcpOperation,
} = require('../src/server')._debug;

const HEARTBEAT_ENV_KEYS = [];
for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) {
    HEARTBEAT_ENV_KEYS.push(`${prefix}_HEARTBEAT_${suffix}`);
  }
}

function withEnv(vars, fn) {
  const saved = new Map();
  for (const key of HEARTBEAT_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// --- the gate: only tools/call may arm a heartbeat --------------------------------------------------------

test('tools/call is the ONLY method that may arm the heartbeat', () => {
  assert.equal(isMcpHeartbeatEligibleRequest({ body: { method: 'tools/call' } }), true);

  // notifications/initialized is the one that MUST stay out: the adapter answers it 202 with a null body,
  // and finish() discards out.status, so a commit would rewrite it to 200 + a bare "\n" that no JSON parser
  // accepts. The rest are static in-memory replies with nothing to gain from the guard.
  for (const method of [
    'notifications/initialized',
    'initialize',
    'tools/list',
    'resources/list',
    'some/future_method',
    '',
  ]) {
    assert.equal(
      isMcpHeartbeatEligibleRequest({ body: { method } }),
      false,
      `${method || '(empty)'} must not arm the heartbeat`,
    );
  }
});

test('a malformed or absent body never arms the heartbeat', () => {
  for (const body of [undefined, null, 'tools/call', 42, ['tools/call'], {}, { method: null }]) {
    assert.equal(isMcpHeartbeatEligibleRequest({ body }), false, `body ${JSON.stringify(body)} must not arm`);
  }
  assert.equal(isMcpHeartbeatEligibleRequest(undefined), false);
  assert.equal(isMcpHeartbeatEligibleRequest({}), false);
});

test('an ineligible request is disabled no matter how the env is set', () => {
  withEnv({ COMMERCE_MCP_HEARTBEAT_ENABLED: '1', COMMERCE_MCP_HEARTBEAT_DELAY_MS: '1' }, () => {
    const opts = mcpHeartbeatOptionsFromEnv(['COMMERCE_MCP', 'PUBLIC_READ_MCP'], { eligible: false });
    assert.equal(opts.enabled, false);
  });
});

// --- the deadline budget ----------------------------------------------------------------------------------

test('time already spent before construction is subtracted from the delay', () => {
  withEnv({}, () => {
    const base = mcpHeartbeatOptionsFromEnv(['COMMERCE_MCP', 'PUBLIC_READ_MCP'], {});
    assert.equal(base.delayMs, 6000, 'default delay');

    // The commerce lane can burn seconds on token introspection + remote-JWKS verification BEFORE the
    // heartbeat exists. That is edge budget already gone, so the remaining delay must shrink by it —
    // otherwise the first body byte lands past the ~13s deadline the guard exists to beat.
    const after4s = mcpHeartbeatOptionsFromEnv(['COMMERCE_MCP', 'PUBLIC_READ_MCP'], { elapsedMs: 4000 });
    assert.equal(after4s.delayMs, 2000);

    // Budget fully consumed → commit on the next tick, never a negative timeout.
    for (const elapsedMs of [6000, 9000, 60000]) {
      assert.equal(mcpHeartbeatOptionsFromEnv(['COMMERCE_MCP'], { elapsedMs }).delayMs, 0);
    }
    // Garbage elapsed values must not corrupt the delay.
    for (const elapsedMs of [undefined, null, NaN, -500, 'abc']) {
      assert.equal(mcpHeartbeatOptionsFromEnv(['COMMERCE_MCP'], { elapsedMs }).delayMs, 6000);
    }
  });
});

test('the public lane resolves its options exactly as before the commerce lane shared the helper', () => {
  // Byte-for-byte parity with the original PR #1904 behaviour on the inputs that shipped.
  const cases = [
    [{}, { enabled: true, delayMs: 6000, intervalMs: 5000 }],
    [{ PUBLIC_READ_MCP_HEARTBEAT_ENABLED: '' }, { enabled: true, delayMs: 6000, intervalMs: 5000 }],
    [{ PUBLIC_READ_MCP_HEARTBEAT_ENABLED: '0' }, { enabled: false, delayMs: 6000, intervalMs: 5000 }],
    [{ PUBLIC_READ_MCP_HEARTBEAT_ENABLED: 'off' }, { enabled: false, delayMs: 6000, intervalMs: 5000 }],
    [{ PUBLIC_READ_MCP_HEARTBEAT_ENABLED: 'yes' }, { enabled: true, delayMs: 6000, intervalMs: 5000 }],
    [{ PUBLIC_READ_MCP_HEARTBEAT_DELAY_MS: '250' }, { enabled: true, delayMs: 250, intervalMs: 5000 }],
    [{ PUBLIC_READ_MCP_HEARTBEAT_DELAY_MS: 'abc' }, { enabled: true, delayMs: 6000, intervalMs: 5000 }],
    [{ PUBLIC_READ_MCP_HEARTBEAT_DELAY_MS: '-5' }, { enabled: true, delayMs: 6000, intervalMs: 5000 }],
    [{ PUBLIC_READ_MCP_HEARTBEAT_INTERVAL_MS: '9' }, { enabled: true, delayMs: 6000, intervalMs: 9 }],
  ];
  for (const [env, expected] of cases) {
    withEnv(env, () => {
      assert.deepEqual(
        mcpHeartbeatOptionsFromEnv(['PUBLIC_READ_MCP'], {}),
        expected,
        `env ${JSON.stringify(env)}`,
      );
    });
  }
});

test('commerce knobs win per suffix, and the public kill-switch reaches the commerce lane', () => {
  const chain = ['COMMERCE_MCP', 'PUBLIC_READ_MCP'];
  withEnv({ PUBLIC_READ_MCP_HEARTBEAT_DELAY_MS: '7000', COMMERCE_MCP_HEARTBEAT_DELAY_MS: '2000' }, () => {
    assert.equal(mcpHeartbeatOptionsFromEnv(chain, {}).delayMs, 2000, 'commerce overrides');
    assert.equal(mcpHeartbeatOptionsFromEnv(['PUBLIC_READ_MCP'], {}).delayMs, 7000, 'public unaffected');
  });
  // Documented operational consequence: disabling the public tier's guard in an incident silently disables
  // the commerce lane's too. Escaping it requires setting the commerce switch explicitly.
  withEnv({ PUBLIC_READ_MCP_HEARTBEAT_ENABLED: '0' }, () => {
    assert.equal(mcpHeartbeatOptionsFromEnv(chain, {}).enabled, false);
  });
  withEnv({ PUBLIC_READ_MCP_HEARTBEAT_ENABLED: '0', COMMERCE_MCP_HEARTBEAT_ENABLED: '1' }, () => {
    assert.equal(mcpHeartbeatOptionsFromEnv(chain, {}).enabled, true);
    assert.equal(mcpHeartbeatOptionsFromEnv(['PUBLIC_READ_MCP'], {}).enabled, false);
  });
});

// --- blocked money ops answer before the heartbeat exists -------------------------------------------------

test('blocked checkout ops are decided from the body alone, so they never reach the heartbeat', () => {
  const saved = {
    submit: process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED,
    link: process.env.AGENT_CHECKOUT_HOSTED_LINK_ENABLED,
  };
  delete process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED;
  delete process.env.AGENT_CHECKOUT_HOSTED_LINK_ENABLED;
  try {
    const call = (name) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } });

    const blockedComplete = resolveBlockedCommerceMcpOperation(call('complete_checkout_session'));
    assert.equal(blockedComplete.operation, 'complete_checkout_session');
    assert.equal(blockedComplete.reason, 'strict_submit_payment_disabled');
    assert.match(blockedComplete.message, /submit_payment is disabled/);

    const blockedLink = resolveBlockedCommerceMcpOperation(call('create_payment_link'));
    assert.equal(blockedLink.operation, 'create_payment_link');
    assert.equal(blockedLink.reason, 'hosted_link_disabled');

    // Not blocked: a different tool, a non-tools/call method, and a malformed body.
    assert.equal(resolveBlockedCommerceMcpOperation(call('search_catalog')), null);
    assert.equal(resolveBlockedCommerceMcpOperation({ method: 'tools/list' }), null);
    assert.equal(resolveBlockedCommerceMcpOperation({ method: 'tools/call' }), null);
    assert.equal(resolveBlockedCommerceMcpOperation({}), null);
    assert.equal(resolveBlockedCommerceMcpOperation(null), null);

    // Flags on → the op proceeds to the adapter (and to the heartbeat).
    process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED = '1';
    process.env.AGENT_CHECKOUT_HOSTED_LINK_ENABLED = '1';
    assert.equal(resolveBlockedCommerceMcpOperation(call('complete_checkout_session')), null);
    assert.equal(resolveBlockedCommerceMcpOperation(call('create_payment_link')), null);
  } finally {
    if (saved.submit === undefined) delete process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED;
    else process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED = saved.submit;
    if (saved.link === undefined) delete process.env.AGENT_CHECKOUT_HOSTED_LINK_ENABLED;
    else process.env.AGENT_CHECKOUT_HOSTED_LINK_ENABLED = saved.link;
  }
});
