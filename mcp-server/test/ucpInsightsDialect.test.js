// cc.pivota.insights on the UCP door — the VENDOR capability's three tools, driven through the projection.
//
// The decision layer (get_alternatives / get_offers / get_intel) was callable on native /mcp and withheld from
// UCP because a vendor capability needs hosted documents and evidenced tool names. This file pins the wire
// contract those documents describe: `{ meta, insights: { id, … } }`, the id nested under `insights`, every
// advertised leaf read into the native args, refusals that name `insights.id`, and the same executor op as
// the native twin. The profile half (published only when both docs live on pivota.cc) is pinned in
// safety-kernel/test/protocol.test.js and, for the env wiring, below.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createCommerceToolSurface, ucpDialectSurface } from '../src/commerceToolSurface.js';
import { ucpToNativeToolArgs, UCP_INPUT_SCHEMAS } from '../src/ucpArgumentAdapter.js';
import { canonicalOp, canonicalOpForUcpTool } from '../../safety-kernel/src/protocol/canonicalContract.js';
import { buildUcpProfile } from '../../safety-kernel/src/protocol/ucpProfile.js';

const META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' } };

function recordingExecutor() {
  const seen = [];
  return {
    seen,
    async execute(op, payload, ctx) {
      seen.push({ op, payload, ctx });
      return { subject: { product_id: 'sig_x' }, signals: [], metadata: {} };
    },
  };
}

function surfaces() {
  const executor = recordingExecutor();
  const mcp = createCommerceToolSurface(executor, { cache: false });
  return { executor, mcp, ucp: ucpDialectSurface(mcp) };
}

describe('cc.pivota.insights tools speak the nested `insights` envelope', () => {
  test('get_intel: id under `insights` → native product_id, same executor op as the native twin', async () => {
    const { executor, ucp } = surfaces();
    await ucp.callTool('get_intel', { meta: META, insights: { id: 'sig_x' } }, {});
    assert.equal(executor.seen.length, 1);
    assert.equal(executor.seen[0].op, 'get_intel');
    assert.equal(executor.seen[0].payload?.payload?.product_id, 'sig_x');
    assert.equal(canonicalOpForUcpTool('get_intel'), canonicalOp('get_intel'));
  });

  test('get_alternatives reads every advertised leaf, clamps limit, keeps dupes off unless asked', () => {
    const op = canonicalOp('get_alternatives');
    const native = ucpToNativeToolArgs(op, {
      meta: META,
      insights: { id: ' sig_a ', relation: 'dupe', include_dupes: true, market: 'US', max_price_ratio: 1.0, limit: 99 },
    });
    assert.deepEqual(native, {
      product_id: 'sig_a', relation: 'dupe', include_dupes: true, market: 'US', max_price_ratio: 1.0, limit: 20,
    });
    // Omitted optionals are ABSENT in the native args, never null/false/"" — the native reader treats absence
    // as its defaults (dupes off, no relation filter).
    assert.deepEqual(ucpToNativeToolArgs(op, { meta: META, insights: { id: 'sig_a' } }), { product_id: 'sig_a' });
  });

  test('get_offers reads currency + limit (clamped to the native max of 10)', () => {
    const op = canonicalOp('get_offers');
    assert.deepEqual(
      ucpToNativeToolArgs(op, { meta: META, insights: { id: 'sig_o', currency: 'EUR', limit: 50 } }),
      { product_id: 'sig_o', currency: 'EUR', limit: 10 },
    );
  });

  test('a flat native shape is refused BY NAME, pointing at insights.id', async () => {
    const { executor, ucp } = surfaces();
    for (const tool of ['get_intel', 'get_alternatives', 'get_offers']) {
      const err = await ucp.callTool(tool, { meta: META, product_id: 'sig_x' }, {}).then(() => null, (e) => e);
      assert.ok(err, `${tool}: native args must be refused`);
      assert.equal(executor.seen.length, 0, `${tool}: a refused shape must not reach the executor`);
      const text = String(err?.detail?.acp_message ?? err?.message ?? err);
      assert.match(text, /insights\.id/, `${tool}: the refusal must name the vendor envelope`);
    }
  });

  test('missing meta and missing insights.id are refused; unknown members under insights are refused', () => {
    const op = canonicalOp('get_intel');
    const msg = (fn) => { try { fn(); } catch (e) { return String(e?.detail?.acp_message ?? e?.message ?? e); } return 'NO THROW'; };
    assert.match(msg(() => ucpToNativeToolArgs(op, { insights: { id: 'sig_x' } })), /meta/);
    assert.match(msg(() => ucpToNativeToolArgs(op, { meta: META, insights: {} })), /insights\.id/);
    assert.match(msg(() => ucpToNativeToolArgs(op, { meta: META, insights: { id: 'sig_x', merchant_id: 'm' } })), /merchant_id/);
  });

  test('non-string / wrong-typed optionals are dropped, not forwarded (the native schema would refuse them)', () => {
    const op = canonicalOp('get_alternatives');
    const native = ucpToNativeToolArgs(op, {
      meta: META,
      insights: { id: 'sig_a', include_dupes: 'yes', max_price_ratio: 'cheap', limit: 2.5, market: '' },
    });
    assert.deepEqual(native, { product_id: 'sig_a' });
  });

  test('the published schemas nest the id under `insights` and are strict', () => {
    for (const id of ['get_alternatives', 'get_offers', 'get_intel']) {
      const schema = UCP_INPUT_SCHEMAS[id];
      assert.deepEqual(schema.required, ['meta', 'insights']);
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.properties.insights.required, ['id']);
      assert.equal(schema.properties.insights.additionalProperties, false);
      assert.equal(schema.properties.product_id, undefined, `${id}: no flat product_id on the UCP door`);
    }
  });

  test('native /mcp is untouched: the wrapped surface still answers the native shape', async () => {
    const { executor, mcp } = surfaces();
    await mcp.callTool('get_intel', { product_id: 'sig_n' }, {});
    assert.equal(executor.seen[0].op, 'get_intel');
    assert.equal(executor.seen[0].payload?.payload?.product_id, 'sig_n');
  });
});

