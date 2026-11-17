'use strict';

// recommend_products' reviewed ingredient exclusion (gw#2582) is dark unless
// AGENT_RECOMMEND_INGREDIENT_EXCLUSION_ENABLED. Its matcher does not yet know an ingredient's salts, esters or
// fragrance components, so with the dial off the tool must declare and answer `avoid` exactly as 4885ec01d did
// (a hint to the model, no evidence lookup), and with it on exactly as 6c55a6aad did (the exclusion ungated).
// Both sides are recordings from those commits: tests/fixtures/recommend_ingredient_exclusion_answers.json,
// made by tests/_support/recommendIngredientExclusionHarness.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');

const FIXTURE = require('./fixtures/recommend_ingredient_exclusion_answers.json');
const { SCENARIOS, runScenario } = require('./_support/recommendIngredientExclusionHarness.cjs');
const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');
const { RECOMMEND_INGREDIENT_EXCLUSION_FLAG, recommendIngredientExclusionEnabled } = require('../src/agentSignals/recommendIngredientExclusionFlag');

const FLAG = 'AGENT_RECOMMEND_INGREDIENT_EXCLUSION_ENABLED';

function setFlag(t, value) {
  const before = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  t.after(() => {
    if (before === undefined) delete process.env[FLAG];
    else process.env[FLAG] = before;
  });
}

async function surfaces() {
  const m = await import('../mcp-server/src/commerceToolSurface.js');
  const { createPublicReadToolSurface } = await import('../mcp-server/src/publicReadToolSurface.js');
  const executor = { execute: async () => ({}) };
  const native = m.createCommerceToolSurface(executor, {});
  return { m, native, ucp: m.ucpDialectSurface(native), publicRead: createPublicReadToolSurface(executor, {}) };
}

const recommendTool = (tools) => {
  const found = tools.filter((tool) => tool.name === 'recommend_products');
  assert.equal(found.length, 1, 'one recommend_products declaration');
  return found[0];
};

test('the dial is on for 1 and true only', (t) => {
  assert.equal(RECOMMEND_INGREDIENT_EXCLUSION_FLAG, FLAG);
  for (const value of [undefined, '', '0', 'false', 'off', 'no', 'yes', 'on', 'enabled', '2', 'truthy']) {
    assert.equal(recommendIngredientExclusionEnabled(value === undefined ? {} : { [FLAG]: value }), false, String(value));
  }
  for (const value of ['1', 'true', 'TRUE', ' true ', ' 1 ']) {
    assert.equal(recommendIngredientExclusionEnabled({ [FLAG]: value }), true, value);
  }
  setFlag(t, '1');
  assert.equal(recommendIngredientExclusionEnabled(), true, 'reads process.env by default');
  delete process.env[FLAG];
  assert.equal(recommendIngredientExclusionEnabled(), false, 'per call');
});

test('OFF: tools/list declares recommend_products byte-for-byte as 4885ec01d did', async (t) => {
  setFlag(t, undefined);
  const { m, native } = await surfaces();
  const before = JSON.stringify(FIXTURE.tool.before_exclusions);
  assert.equal(JSON.stringify(recommendTool(native.tools)), before);
  // The static export is the flag-off declaration too.
  assert.equal(JSON.stringify(recommendTool(m.commerceToolDefinitions)), before);
  const description = recommendTool(native.tools).description;
  assert.ok(!description.includes('was absent'), 'no agent is told an ingredient was absent');
  assert.ok(!description.includes('ingredient_exclusion_verification'));
  assert.ok(!JSON.stringify(native.tools).includes(m.RECOMMEND_INGREDIENT_EXCLUSION_CONSTRAINTS_DESCRIPTION));
  for (const value of ['0', 'false', 'yes', 'on']) {
    process.env[FLAG] = value;
    assert.equal(JSON.stringify(recommendTool(native.tools)), before, value);
  }
});

