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

  test('omitted (or null) codes leave the request exactly as before; [] clears', () => {
    expect(buildCheckoutArgs({ cartId: 'cart_1' })).toEqual({ checkout: { cart_id: 'cart_1' } });
    expect(buildCheckoutArgs({ cartId: 'cart_1', discountCodes: null })).toEqual({ checkout: { cart_id: 'cart_1' } });
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
    await client.createCart(ENDPOINT, { lineItems: [{ item: { id: '4401' }, quantity: 1 }], discountCodes: null });
    expect(sentArguments(fetchImpl).cart).not.toHaveProperty('discounts');
  });
});

// ---- reading what applied ------------------------------------------------------------------------------------

const line = (amount, path = '$.line_items[0]') => ({ path, amount });
const codeEntry = (overrides = {}) => ({ code: 'GLOW10', title: '10% off', amount: 400, allocations: [line(400)], ...overrides });
const read = (applied, extra = {}) => normalizeDiscounts({ currency: 'USD', discounts: { codes: ['GLOW10'], applied }, ...extra });

describe('the response is read without guessing', () => {
  test('applied discounts, their allocations and the rejected code', () => {
    const d = normalizePricedCheckout(CHECKOUT).discounts;
    expect(d.currency).toBe('USD');
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
    expect(d.unmapped_rejections).toEqual([]);
    expect(d.unreadable).toEqual([]);
  });

  test.each([
    ['$.line_items[2]', 'line'],
    ['$.totals.shipping', 'shipping'],
    ['$.totals.fulfillment', 'shipping'],
    ['$.totals.fee', 'fee'],
  ])('a recognized path %s targets %s', (path, target) => {
    const d = read([codeEntry({ allocations: [{ path, amount: 400 }] })]);
    expect(d.applied[0].allocations[0].target).toBe(target);
  });

  test.each([
    ['$.foo'], ['line_items[0]'], ['$.line_items[0].price'], ['$.totals.subtotal'], ['$.totals.shipping.amount'],
  ])('an unknown path %s is unreadable, never guessed as the order', (path) => {
    expect(read([codeEntry({ allocations: [{ path, amount: 400 }] })]).unreadable).toHaveLength(1);
  });

  test('an entry with no allocations is the spec\'s order-level form: read as unallocated', () => {
    for (const allocations of [[], undefined]) {
      const d = read([codeEntry({ amount: 1000, allocations })]);
      expect(d.unreadable).toEqual([]);
      expect(d.applied[0].allocations).toEqual([{ path: null, target: 'unallocated', amount_minor: 1000 }]);
    }
  });

  test.each([
    ['a fractional amount', { amount: 4.5, allocations: [line(4.5)] }],
    ['a string amount', { amount: '400' }],
    ['a zero amount', { amount: 0, allocations: [line(0)] }],
    ['a negative amount', { amount: -400, allocations: [line(-400)] }],
    ['an unsafe amount', { amount: Number.MAX_SAFE_INTEGER + 1, allocations: [line(Number.MAX_SAFE_INTEGER + 1)] }],
    ['an unreadable allocation amount', { allocations: [{ path: '$.line_items[0]', amount: 'x' }] }],
    ['a negative allocation', { allocations: [line(800), line(-400)] }],
    ['an allocation larger than its entry', { allocations: [line(500)] }],
    ['allocations summing to less than the entry', { allocations: [line(300)] }],
    ['an allocation with no path', { allocations: [{ amount: 400 }] }],
    ['an allocation with an empty path', { allocations: [{ path: ' ', amount: 400 }] }],
    ['an allocations value that is not a list', { allocations: { path: '$.line_items[0]', amount: 400 } }],
    // M12: a complete set plus one bad allocation is not accepted by skipping the bad one.
    ['a bad allocation beside a complete set', { allocations: [line(400), { amount: 3 }] }],
    ['automatic yet carrying a code', { automatic: true }],
  ])('%s is unreadable, never applied', (_label, overrides) => {
    const d = read([codeEntry(overrides)]);
    expect(d.applied).toEqual([]);
    expect(d.unreadable).toHaveLength(1);
    expect(d.unreadable[0].code).toBe('GLOW10');
  });

  test('a code entry that names no code and is not automatic is unreadable', () => {
    expect(read([codeEntry({ code: undefined })]).unreadable).toHaveLength(1);
  });

  test.each([
    ['no echo of the submitted codes', { discounts: { applied: [] } }, '$.discounts.codes[0]'],
    ['no path', { discounts: { codes: ['A'] } }, undefined],
    ['an index past the end', { discounts: { codes: ['A'] } }, '$.discounts.codes[3]'],
  ])('a discount rejection with %s is unmapped, not dropped', (_label, payload, path) => {
    const d = normalizeDiscounts({
      currency: 'USD', ...payload,
      messages: [{ type: 'warning', code: 'discount_code_user_ineligible', path, content: 'x' }],
    });
    expect(d.rejected).toEqual([]);
    expect(d.unmapped_rejections.map((r) => r.reason)).toEqual(['discount_code_user_ineligible']);
  });

  test('a rejection maps against the merchant\'s echo as sent, not a filtered copy', () => {
    const messages = (i) => [{ type: 'warning', code: 'discount_code_invalid', path: `$.discounts.codes[${i}]` }];
    const echo = { codes: [5, 'SAVE10', 'B'] };
    const atOne = normalizeDiscounts({ currency: 'USD', discounts: echo, messages: messages(1) });
    expect(atOne.rejected.map((r) => r.code)).toEqual(['SAVE10']);
    // A non-string slot names no code we sent: unmapped, so no code reads as applied.
    const atZero = normalizeDiscounts({ currency: 'USD', discounts: echo, messages: messages(0) });
    expect(atZero.rejected).toEqual([]);
    expect(atZero.unmapped_rejections).toHaveLength(1);
  });

  test.each([
    [[{ type: 'subtotal', amount: 4000 }], 4000],
    [[{ type: 'subtotal', amount: 4000 }, { type: 'subtotal', amount: 1 }], null],
    [[{ type: 'subtotal', amount: -1 }], null],
    [[{ type: 'subtotal', amount: '4000' }], null],
    [undefined, null],
  ])('the subtotal bound reads only one clean subtotal (%#)', (totals, expected) => {
    expect(normalizeDiscounts({ currency: 'USD', totals, discounts: {} }).subtotal_minor).toBe(expected);
  });

  test.each([
    ['absent', undefined],
    ['numeric', 840],
    ['lower-case', 'usd'],
    ['not three letters', 'US'],
  ])('a %s checkout currency reads as null', (_label, currency) => {
    expect(normalizeDiscounts({ currency, discounts: {} }).currency).toBeNull();
  });

  test('no discounts block reads as empty, and an empty checkout carries the same shape', () => {
    const empty = {
      currency: null, subtotal_minor: null, submitted_codes: [], applied: [], rejected: [], unmapped_rejections: [], unreadable: [],
    };
    expect(normalizeDiscounts({})).toEqual(empty);
    expect(normalizePricedCheckout(null).discounts).toEqual(empty);
  });
});

