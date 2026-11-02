/**
 * UCP discount extension (dev.ucp.shopping.discount, ucp.dev/2026-04-08/specification/discount) on the
 * OUTBOUND buyer-agent client: the profile requests it exactly as the spec declares it, codes are submitted as
 * `discounts.codes` on cart/checkout create and update, and the response's `discounts.applied` and
 * `discount_code_*` messages are read back without guessing (ADR-027 D3, ADR-028 D8).
 *
 * NO live network: every fetch is a synthetic response injected via `fetchImpl`. The response shapes below
 * are transcribed from the spec page and its schema (shopping/discount.json, fetched 2026-11-03).
 */

const {
  buildUcpBuyerAgentProfile,
  ALLOWED_BUYER_CAPABILITIES,
  DISCOUNT_CAPABILITY,
} = require('../src/services/ucpBuyerAgentProfile');
const {
  createUcpBuyerAgentClient,
  buildCheckoutArgs,
  normalizeDiscountCodes,
  normalizeDiscounts,
  normalizePricedCheckout,
  discountCodeOutcome,
  MAX_DISCOUNT_CODES,
} = require('../src/services/ucpBuyerAgentClient');

const ENDPOINT = 'https://shop.example.myshopify.com/api/ucp/mcp';

// A checkout response in the spec's shape: one code discount on the line, one automatic shipping discount,
// a rejected second code, and the totals entries the spec names (negative amounts there, positive in applied).
const CHECKOUT = {
  id: 'gid://shopify/Checkout/abc',
  status: 'incomplete',
  currency: 'USD',
  line_items: [{ item: { id: '4401', title: 'Serum' }, quantity: 1 }],
  discounts: {
    codes: ['glow10', 'OLDCODE'],
    applied: [
      {
        code: 'GLOW10',
        title: '10% off',
        amount: 400,
        automatic: false,
        method: 'each',
        allocations: [{ path: '$.line_items[0]', amount: 400 }],
      },
      {
        title: 'Free shipping over $35',
        amount: 599,
        automatic: true,
        allocations: [{ path: '$.totals.shipping', amount: 599 }],
      },
    ],
  },
  messages: [
    { type: 'warning', code: 'discount_code_expired', path: '$.discounts.codes[1]', content: 'Code OLDCODE has expired' },
    { type: 'info', code: 'shipping_estimated', content: 'Shipping is estimated' },
  ],
  totals: [
    { type: 'subtotal', amount: 4000 },
    { type: 'items_discount', amount: -400 },
    { type: 'total', amount: 3600 },
  ],
};

function makeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const text = JSON.stringify({ jsonrpc: '2.0', id: '1', result: { content: [{ type: 'json', json: response }] } });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const sentArguments = (fetchImpl) => fetchImpl.calls[fetchImpl.calls.length - 1].body.params.arguments;

// ---- the profile -----------------------------------------------------------------------------------------

describe('the buyer profile requests the discount extension', () => {
  test('declared exactly as the spec declares it, extending both cart and checkout', () => {
    const p = buildUcpBuyerAgentProfile();
    expect(DISCOUNT_CAPABILITY).toBe('dev.ucp.shopping.discount');
    // spec, schema and extends transcribed from the spec's own discovery example (2026-04-08).
    expect(p.ucp.capabilities['dev.ucp.shopping.discount']).toEqual([{
      version: '2026-04-08',
      spec: 'https://ucp.dev/2026-04-08/specification/discount',
      schema: 'https://ucp.dev/2026-04-08/schemas/shopping/discount.json',
      extends: ['dev.ucp.shopping.cart', 'dev.ucp.shopping.checkout'],
    }]);
    // Both parents are requested, so our own profile can never prune it as an orphan.
    for (const parent of p.ucp.capabilities['dev.ucp.shopping.discount'][0].extends) {
      expect(Object.keys(p.ucp.capabilities)).toContain(parent);
    }
    expect(p.agent.requested_scopes).toContain('dev.ucp.shopping.discount');
    expect(ALLOWED_BUYER_CAPABILITIES.has('dev.ucp.shopping.discount')).toBe(true);
  });

  test('requesting it moves no money', () => {
    const p = buildUcpBuyerAgentProfile();
    expect(p.agent.completes_payment).toBe(false);
    expect(p.ucp.payment_handlers).toEqual({});
  });
});

