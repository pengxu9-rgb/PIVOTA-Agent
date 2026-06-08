const {
  containsForbiddenMoneyField,
  resolveCheckoutHandoff,
} = require('../src/services/checkoutHandoffResolver');

function descriptor(overrides = {}) {
  return {
    status: 'eligible',
    kind: 'pivota_agent_checkout_handoff',
    merchant_id: 'merch_1',
    product_key: 'prod::merch_1::shopify::p1',
    sku_key: 'sku_1',
    offer_id: 'offer_1',
    pivota_signature_id: 'sig_1',
    commerce_path: 'pivota_direct_quote_first',
    validation_authority: 'pivota_live_quote',
    source_audit_run_id: 'aud_1',
    source_deliverability_status: 'transactable',
    ...overrides,
  };
}

function pdp(overrides = {}) {
  return {
    status: 'success',
    product: {
      merchant_id: 'merch_1',
      product_id: 'p1',
      title: 'Buyable SKU',
      serving_eligible: true,
      in_stock: true,
      ...overrides.product,
    },
    modules: [
      {
        type: 'offers',
        data: {
          offers: [
            {
              offer_id: 'offer_1',
              merchant_id: 'merch_1',
              product_id: 'p1',
              sku_id: 'sku_1',
              purchase_route: 'internal_checkout',
              commerce_mode: 'merchant_embedded_checkout',
              checkout_handoff: 'embedded',
              inventory: { in_stock: true },
              ...overrides.offer,
            },
          ],
        },
      },
    ],
    ...overrides.root,
  };
}

describe('checkout handoff resolver', () => {
  test('blocks when checkout handoff scope is not allowed', async () => {
    const resolvePdp = jest.fn();
    const result = await resolveCheckoutHandoff(
      {
        payload: { handoff_descriptor: descriptor() },
        access_scope: { allow_checkout_handoff: false },
      },
      { resolvePdp },
    );

    expect(result.status).toBe('blocked');
    expect(result.blockers).toContain('checkout_handoff_not_allowed');
    expect(resolvePdp).not.toHaveBeenCalled();
  });

  test('valid descriptor returns quote-ready template without money fields or money calls', async () => {
    const createOrder = jest.fn();
    const submitPayment = jest.fn();
    const result = await resolveCheckoutHandoff(
      {
        payload: { handoff_descriptor: descriptor() },
        access_scope: { allow_checkout_handoff: true },
      },
      {
        createOrder,
        submitPayment,
        resolvePdp: jest.fn(async () => ({
          body: pdp(),
          serving_eligible_only: true,
        })),
      },
    );

    expect(result.status).toBe('resolved');
    expect(result.checkout_handoff.status).toBe('quote_ready');
    expect(result.checkout_handoff.preview_quote_template).toEqual({
      operation: 'preview_quote',
      payload: {
        quote: {
          merchant_id: 'merch_1',
          items: [{ product_id: 'p1', sku_id: 'sku_1', quantity: 1 }],
        },
      },
    });
    expect(createOrder).not.toHaveBeenCalled();
    expect(submitPayment).not.toHaveBeenCalled();
    expect(containsForbiddenMoneyField(result)).toBeNull();
  });

  test('stale descriptor blocks when current offer is no longer orderable', async () => {
    const result = await resolveCheckoutHandoff(
      {
        payload: { handoff_descriptor: descriptor() },
        access_scope: { allow_checkout_handoff: true },
      },
      {
        resolvePdp: jest.fn(async () => ({
          body: pdp({
            product: { in_stock: false },
            offer: { inventory: { in_stock: false }, availability: { status: 'out_of_stock' } },
          }),
          serving_eligible_only: true,
        })),
      },
    );

    expect(result.status).toBe('blocked');
    expect(result.blockers).toContain('offer_not_orderable');
    expect(result.checkout_handoff.preview_quote_template).toBeUndefined();
  });

  test('unknown stock is not enough for quote-ready handoff', async () => {
    const result = await resolveCheckoutHandoff(
      {
        payload: { handoff_descriptor: descriptor() },
        access_scope: { allow_checkout_handoff: true },
      },
      {
        resolvePdp: jest.fn(async () => ({
          body: pdp({
            product: { in_stock: undefined },
            offer: {
              inventory: {},
              availability: { status: 'unknown' },
            },
          }),
          serving_eligible_only: true,
        })),
      },
    );

    expect(result.status).toBe('blocked');
    expect(result.blockers).toContain('offer_not_orderable');
  });

  test('descriptor carrying money authority is rejected before PDP revalidation', async () => {
    const resolvePdp = jest.fn();
    const result = await resolveCheckoutHandoff(
      {
        payload: {
          handoff_descriptor: descriptor({
            quote: { amount: 2824, confirmationToken: 'confirm_123' },
          }),
        },
        access_scope: { allow_checkout_handoff: true },
      },
      { resolvePdp },
    );

    expect(result.status).toBe('blocked');
    expect(result.blockers).toContain('money_field_in_descriptor');
    expect(resolvePdp).not.toHaveBeenCalled();
  });

  test('external redirect policy never counts as direct Pivota checkout', async () => {
    const result = await resolveCheckoutHandoff(
      {
        payload: { handoff_descriptor: descriptor() },
        access_scope: { allow_checkout_handoff: true },
      },
      {
        resolvePdp: jest.fn(async () => ({
          body: pdp({
            offer: {
              purchase_route: 'affiliate_outbound',
              commerce_mode: 'links_out',
              checkout_handoff: 'redirect',
              inventory: { in_stock: true },
            },
          }),
          serving_eligible_only: true,
        })),
      },
    );

    expect(result.status).toBe('blocked');
    expect(result.blockers).toContain('policy_not_supported');
  });
});
