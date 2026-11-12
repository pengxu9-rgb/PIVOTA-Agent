'use strict';

// THE CURRENCY RULE STARTS NO STORE READ (AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET).
//
// A storefront checkout reads its products through this gateway's own product page (get_pdp_v2, over loopback). When
// that page is asked FOR A MARKET it does two things that reach a seller's store or change a price: it starts a
// background read of the store's live catalog (`shadowPdpLiveRead`), and it may replace the catalog price with the
// store's cached live answer (`livePdpOverlay`). Asked with no market, the read is skipped (`no_market`) and the
// overlay does nothing. So the rule must not put a market on the product read, in any flag state.
//
// WHAT IS REAL HERE: the `/ucp/mcp` door, the escalation, the executor, the unscoped detail hop, and BEHIND the page
// the handler's own `shadowPdpLiveRead` and `livePdpOverlay` (with the live read fully on: UCP_LIVE_PDP_READ=enforce,
// sampled at 1), the real live-catalog reader, its cache and its per-store budget. The reader's store client is a
// recording fake: every endpoint discovery and every catalog lookup a store would receive is in `door.liveReads`.
// WHAT IS NOT: the page BODY is the fixture's (tests/_support/storeCartMarketDoor.cjs), built by the real producers,
// because the handler cannot resolve a product without a database. The seam is called by the fixture with the
// request's own payload and the handler's own market reader (`offersGateBuyerMarket`), as the handler calls it.

const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('./_support/storeCartMarketDoor.cjs');

const { IDS, ucpCreate, ucpGet, escId } = support;
const door = support.bootDoor({ port: 4477, realPdpLiveSeam: true, env: { UCP_LIVE_PDP_READ: 'enforce', UCP_LIVE_PDP_READ_SAMPLE: '1' } });
const ucp = (name, args) => door.call('/ucp/mcp', name, args);
const settle = () => new Promise((resolve) => { setTimeout(resolve, 60); });

test.before(() => door.listen());
test.after(() => door.close());

test('the seam is live in this fixture: a product read that DOES name a market looks the store up', async () => {
  // The agent's own get_product names its market, and that read is meant to reach the store. This proves the
  // recording below can see a store lookup when one is made.
  const before = door.liveReads.length;
  const read = await door.call('/mcp', 'get_product', { product_id: IDS.SIG_USD_SECOND, market: 'US' });
  assert.equal(read.isError, false);
  await settle();
  const seam = door.pdpSeamCalls.at(-1);
  assert.deepEqual([seam.product_id, seam.market, seam.started], [IDS.SIG_USD_SECOND, 'US', true]);
  assert.ok(door.liveReads.length > before, 'a store endpoint discovery was made for the named market');
  assert.match(door.liveReads.at(-1).base, /store-a\.example/);
});

test('a storefront checkout looks no store up through its product read: every market, flag off and on, create and get_checkout', async () => {
  const rows = [IDS.SIG_USD, IDS.SIG_GBP, IDS.SIG_SGD, IDS.SIG_EUR, IDS.SIG_USD_UNGUARDED, IDS.SIG_GBP_UNGUARDED];
  for (const flag of [false, true]) {
    for (const market of ['US', 'SG', 'GB', 'DE', 'ZZ', undefined]) {
      for (const signature of rows) {
        const label = `${flag ? 'on' : 'off'} ${market} ${signature.slice(0, 8)}`;
        const liveBefore = door.liveReads.length;
        const seamBefore = door.pdpSeamCalls.length;
        const created = await door.withFlag(flag, () => ucp('create_checkout', ucpCreate([[signature, 1]], market)));
        // The id this create minted, else the id a create for this market mints (no market named: assumed US, marked).
        const id = created.isError ? escId({ v: 1, i: [[signature, 1]], ...(market === undefined ? { m: 'US', a: 1 } : { m: market }) }) : created.value.id;
        await door.withFlag(flag, () => ucp('get_checkout', ucpGet(id)));
        await settle();
        const seam = door.pdpSeamCalls.slice(seamBefore);
        assert.deepEqual(seam.map((c) => [c.product_id, c.market]), [[signature, null], [signature, null]], `${label}: the page was asked twice (create, get), for no market`);
        assert.deepEqual(door.liveReads.slice(liveBefore), [], `${label}: no store endpoint discovery, no catalog lookup`);
      }
    }
  }
});

test('US, USD row: the page the checkout read is the page flag off read (no live overlay moved its price)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-15T10:00:00.000Z') });
  const run = async (flag) => {
    door.reset();
    const created = await door.withFlag(flag, () => ucp('create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'US')));
    return { raw: created.raw, upstream: created.upstream, store: created.store, gate: created.gate };
  };
  assert.deepEqual(await run(true), await run(false));
});