// ---- submitting codes --------------------------------------------------------------------------------------

describe('codes are submitted as discounts.codes', () => {
  test('on a checkout, beside the other fields, and never with a payment field', () => {
    const args = buildCheckoutArgs({
      cartId: 'cart_1',
      checkout: { payment: { instruments: ['tok'] } },
      discountCodes: [' GLOW10 '],
    });
    expect(args.checkout.discounts).toEqual({ codes: ['GLOW10'] });
    expect(args.checkout.cart_id).toBe('cart_1');
    expect(args.checkout).not.toHaveProperty('payment');
  });

  test('omitted codes leave the request exactly as before; [] clears', () => {
    expect(buildCheckoutArgs({ cartId: 'cart_1' })).toEqual({ checkout: { cart_id: 'cart_1' } });
    expect(buildCheckoutArgs({ cartId: 'cart_1', discountCodes: [] }).checkout.discounts).toEqual({ codes: [] });
  });

  test('codes are trimmed and de-duplicated case-insensitively, as the spec matches them', () => {
    expect(normalizeDiscountCodes(['glow10', 'GLOW10 ', 'Other'])).toEqual(['glow10', 'Other']);
  });

  test.each([
    ['not an array', 'GLOW10'],
    ['a non-string', [10]],
    ['an empty code', ['  ']],
    ['an over-long code', ['X'.repeat(256)]],
    ['too many codes', Array.from({ length: MAX_DISCOUNT_CODES + 1 }, (_, i) => `C${i}`)],
  ])('refuses %s before reaching the merchant', (_label, codes) => {
    expect(() => normalizeDiscountCodes(codes)).toThrow();
  });

  test('createCheckout, updateCheckout and createCart send them', async () => {
    const fetchImpl = makeFetch(CHECKOUT);
    const client = createUcpBuyerAgentClient({ fetchImpl });
    await client.createCheckout(ENDPOINT, { lineItems: [{ item: { id: '4401' }, quantity: 1 }], discountCodes: ['GLOW10'] });
    expect(sentArguments(fetchImpl).checkout.discounts).toEqual({ codes: ['GLOW10'] });
    await client.updateCheckout(ENDPOINT, { checkoutId: 'gid://shopify/Checkout/abc', discountCodes: [] });
    expect(sentArguments(fetchImpl).checkout.discounts).toEqual({ codes: [] });
    expect(sentArguments(fetchImpl).id).toBe('gid://shopify/Checkout/abc');
    await client.createCart(ENDPOINT, { lineItems: [{ item: { id: '4401' }, quantity: 1 }], discountCodes: ['GLOW10'] });
    expect(sentArguments(fetchImpl).cart.discounts).toEqual({ codes: ['GLOW10'] });
  });

  test('a cart without codes is sent exactly as before', async () => {
    const fetchImpl = makeFetch(CHECKOUT);
    const client = createUcpBuyerAgentClient({ fetchImpl });
    await client.createCart(ENDPOINT, { lineItems: [{ item: { id: '4401' }, quantity: 1 }] });
    expect(sentArguments(fetchImpl).cart).not.toHaveProperty('discounts');
  });
});

// ---- reading what applied ------------------------------------------------------------------------------------