test('ON: tools/list declares recommend_products byte-for-byte as 6c55a6aad did; nothing else moves', async (t) => {
  setFlag(t, undefined);
  const { native, ucp, publicRead } = await surfaces();
  const off = { native: JSON.stringify(native.tools), ucp: JSON.stringify(ucp.tools), publicRead: JSON.stringify(publicRead.tools) };
  // Read per tools/list: the same surface instance follows the dial.
  process.env[FLAG] = '1';
  assert.equal(JSON.stringify(recommendTool(native.tools)), JSON.stringify(FIXTURE.tool.exclusions_ungated));
  process.env[FLAG] = 'true';
  assert.equal(JSON.stringify(recommendTool(native.tools)), JSON.stringify(FIXTURE.tool.exclusions_ungated));
  const others = (list) => JSON.stringify(JSON.parse(list).filter((tool) => tool.name !== 'recommend_products'));
  assert.equal(others(JSON.stringify(native.tools)), others(off.native), 'every other native tool is unchanged');
  assert.equal(JSON.stringify(ucp.tools), off.ucp, 'UCP list unchanged');
  assert.equal(JSON.stringify(publicRead.tools), off.publicRead, 'public read list unchanged');
  assert.ok(!JSON.parse(off.ucp).some((tool) => tool.name === 'recommend_products'));
  delete process.env[FLAG];
  assert.equal(JSON.stringify(native.tools), off.native, 'back off on the next list');
});

test('OFF: every avoid request answers byte-for-byte as 4885ec01d did, with no evidence lookup', async (t) => {
  setFlag(t, undefined);
  for (const [name, constraints] of SCENARIOS) {
    const record = await runScenario(makeRecommendProducts, constraints);
    assert.deepEqual(record.loaderCalls, [], `${name}: no evidence lookup`);
    assert.equal(JSON.stringify(record), JSON.stringify(FIXTURE.answers.before_exclusions[name]), name);
    const text = JSON.stringify(record.out);
    assert.ok(!text.includes('ingredient_exclusion'), `${name}: no ingredient_exclusion field or metadata`);
    assert.ok(!text.includes('no_verified_ingredient_matches'), name);
    // `avoid` still reaches the model's ask as a hint.
    assert.ok('avoid' in record.askArgs[0].constraints || constraints.avoid === '', name);
  }
  // Any other value is off, and a lookup that would throw is never reached.
  for (const value of ['0', 'false', 'yes', 'on']) {
    process.env[FLAG] = value;
    const record = await runScenario(makeRecommendProducts, SCENARIOS[0][1], { loaderThrows: true });
    assert.deepEqual(record.loaderCalls, [], value);
    assert.equal(JSON.stringify(record), JSON.stringify(FIXTURE.answers.before_exclusions[SCENARIOS[0][0]]), value);
  }
});

test('ON: every avoid request answers byte-for-byte as 6c55a6aad did', async (t) => {
  for (const value of ['1', 'true']) {
    setFlag(t, value);
    for (const [name, constraints] of SCENARIOS) {
      const record = await runScenario(makeRecommendProducts, constraints);
      assert.equal(JSON.stringify(record), JSON.stringify(FIXTURE.answers.exclusions_ungated[name]), `${value} ${name}`);
    }
  }
  // The recording itself shows the exclusion working: evidence looked up, metadata stamped, rows withheld.
  const on = FIXTURE.answers.exclusions_ungated;
  assert.equal(on.avoid_list.loaderCalls.length, 1);
  assert.deepEqual(on.avoid_list.out.metadata.ingredient_exclusion_verification, { market: 'US', present_withheld: 1, unknown_withheld: 0, verified: 3 });
  assert.equal(on.avoid_with_unsupported.out.metadata.products_empty_reason, 'no_verified_ingredient_matches');
  assert.ok(on.avoid_list.out.signals.every((s) => s.value.ingredient_exclusion.status === 'absent_from_reviewed_ingredient_list'));
});