describe('cc.pivota.insights is advertised only with both documents on pivota.cc', () => {
  const base = { baseUrl: 'https://commerce.mcp.pivota.cc', mcpEndpoint: 'https://commerce.mcp.pivota.cc/ucp/mcp' };
  const capIds = (profile) => Object.keys(profile?.ucp?.capabilities ?? {});

  test('withheld with no docs, even though the tools are now mapped', () => {
    assert.ok(!capIds(buildUcpProfile(base)).includes('cc.pivota.insights'));
  });

  test('published with spec + schema on pivota.cc; withheld with one, or with a foreign host', () => {
    const docs = { spec: 'https://pivota.cc/ucp/insights', schema: 'https://pivota.cc/ucp/schemas/insights.json' };
    const on = buildUcpProfile({ ...base, vendorCapabilityDocs: { 'cc.pivota.insights': docs } });
    assert.ok(capIds(on).includes('cc.pivota.insights'));
    assert.equal(on.ucp.capabilities['cc.pivota.insights'][0].spec, docs.spec);
    assert.equal(on.ucp.capabilities['cc.pivota.insights'][0].schema, docs.schema);

    const half = buildUcpProfile({ ...base, vendorCapabilityDocs: { 'cc.pivota.insights': { spec: docs.spec } } });
    assert.ok(!capIds(half).includes('cc.pivota.insights'));
    const foreign = buildUcpProfile({
      ...base,
      vendorCapabilityDocs: { 'cc.pivota.insights': { spec: 'https://ucp.dev/x', schema: docs.schema } },
    });
    assert.ok(!capIds(foreign).includes('cc.pivota.insights'));
  });
});