describe('the response is read without guessing', () => {
  test('applied discounts, their allocations and the rejected code', () => {
    const d = normalizePricedCheckout(CHECKOUT).discounts;
    expect(d.submitted_codes).toEqual(['glow10', 'OLDCODE']);
    expect(d.applied).toEqual([
      {
        code: 'GLOW10', title: '10% off', automatic: false, amount_minor: 400, method: 'each',
        allocations: [{ path: '$.line_items[0]', target: 'line', amount_minor: 400 }],
      },
      {
        code: null, title: 'Free shipping over $35', automatic: true, amount_minor: 599, method: null,
        allocations: [{ path: '$.totals.shipping', target: 'shipping', amount_minor: 599 }],
      },
    ]);
    // Mapped back to the code we sent through the message path; non-discount messages are ignored.
    expect(d.rejected).toEqual([{ code: 'OLDCODE', reason: 'discount_code_expired', content: 'Code OLDCODE has expired' }]);
    expect(d.unreadable).toEqual([]);
  });

  test('an allocation that is neither a line nor shipping is the order', () => {
    const d = normalizeDiscounts({ discounts: { applied: [
      { code: 'ORDER5', title: '$5 off', amount: 500, allocations: [{ path: '$.totals.subtotal', amount: 500 }] },
    ] } });
    expect(d.applied[0].allocations[0].target).toBe('order');
  });

  test.each([
    ['a fractional amount', { amount: 4.5 }],
    ['a string amount', { amount: '400' }],
    ['a zero amount', { amount: 0 }],
    ['a negative amount', { amount: -400 }],
    ['an unsafe amount', { amount: Number.MAX_SAFE_INTEGER + 1 }],
    ['an unreadable allocation', { amount: 400, allocations: [{ path: '$.line_items[0]', amount: 'x' }] }],
  ])('%s is unreadable, never applied', (_label, overrides) => {
    const d = normalizeDiscounts({ discounts: { applied: [{ code: 'GLOW10', title: 't', ...overrides }] } });
    expect(d.applied).toEqual([]);
    expect(d.unreadable).toHaveLength(1);
  });

  test('a rejection whose path names no code we sent is kept, with no code', () => {
    const d = normalizeDiscounts({
      discounts: { codes: ['A'] },
      messages: [
        { type: 'warning', code: 'discount_code_user_ineligible', path: '$.discounts.codes[3]', content: 'x' },
        { type: 'warning', code: 'discount_code_combination_disallowed', content: 'y' },
      ],
    });
    expect(d.rejected.map((r) => [r.code, r.reason])).toEqual([
      [null, 'discount_code_user_ineligible'],
      [null, 'discount_code_combination_disallowed'],
    ]);
  });

  test('no discounts block reads as empty, and an empty checkout carries the same shape', () => {
    const empty = { submitted_codes: [], applied: [], rejected: [], unreadable: [] };
    expect(normalizeDiscounts({})).toEqual(empty);
    expect(normalizePricedCheckout(null).discounts).toEqual(empty);
  });
});

// ---- one code's outcome -------------------------------------------------------------------------------------

describe('what one code did', () => {
  test('applied, matched case-insensitively, with automatic discounts reported apart', () => {
    const outcome = discountCodeOutcome(normalizeDiscounts(CHECKOUT), 'glow10');
    expect(outcome).toMatchObject({ applied: true, amount_minor: 400, rejected_reason: null, unreadable: false });
    expect(outcome.allocations).toEqual([{ path: '$.line_items[0]', target: 'line', amount_minor: 400 }]);
    expect(outcome.automatic).toEqual([{
      title: 'Free shipping over $35', amount_minor: 599,
      allocations: [{ path: '$.totals.shipping', target: 'shipping', amount_minor: 599 }],
    }]);
  });

  test('rejected, absent or unreadable is never applied', () => {
    const d = normalizeDiscounts(CHECKOUT);
    expect(discountCodeOutcome(d, 'OLDCODE')).toMatchObject({ applied: false, rejected_reason: 'discount_code_expired' });
    expect(discountCodeOutcome(d, 'NOPE')).toMatchObject({ applied: false, amount_minor: 0 });
    const unreadable = normalizeDiscounts({ discounts: { applied: [{ code: 'GLOW10', title: 't', amount: '400' }] } });
    expect(discountCodeOutcome(unreadable, 'GLOW10')).toMatchObject({ applied: false, unreadable: true });
  });

  test('a code both applied and rejected is not applied', () => {
    const both = normalizeDiscounts({
      discounts: { codes: ['GLOW10'], applied: [{ code: 'GLOW10', title: 't', amount: 400, allocations: [] }] },
      messages: [{ type: 'warning', code: 'discount_code_already_applied', path: '$.discounts.codes[0]' }],
    });
    expect(discountCodeOutcome(both, 'GLOW10').applied).toBe(false);
  });
});