// ---- one code's outcome -------------------------------------------------------------------------------------

describe('what one code did', () => {
  test('applied, matched case-insensitively, with automatic discounts reported apart', () => {
    const outcome = discountCodeOutcome(normalizeDiscounts(CHECKOUT), 'glow10');
    expect(outcome).toMatchObject({
      applied: true, not_applied_reason: null, currency: 'USD', amount_minor: 400, shipping_minor: 0,
      rejected_reason: null, unreadable: false,
    });
    expect(outcome.allocations).toEqual([{ path: '$.line_items[0]', target: 'line', amount_minor: 400 }]);
    expect(outcome.automatic).toEqual([{
      title: 'Free shipping over $35', amount_minor: 599,
      allocations: [{ path: '$.totals.shipping', target: 'shipping', amount_minor: 599 }],
    }]);
  });

  test('only line allocations are the code\'s saving; shipping and fees are reported apart', () => {
    const mixed = read([codeEntry({
      amount: 800, allocations: [line(400), { path: '$.totals.shipping', amount: 300 }, { path: '$.totals.fee', amount: 100 }],
    })]);
    expect(discountCodeOutcome(mixed, 'GLOW10')).toMatchObject({
      applied: true, amount_minor: 400, shipping_minor: 300, fee_minor: 100, unallocated_minor: 0,
    });
    const shippingOnly = read([codeEntry({ amount: 599, allocations: [{ path: '$.totals.shipping', amount: 599 }] })]);
    expect(discountCodeOutcome(shippingOnly, 'GLOW10')).toMatchObject({
      applied: false, not_applied_reason: 'no_item_saving', amount_minor: 0, shipping_minor: 0,
    });
  });

  test('an order-level code with no allocations is reported, never counted as the item\'s saving', () => {
    const d = read([codeEntry({ amount: 1000, allocations: undefined })]);
    expect(discountCodeOutcome(d, 'GLOW10')).toMatchObject({
      applied: false, not_applied_reason: 'unallocated', amount_minor: 0, unallocated_minor: 1000,
    });
  });

  test('a saving larger than the checkout subtotal is not applied', () => {
    const d = read([codeEntry()], { totals: [{ type: 'subtotal', amount: 300 }] });
    expect(discountCodeOutcome(d, 'GLOW10')).toMatchObject({
      applied: false, not_applied_reason: 'exceeds_subtotal', amount_minor: 0,
    });
    const equal = read([codeEntry()], { totals: [{ type: 'subtotal', amount: 400 }] });
    expect(discountCodeOutcome(equal, 'GLOW10')).toMatchObject({ applied: true, amount_minor: 400 });
  });

  test.each([
    ['rejected', CHECKOUT, 'OLDCODE', 'rejected'],
    ['absent', CHECKOUT, 'NOPE', 'not_applied'],
  ])('%s is never applied', (_label, payload, code, reason) => {
    expect(discountCodeOutcome(normalizeDiscounts(payload), code)).toMatchObject({
      applied: false, not_applied_reason: reason, amount_minor: 0,
    });
  });

  test('without a readable checkout currency nothing is applied', () => {
    for (const currency of [undefined, 840, 'usd']) {
      const d = normalizeDiscounts({ ...CHECKOUT, currency });
      expect(discountCodeOutcome(d, 'GLOW10')).toMatchObject({ applied: false, not_applied_reason: 'currency_unreadable', amount_minor: 0 });
    }
  });

  test('an unmapped discount rejection leaves every submitted code not applied', () => {
    const d = read([codeEntry()], { messages: [{ type: 'warning', code: 'discount_code_invalid', content: 'x' }] });
    expect(discountCodeOutcome(d, 'GLOW10')).toMatchObject({ applied: false, not_applied_reason: 'unmapped_rejection', amount_minor: 0 });
  });

  test('two applied entries for one code are ambiguous, never summed', () => {
    const d = read([codeEntry({ amount: 500, allocations: [line(500)] }), codeEntry({ amount: 500, allocations: [line(500)] })]);
    expect(discountCodeOutcome(d, 'GLOW10')).toMatchObject({ applied: false, not_applied_reason: 'ambiguous', amount_minor: 0 });
  });

  test('a readable entry beside an unreadable one for the same code is not applied', () => {
    const d = read([codeEntry(), codeEntry({ amount: '400' })]);
    expect(d.applied).toHaveLength(1);
    expect(discountCodeOutcome(d, 'GLOW10')).toMatchObject({
      applied: false, not_applied_reason: 'unreadable', unreadable: true, amount_minor: 0, allocations: [],
    });
  });

  test('a code both applied and rejected is not applied', () => {
    const both = read([codeEntry()], {
      messages: [{ type: 'warning', code: 'discount_code_already_applied', path: '$.discounts.codes[0]' }],
    });
    expect(discountCodeOutcome(both, 'GLOW10')).toMatchObject({ applied: false, not_applied_reason: 'rejected', amount_minor: 0 });
  });

  test('an automatic discount never counts as the code', () => {
    const d = read([{ title: 'Autumn', automatic: true, amount: 400, allocations: [line(400)] }]);
    expect(discountCodeOutcome(d, 'GLOW10')).toMatchObject({ applied: false, not_applied_reason: 'not_applied' });
  });
});
