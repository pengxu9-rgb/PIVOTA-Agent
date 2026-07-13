'use strict';

const {
  resolveCheckoutHandoff,
  containsForbiddenMoneyField,
  WARM_HANDOFF_DISPOSITION,
} = require('../src/services/checkoutHandoffResolver');

const FLAG_ON = { UCP_WARM_HANDOFF_ENABLED: '1' };
const FLAG_OFF = { UCP_WARM_HANDOFF_ENABLED: '' };

// A crawled redirect descriptor that fails direct-policy validation (-> policy_not_supported) but carries the
// brand domain + Shopify variant needed for a warm handoff.
function redirectDescriptor(overrides = {}) {
  return {
    status: 'eligible',
    kind: 'pivota_agent_checkout_handoff',
    source_deliverability_status: 'transactable',
    commerce_path: 'affiliate_outbound', // NOT pivota_direct_quote_first
    merchant_id: 'merch_obs_cosrx',
    product_key: 'prod::merch_obs_cosrx::shopify::p1',
    brand_domain: 'cosrx.com',
    variant_id: '51895645012184',
    ...overrides,
  };
}

// A warm-handoff service fake that mimics a UCP-reachable Shopify brand (returns a continue_url) or a
// non-reachable one (returns null -> caller cold-redirects).
function warmHandoffFake({ reachable = true, capture } = {}) {
  return {
    resolveWarmHandoff: jest.fn(async ({ brandDomain, variantGid, quantity }) => {
      if (capture) capture.push({ brandDomain, variantGid, quantity });
      if (!reachable) return null;
      return {
        disposition: WARM_HANDOFF_DISPOSITION,
        continue_url: `https://cosrx-renewal.myshopify.com/cart/c/abc123?key=TAIL`,
        cart_id: 'gid://shopify/Cart/abc123',
        line_item: { variant_gid: variantGid, quantity, title: 'COSRX Snail 96' },
        mcp_endpoint: `https://${brandDomain}/api/ucp/mcp`,
      };
    }),
  };
}

// PDP that live-revalidates to a REDIRECT offer (the crawled-brand case) — reaches the post-PDP
// policy_not_supported branch.
function redirectPdp() {
  return {
    status: 'success',
    product: {
      merchant_id: 'merch_obs_cosrx',
      product_id: 'p1',
      title: 'Advanced Snail 96',
      serving_eligible: true,
      in_stock: true,
      canonical_url: 'https://cosrx.com/products/advanced-snail-96',
    },
    modules: [{
      type: 'offers',
      data: {
        offers: [{
          offer_id: 'offer_1',
          merchant_id: 'merch_obs_cosrx',
          product_id: 'p1',
          sku_id: 'sku_1',
          variant_id: '51895645012184',
          purchase_route: 'affiliate_outbound',
          commerce_mode: 'links_out',
          checkout_handoff: 'redirect',
          inventory: { in_stock: true },
        }],
      },
    }],
  };
}

describe('warm handoff — flag OFF is a byte-identical no-op', () => {
  test('early redirect descriptor still blocks policy_not_supported; service never consulted', async () => {
    const capture = [];
    const warmHandoff = warmHandoffFake({ capture });

    const withDepFlagOff = await resolveCheckoutHandoff(
      { payload: { handoff_descriptor: redirectDescriptor() }, access_scope: { allow_checkout_handoff: true } },
      { env: FLAG_OFF, warmHandoff, resolvePdp: jest.fn() },
    );
    const baseline = await resolveCheckoutHandoff(
      { payload: { handoff_descriptor: redirectDescriptor() }, access_scope: { allow_checkout_handoff: true } },
      { env: FLAG_OFF, resolvePdp: jest.fn() },
    );

    expect(withDepFlagOff.status).toBe('blocked');
    expect(withDepFlagOff.blockers).toContain('policy_not_supported');
    // byte-identical to a run with no warm-handoff dep at all (normalize only the per-call random context_id,
    // which is generated independent of this lane).
    const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); if (c.updated_context) c.updated_context.context_id = 'X'; return c; };
    expect(strip(withDepFlagOff)).toEqual(strip(baseline));
    expect(warmHandoff.resolveWarmHandoff).not.toHaveBeenCalled();
  });

  test('post-PDP redirect offer still blocks policy_not_supported when flag OFF', async () => {
    const warmHandoff = warmHandoffFake();
    const result = await resolveCheckoutHandoff(
      { payload: { handoff_descriptor: { ...redirectDescriptor(), commerce_path: 'pivota_direct_quote_first' } }, access_scope: { allow_checkout_handoff: true } },
      { env: FLAG_OFF, warmHandoff, resolvePdp: jest.fn(async () => ({ body: redirectPdp(), serving_eligible_only: true })) },
    );
    expect(result.status).toBe('blocked');
    expect(result.blockers).toContain('policy_not_supported');
    expect(warmHandoff.resolveWarmHandoff).not.toHaveBeenCalled();
  });
});

