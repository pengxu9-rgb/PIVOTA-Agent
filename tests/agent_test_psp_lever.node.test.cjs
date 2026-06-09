const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || 'backend_test_key';

const app = require('../src/server');
const { applyStrictHostedOrderMetadata } = app._debug;

const ORIG = process.env.AGENT_CHECKOUT_ALLOW_TEST_PSP;
function withFlag(value, fn) {
  if (value === undefined) delete process.env.AGENT_CHECKOUT_ALLOW_TEST_PSP;
  else process.env.AGENT_CHECKOUT_ALLOW_TEST_PSP = value;
  try { fn(); } finally {
    if (ORIG === undefined) delete process.env.AGENT_CHECKOUT_ALLOW_TEST_PSP;
    else process.env.AGENT_CHECKOUT_ALLOW_TEST_PSP = ORIG;
  }
}

test('default (flag unset): hosted order does NOT carry allow_test_psp_surfaces', () => {
  withFlag(undefined, () => {
    const out = applyStrictHostedOrderMetadata({ quote_id: 'q1', metadata: {} });
    assert.equal(out.metadata.allow_test_psp_surfaces, undefined, 'must NOT be set by default');
    assert.equal(out.metadata.agent_v2.hosted_checkout, true, 'hosted marker still set');
  });
});

test('flag off explicitly ("0"): not set', () => {
  withFlag('0', () => {
    const out = applyStrictHostedOrderMetadata({ quote_id: 'q1', metadata: {} });
    assert.equal(out.metadata.allow_test_psp_surfaces, undefined);
  });
});

test('flag on ("1"): order carries allow_test_psp_surfaces at the TOP LEVEL of metadata', () => {
  withFlag('1', () => {
    const out = applyStrictHostedOrderMetadata({ quote_id: 'q1', metadata: {} });
    assert.equal(out.metadata.allow_test_psp_surfaces, true, 'set at top level where the backend reads it');
    // It must NOT be nested under agent_v2 (the backend reads order.metadata top level).
    assert.equal(out.metadata.agent_v2.allow_test_psp_surfaces, undefined);
    assert.equal(out.metadata.agent_v2.hosted_checkout, true);
  });
});

test('flag on accepts true/on/yes', () => {
  for (const v of ['true', 'on', 'yes', 'TRUE']) {
    withFlag(v, () => {
      const out = applyStrictHostedOrderMetadata({ quote_id: 'q1', metadata: {} });
      assert.equal(out.metadata.allow_test_psp_surfaces, true, `value ${v} should enable`);
    });
  }
});

test('preserves caller-supplied metadata', () => {
  withFlag('1', () => {
    const out = applyStrictHostedOrderMetadata({ quote_id: 'q1', metadata: { source: 'mcp', agent_v2: { quote_id: 'q1' } } });
    assert.equal(out.metadata.source, 'mcp');
    assert.equal(out.metadata.agent_v2.quote_id, 'q1');
    assert.equal(out.metadata.allow_test_psp_surfaces, true);
  });
});
