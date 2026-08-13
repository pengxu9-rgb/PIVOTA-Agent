// The UCP dialect PROJECTION, exercised — not just its static vocabulary.
//
// WHY THIS FILE EXISTS. ucpToolVocabulary.test.js pins the contract (which names map to which operations).
// It does not run a single call. A review of #1962 removed `{ dialect: 'ucp' }` from ucpDialectSurface's
// callTool and the whole mcp-server suite still passed 213/213 — a mutant that makes EVERY UCP tool call
// throw UNKNOWN_TOOL in production while CI stays green. These tests kill it: they drive real calls through
// the projection and assert which canonical operation the executor actually received.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createCommerceToolSurface, ucpDialectSurface } from '../src/commerceToolSurface.js';

/** Minimal executor that records the canonical operation id it was asked to run. */
function recordingExecutor() {
  const seen = [];
  return {
    seen,
    async execute(op, payload, ctx) {
      seen.push({ op, payload, ctx });
      // Shape-agnostic: these tests assert ROUTING, not response mapping.
      return { session_id: 'q_1', ok: true };
    },
  };
}

const SESSION = { user_ref: 'buyer_1' };
// The UCP wire shape: `meta` is required on every call (see ucpArgumentAdapter.js). These tests assert
// ROUTING, so they send the minimum a real platform would.
const UCP_META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' } };

function surfaces() {
  const executor = recordingExecutor();
  const mcp = createCommerceToolSurface(executor, { cache: false });
  return { executor, mcp, ucp: ucpDialectSurface(mcp) };
}

describe('ucpDialectSurface routes UCP names to the canonical operation', () => {
  test('a UCP tool name reaches the executor as its canonical op (kills the dropped-dialect mutant)', async () => {
    const { executor, ucp } = surfaces();
    // UCP's own get_product shape: flat `id`, not Pivota's `product_id`.
    await ucp.callTool('get_product', { meta: UCP_META, id: 'p_1' }, SESSION).catch(() => {});
    assert.equal(executor.seen.length, 1, 'the call must reach the executor at all');
    assert.equal(executor.seen[0].op, 'get_product');
  });

  test('a Pivota-NATIVE argument shape is refused on the UCP dialect (the names alone are not the contract)', async () => {
    const { executor, ucp } = surfaces();
    // This is what the dialect accepted before step 3: the tool NAME resolved, the ARGUMENTS were native, and
    // the call sailed through to the executor with no product id at all.
    const err = await ucp.callTool('get_product', { product_id: 'p_1' }, SESSION).then(() => null, (e) => e);
    assert.ok(err, 'native args on the UCP dialect must be refused, not silently accepted');
    assert.equal(executor.seen.length, 0, 'a refused wire shape must never reach the executor');
  });

  test('create_checkout routes to create_checkout_session, not to an unknown tool', async () => {
    const { executor, ucp } = surfaces();
    // Argument validation may reject before the executor; what must NOT happen is UNKNOWN_TOOL, which is
    // exactly what a dropped dialect produces.
    const err = await ucp.callTool('create_checkout', {}, SESSION).then(() => null, (e) => e);
    if (err) {
      assert.equal(
        /UnknownTool|UNKNOWN_TOOL/.test(String(err?.code ?? err?.name ?? err)),
        false,
        'create_checkout must be a KNOWN tool on the UCP dialect',
      );
    }
    for (const call of executor.seen) {
      assert.notEqual(call.op, 'create_checkout', 'the raw UCP name must never reach the executor');
    }
  });

  test('the UCP surface REFUSES Pivota-native names (the dialect is not additive)', async () => {
    const { ucp } = surfaces();
    const err = await ucp.callTool('create_checkout_session', {}, SESSION).then(() => null, (e) => e);
    assert.ok(err, 'an MCP-native name must not be callable on the UCP door');
    assert.match(String(err?.name ?? err?.code ?? err), /UnknownTool/);
  });

  test('the MCP surface still refuses UCP names (no cross-contamination)', async () => {
    const { mcp } = surfaces();
    const err = await mcp.callTool('create_checkout', {}, SESSION).then(() => null, (e) => e);
    assert.ok(err);
    assert.match(String(err?.name ?? err?.code ?? err), /UnknownTool/);
  });

  test('tools/list on the projection advertises only the spec names', () => {
    const { ucp, mcp } = surfaces();
    const ucpNames = ucp.tools.map((t) => t.name).sort();
    assert.deepEqual(ucpNames, ['complete_checkout', 'create_checkout', 'get_checkout', 'get_product', 'update_checkout']);
    // and the wrapped surface is untouched
    assert.ok(mcp.tools.some((t) => t.name === 'create_checkout_session'));
    assert.ok(!mcp.tools.some((t) => t.name === 'create_checkout'));
  });

  test('isCommerceTool is dialect-scoped on the projection', () => {
    const { ucp, mcp } = surfaces();
    assert.equal(ucp.isCommerceTool('create_checkout'), true);
    assert.equal(ucp.isCommerceTool('create_checkout_session'), false);
    assert.equal(mcp.isCommerceTool('create_checkout_session'), true);
    assert.equal(mcp.isCommerceTool('create_checkout'), false);
  });

  test('the projection keeps what the remote MCP adapter requires of a surface', () => {
    const { ucp } = surfaces();
    assert.ok(Array.isArray(ucp.tools));
    assert.equal(typeof ucp.callTool, 'function');
  });

  test('wrapping a non-surface fails loudly rather than yielding a dead door', () => {
    assert.throws(() => ucpDialectSurface(null), /requires a commerce surface/);
    assert.throws(() => ucpDialectSurface({}), /requires a commerce surface/);
  });
});