describe('warm handoff — flag ON', () => {
  test('early redirect descriptor upgrades to a warm_handoff for a UCP-reachable Shopify brand', async () => {
    const capture = [];
    const warmHandoff = warmHandoffFake({ reachable: true, capture });
    const result = await resolveCheckoutHandoff(
      { payload: { handoff_descriptor: redirectDescriptor() }, access_scope: { allow_checkout_handoff: true } },
      { env: FLAG_ON, warmHandoff, resolvePdp: jest.fn() },
    );

    expect(result.status).toBe('resolved');
    expect(result.checkout_handoff.disposition).toBe(WARM_HANDOFF_DISPOSITION);
    expect(result.checkout_handoff.status).toBe('warm_handoff_ready');
    expect(result.checkout_handoff.continue_url).toBe('https://cosrx-renewal.myshopify.com/cart/c/abc123?key=TAIL');
    expect(result.checkout_handoff.order_created).toBe(false);
    expect(result.checkout_handoff.payment_submitted).toBe(false);
    // resolved with the derived brand domain + wrapped variant GID
    expect(capture[0].brandDomain).toBe('cosrx.com');
    expect(capture[0].variantGid).toBe('gid://shopify/ProductVariant/51895645012184');
    // no money authority leaks into the warm handoff
    expect(containsForbiddenMoneyField(result)).toBeNull();
  });

  test('post-PDP redirect offer upgrades to warm_handoff using the revalidated brand + variant', async () => {
    const capture = [];
    const warmHandoff = warmHandoffFake({ reachable: true, capture });
    const result = await resolveCheckoutHandoff(
      { payload: { handoff_descriptor: { ...redirectDescriptor(), commerce_path: 'pivota_direct_quote_first', brand_domain: undefined, variant_id: undefined } }, access_scope: { allow_checkout_handoff: true } },
      { env: FLAG_ON, warmHandoff, resolvePdp: jest.fn(async () => ({ body: redirectPdp(), serving_eligible_only: true })) },
    );
    expect(result.status).toBe('resolved');
    expect(result.checkout_handoff.disposition).toBe(WARM_HANDOFF_DISPOSITION);
    // brand domain from product.canonical_url; variant from the offer's numeric variant_id
    expect(capture[0].brandDomain).toBe('cosrx.com');
    expect(capture[0].variantGid).toBe('gid://shopify/ProductVariant/51895645012184');
  });

  test('non-reachable (non-Shopify) brand falls back to the cold-redirect block', async () => {
    const warmHandoff = warmHandoffFake({ reachable: false });
    const result = await resolveCheckoutHandoff(
      { payload: { handoff_descriptor: redirectDescriptor({ brand_domain: 'not-shopify.example' }) }, access_scope: { allow_checkout_handoff: true } },
      { env: FLAG_ON, warmHandoff, resolvePdp: jest.fn() },
    );
    expect(result.status).toBe('blocked');
    expect(result.blockers).toContain('policy_not_supported');
    expect(warmHandoff.resolveWarmHandoff).toHaveBeenCalledTimes(1);
  });

  test('flag ON but no resolvable variant -> no warm handoff, cold-redirect block, service not called', async () => {
    const warmHandoff = warmHandoffFake();
    const result = await resolveCheckoutHandoff(
      { payload: { handoff_descriptor: redirectDescriptor({ variant_id: undefined }) }, access_scope: { allow_checkout_handoff: true } },
      { env: FLAG_ON, warmHandoff, resolvePdp: jest.fn() },
    );
    expect(result.status).toBe('blocked');
    expect(result.blockers).toContain('policy_not_supported');
    expect(warmHandoff.resolveWarmHandoff).not.toHaveBeenCalled();
  });
});
