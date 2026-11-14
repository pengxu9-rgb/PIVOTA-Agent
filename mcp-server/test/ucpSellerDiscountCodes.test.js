// The buyer's discount code on a STOREFRONT checkout: it rides on the cart the seller's own UCP door prices.
//
// What is pinned here, and why each matters:
//   - the switch is three switches (escalation, seller pricing, codes); any one off and nothing is sent, the door
//     refuses `checkout.discounts` as before, and the answer's bytes do not move;
//   - the code reaches ONLY a seller whose profile advertises the discount capability, and only on create;
//   - the seller's totals stay the price; the code's outcome is reported beside it, never used to change it;
//   - "applied" needs one readable entry naming the code, no rejection that could concern it, AND a discount in the
//     seller's own totals; a seller refusal comes back as its `discount_code_*` code; everything else is
//     `discount_code_not_confirmed` / `discount_code_not_evaluated` — never silence;
//   - the seller's discount text and the code itself never reach a log, and seller text never reaches the agent.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MERCHANT_PRICING_FLAG,
  SELLER_DISCOUNT_CODES_FLAG,
  priceOnMerchantDoor,
  readSellerCart,
  readSellerDiscounts,
  createMerchantDoor,
  isAcceptableDiscountCode,
} from '../src/ucpMerchantDoorPricing.js';
import {
  UCP_ESCALATION_FLAG,
  storefrontDiscountCodesEnabled,
  tryEscalateUcpCheckout,
} from '../src/ucpCheckoutEscalation.js';
import {
  createCommerceToolSurface,
  ucpDialectSurface,
  ucpCommerceToolDefinitionsFor,
  DISCOUNT_CODE_NOT_APPLIED_ANY_LANE_MESSAGE,
  DISCOUNT_CODE_NOT_APPLIED_MESSAGE,
  toToolError,
} from '../src/commerceToolSurface.js';

const PRICING = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1' };
const ON = { ...PRICING, [SELLER_DISCOUNT_CODES_FLAG]: '1' };
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const GID = (n) => `gid://shopify/ProductVariant/${n}`;
const ENDPOINT = 'https://brand.example/api/ucp/mcp';
const CART_URL = 'https://brand.example/cart/c/abc123?key=k';
const CODE = 'Welcome10';
const SELLER_TEXT = 'SELLER-FREE-TEXT-NEVER-FORWARDED';

const SEED = Object.freeze({
  product_id: 'sig_seed_a', title: 'Vitamin C Serum', price: 131, currency: 'USD',
  external_redirect_url: 'https://brand.example/products/vitamin-c-serum',
  variants: [{ variant_id: 'sig_seed_a', source_variant_id: '44012345678901' }],
});
const SEED_B = Object.freeze({
  ...SEED, product_id: 'sig_seed_b', title: 'Toner', price: 24.5,
  external_redirect_url: 'https://brand.example/products/toner',
  variants: [{ variant_id: 'sig_seed_b', source_variant_id: '44012345678902' }],
});

function executorWith(rowsById) {
  return {
    async execute(op, params) {
      if (op === 'get_product') {
        const row = rowsById[params.payload.product.product_id];
        return row ? { product: structuredClone(row) } : { product: null };
      }
      return { session_id: 'q_kernel' };
    },
  };
}

/**
 * A seller cart as UCP's create_cart answers it, with the discount extension's members. `lines` are
 * [gid, qty, unitMinor]; `discount` (positive minor) adds a negative `discount` total; `discounts` is the raw block.
 */
function sellerCart({ lines = [[GID('44012345678901'), 2, 12900]], discount = 0, discounts, messages, discountType = 'discount' } = {}) {
  const sub = lines.reduce((a, [, q, p]) => a + q * p, 0);
  const totals = [{ type: 'subtotal', amount: sub }];
  if (discount) totals.push({ type: discountType, amount: -discount, display_text: SELLER_TEXT });
  totals.push({ type: 'total', amount: sub - discount });
  const payload = {
    id: 'gid://shopify/Cart/c1',
    currency: 'USD',
    continue_url: CART_URL,
    line_items: lines.map(([gid, quantity, price], i) => ({
      id: `line_${i}`, item: { id: gid, title: `Seller title ${i}`, price }, quantity,
      totals: [{ type: 'subtotal', amount: quantity * price }, { type: 'total', amount: quantity * price }],
    })),
    totals,
    ...(discounts ? { discounts } : {}),
    ...(messages ? { messages } : {}),
  };
  return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}

const appliedCode = (amount, path = '$.line_items[0]', code = CODE) => ({
  codes: [code],
  applied: [{ code, title: SELLER_TEXT, amount, allocations: [{ path, amount }] }],
});

function fakeDoor({ advertises = true, create = () => sellerCart(), get = () => sellerCart() } = {}) {
  const calls = [];
  return {
    calls,
    async endpointFor(host) {
      calls.push(['discover', host]);
      return advertises === 'string' ? ENDPOINT : { mcpEndpoint: ENDPOINT, acceptsDiscountCodes: advertises };
    },
    async createCart(ep, args) { calls.push(['create_cart', ep, structuredClone(args)]); return create(args); },
    async getCart(ep, cartId) { calls.push(['get_cart', ep, cartId]); return get(cartId); },
  };
}
function fakeLog() {
  const lines = [];
  const rec = (level) => (o) => lines.push({ level, ...o });
  return { lines, info: rec('info'), warn: rec('warn') };
}
const CREATE = { id: 'create_checkout_session', capability: 'checkout' };
const GET = { id: 'get_checkout_session', capability: 'checkout' };
const createParams = (...pairs) => ({ idempotency_key: 'idem-0001', quote: { items: pairs.map(([product_id, quantity]) => ({ product_id, quantity })) } });
// `code: null` = the request carries no code (a default parameter would swallow `undefined`).
const argsWith = (code, country = 'US') => ({
  checkout: { context: { address_country: country }, ...(code === null ? {} : { discounts: { codes: [code] } }) },
});

async function create({ env = ON, door = fakeDoor(), code = CODE, rows = { [SEED.product_id]: SEED }, items = [[SEED.product_id, 2]], log } = {}) {
  const out = await tryEscalateUcpCheckout({
    op: CREATE, params: createParams(...items), ctx: {}, executor: executorWith(rows),
    ucpArgs: argsWith(code), env, now: NOW, merchantDoor: door, log,
  });
  return { out, door };
}
const sentArgs = (door) => door.calls.filter((c) => c[0] === 'create_cart').map((c) => c[2]);
const codeMessages = (out) => (out.messages || []).filter((m) => typeof m.path === 'string' && m.path.startsWith('$.discounts'));

describe('the switch is three switches', () => {
  test('codes need the escalation, the seller pricing AND the code switch', () => {
    assert.equal(storefrontDiscountCodesEnabled(ON), true);
    assert.equal(storefrontDiscountCodesEnabled({ ...ON, [SELLER_DISCOUNT_CODES_FLAG]: '0' }), false);
    assert.equal(storefrontDiscountCodesEnabled({ ...ON, [MERCHANT_PRICING_FLAG]: undefined }), false);
    assert.equal(storefrontDiscountCodesEnabled({ ...ON, [UCP_ESCALATION_FLAG]: undefined }), false);
    assert.equal(storefrontDiscountCodesEnabled({}), false);
  });

  test('code switch OFF: nothing is sent and the answer is byte-identical to a request with no code', async () => {
    const withCode = await create({ env: PRICING });
    const without = await create({ env: PRICING, code: null });
    assert.equal(JSON.stringify(withCode.out), JSON.stringify(without.out));
    assert.equal(sentArgs(withCode.door)[0].discountCodes, undefined);
    assert.equal(withCode.out.discounts, undefined);
  });

  test('code switch OFF and the seller never priced: the catalog answer says nothing about a code, bytes as before', async () => {
    const down = () => fakeDoor({ create: () => ({ ok: false, status: 503, error: { message: 'down' } }) });
    const withCode = await create({ env: PRICING, door: down() });
    const without = await create({ env: PRICING, door: down(), code: null });
    assert.equal(withCode.out.messages[0].code, 'checkout.completes_on_seller_storefront');
    assert.equal(JSON.stringify(withCode.out), JSON.stringify(without.out));
  });

  test('code switch ON but no code asked for: no `discounts` member, bytes as before', async () => {
    const on = await create({ code: null });
    const off = await create({ env: PRICING, code: null });
    assert.equal(JSON.stringify(on.out), JSON.stringify(off.out));
  });
});

describe('the code reaches the seller', () => {
  test('sent as UCP spells it, beside the line items, to a seller that advertises codes', async () => {
    const { door } = await create();
    assert.deepEqual(sentArgs(door)[0].discountCodes, [CODE]);
  });

  test('NOT sent to a seller whose profile does not advertise codes; said so, the cart is still seller-priced', async () => {
    for (const advertises of [false, 'string']) {
      const { out, door } = await create({ door: fakeDoor({ advertises }) });
      assert.equal(sentArgs(door)[0].discountCodes, undefined, String(advertises));
      assert.equal(out.messages[0].code, 'checkout.priced_by_seller_storefront');
      assert.deepEqual(out.discounts, { codes: [CODE], applied: [] });
      const [m] = codeMessages(out);
      assert.equal(m.code, 'discount_code_not_evaluated');
      assert.equal(m.type, 'warning');
      assert.equal(m.path, '$.discounts.codes[0]');
      assert.match(m.content, /does not advertise discount codes/);
    }
  });

  test('a code no storefront could take (blank, control or invisible/bidi characters) is REFUSED before any seller is contacted', async () => {
    for (const bad of ['   ', 'SAVE\u202e01', 'SA\u0007VE', '\u200bSAVE', 'X'.repeat(129), 'SAVE\u{e0041}', '\u{1f600}'.repeat(65)]) {
      const door = fakeDoor();
      const err = await create({ code: bad, door }).then(() => null, (e) => e);
      assert.ok(err, JSON.stringify(bad));
      assert.equal(err.detail && err.detail.reason, 'ucp_discount_code_invalid', JSON.stringify(bad));
      assert.equal(door.calls.length, 0, JSON.stringify(bad));
    }
    const ok = await create({ code: 'X'.repeat(128) });
    assert.deepEqual(sentArgs(ok.door)[0].discountCodes, ['X'.repeat(128)]);
  });

  test('a re-read never sends a code; it reports the codes the seller cart already holds', async () => {
    const door = fakeDoor({ get: () => sellerCart({ discount: 2580, discounts: appliedCode(2580) }) });
    const { out } = await create({ door, code: null });
    const again = await tryEscalateUcpCheckout({
      op: GET, params: { session_id: out.id }, ctx: {}, executor: executorWith({ [SEED.product_id]: SEED }),
      ucpArgs: {}, env: ON, now: NOW, merchantDoor: door,
    });
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 1);
    assert.equal(door.calls.filter((c) => c[0] === 'get_cart').length, 1);
    assert.deepEqual(again.discounts, { codes: [CODE], applied: [{ code: CODE, amount: 2580, allocations: [{ path: '$.line_items[0]', amount: 2580 }] }] });
    assert.equal(codeMessages(again).length, 0);
  });
});

describe('what the seller said about it', () => {
  test('APPLIED: one readable entry, the seller totals carry the discount; the total is the seller\'s own', async () => {
    const door = fakeDoor({ create: () => sellerCart({ discount: 2580, discounts: appliedCode(2580) }) });
    const { out } = await create({ door });
    assert.deepEqual(out.discounts, { codes: [CODE], applied: [{ code: CODE, amount: 2580, allocations: [{ path: '$.line_items[0]', amount: 2580 }] }] });
    assert.deepEqual(out.totals.map((t) => [t.type, t.amount]), [['subtotal', 25800], ['discount', -2580], ['total', 23220]]);
    assert.equal(codeMessages(out).length, 0, 'an applied code needs no warning');
  });

  test('an items_discount total counts as the seller\'s discount too', async () => {
    const door = fakeDoor({ create: () => sellerCart({ discount: 1000, discountType: 'items_discount', discounts: appliedCode(1000) }) });
    const { out } = await create({ door });
    assert.equal(out.discounts.applied.length, 1);
  });

  test('allocations are re-pointed at THIS checkout\'s lines, not the seller\'s order', async () => {
    // The seller answers the two lines in the opposite order; its line 0 is our line 1.
    const lines = [[GID('44012345678902'), 1, 2450], [GID('44012345678901'), 1, 13100]];
    const door = fakeDoor({ create: () => sellerCart({ lines, discount: 245, discounts: appliedCode(245, '$.line_items[0]') }) });
    const { out } = await create({ door, rows: { [SEED.product_id]: SEED, [SEED_B.product_id]: SEED_B }, items: [[SEED.product_id, 1], [SEED_B.product_id, 1]] });
    assert.deepEqual(out.discounts.applied[0].allocations, [{ path: '$.line_items[1]', amount: 245 }]);
    assert.equal(out.line_items[1].item.id, SEED_B.product_id);
  });

  test('REJECTED by the seller (its warning): the seller\'s own code, our fixed text, the cart still priced', async () => {
    const door = fakeDoor({
      create: () => sellerCart({
        discounts: { codes: [CODE], applied: [] },
        messages: [{ type: 'warning', code: 'discount_code_expired', path: '$.discounts.codes[0]', content: SELLER_TEXT }],
      }),
    });
    const { out } = await create({ door });
    assert.equal(out.messages[0].code, 'checkout.priced_by_seller_storefront');
    assert.deepEqual(out.discounts, { codes: [CODE], applied: [] });
    const msgs = codeMessages(out);
    assert.equal(msgs.length, 1);
    assert.deepEqual([msgs[0].type, msgs[0].code, msgs[0].path], ['warning', 'discount_code_expired', '$.discounts.codes[0]']);
    assert.equal(out.messages.some((m) => m.code === 'seller.storefront_message'), false, 'reported once, as the code\'s outcome');
    assert.equal(out.totals.at(-1).amount, 25800);
  });

  test('REJECTED the way Shopify says it (no path, one code on the cart): the store\'s own code, the cart still priced', async () => {
    const door = fakeDoor({
      create: () => sellerCart({ discounts: { codes: [CODE], applied: [] }, messages: [{ type: 'warning', code: 'discount_code_invalid', content: SELLER_TEXT }] }),
    });
    const { out } = await create({ door });
    assert.equal(out.messages[0].code, 'checkout.priced_by_seller_storefront');
    const msgs = codeMessages(out);
    assert.deepEqual(msgs.map((m) => [m.type, m.code, m.path]), [['warning', 'discount_code_invalid', '$.discounts.codes[0]']]);
    assert.equal(JSON.stringify(out).includes(SELLER_TEXT), false);
  });

  test('a seller that sends the rejection as an ERROR still prices the cart while codes are on — and falls back with them off', async () => {
    const reply = () => sellerCart({ discounts: { codes: [CODE], applied: [] }, messages: [{ type: 'error', code: 'discount_code_invalid', path: '$.discounts.codes[0]' }] });
    const on = await create({ door: fakeDoor({ create: reply }) });
    assert.equal(on.out.messages[0].code, 'checkout.priced_by_seller_storefront');
    assert.equal(codeMessages(on.out)[0].code, 'discount_code_invalid');
    const off = await create({ env: PRICING, door: fakeDoor({ create: reply }) });
    assert.equal(off.out.messages[0].code, 'checkout.completes_on_seller_storefront', 'flag off: an error is a cart error, as before');
  });

  test('NOT CONFIRMED, each way it can be: silent seller, ambiguous, unreadable, unmapped rejection, no discount in totals', async () => {
    const cases = {
      seller_did_not_apply: sellerCart({ discounts: { codes: [CODE], applied: [] } }),
      ambiguous: sellerCart({ discount: 200, discounts: { codes: [CODE], applied: [{ code: CODE, amount: 100 }, { code: CODE.toUpperCase(), amount: 100 }] } }),
      unreadable: sellerCart({ discount: 100, discounts: { codes: [CODE], applied: [{ code: CODE, amount: -100 }] } }),
      unmapped_rejection: sellerCart({ discount: 100, discounts: appliedCode(100), messages: [{ type: 'warning', code: 'discount_code_invalid', path: '$.discounts.codes[3]' }] }),
      totals_show_no_discount: sellerCart({ discounts: appliedCode(100) }),
      amounts_disagree: sellerCart({ discount: 150, discounts: appliedCode(100) }),
      // An unreadable entry for ANOTHER code means the seller's discount rows cannot be reconciled either.
      amounts_disagree_other_unreadable: sellerCart({ discount: 100, discounts: { codes: [CODE], applied: [{ code: CODE, amount: 100 }, { code: 'OTHER', amount: 'x' }] } }),
    };
    for (const [reason, reply] of Object.entries(cases)) {
      const log = fakeLog();
      const { out } = await create({ door: fakeDoor({ create: () => reply }), log });
      const msgs = codeMessages(out);
      assert.equal(msgs.length, 1, reason);
      assert.equal(msgs[0].code, 'discount_code_not_confirmed', reason);
      assert.equal(out.discounts.applied.filter((a) => a.code).length, 0, reason);
      const expected = reason.startsWith('amounts_disagree') ? 'amounts_disagree' : reason;
      if (expected === 'amounts_disagree') assert.deepEqual(out.discounts.applied, [], 'no amount shown that the totals do not carry');
      const line = log.lines.find((l) => l.outcome === 'discount_codes');
      assert.deepEqual(line.statuses, [`not_confirmed:${expected}`], reason);
    }
  });

  test('an automatic discount is listed (it explains the total) but never as the code', async () => {
    const door = fakeDoor({
      create: () => sellerCart({ discount: 500, discounts: { codes: [CODE], applied: [{ automatic: true, title: SELLER_TEXT, amount: 500 }] } }),
    });
    const { out } = await create({ door });
    assert.deepEqual(out.discounts.applied, [{ automatic: true, amount: 500 }]);
    assert.equal(codeMessages(out)[0].code, 'discount_code_not_confirmed');
  });

  test('an automatic discount whose amount the totals do not carry is not shown', async () => {
    const door = fakeDoor({ create: () => sellerCart({ discount: 400, discounts: { codes: [CODE], applied: [{ automatic: true, amount: 500 }] } }) });
    const { out } = await create({ door });
    assert.deepEqual(out.discounts.applied, []);
  });

  test('a seller rejection code outside UCP\'s `discount_code_*` shape is reported as discount_code_invalid, never repeated', async () => {
    const door = fakeDoor({
      create: () => sellerCart({ discounts: { codes: [CODE], applied: [] }, messages: [{ type: 'warning', code: 'discount_code_Expired-Now!', path: '$.discounts.codes[0]' }] }),
    });
    const { out } = await create({ door });
    assert.equal(codeMessages(out)[0].code, 'discount_code_invalid');
    assert.equal(JSON.stringify(out).includes('Expired-Now'), false);
  });

  test('code switch OFF: a seller discount_code_* message stays an ordinary storefront message, as before', async () => {
    const door = fakeDoor({ create: () => sellerCart({ messages: [{ type: 'warning', code: 'discount_code_expired', path: '$.discounts.codes[0]' }] }) });
    const { out } = await create({ env: PRICING, door });
    assert.ok(out.messages.some((m) => m.code === 'seller.storefront_message' && m.content.endsWith('discount_code_expired')));
    assert.equal(codeMessages(out).length, 0);
  });

  test('codes the seller echoes or names that break the content rule are never repeated to the agent', async () => {
    const BIDI = 'EVIL\u{e0041}\u202eCODE';
    const door = fakeDoor({ get: () => sellerCart({ discount: 100, discounts: { codes: [BIDI, 'GOOD1'], applied: [{ code: BIDI, amount: 100 }] } }) });
    const priced = await priceOnMerchantDoor({
      items: [{ product_id: SEED.product_id, quantity: 2 }], rows: new Map([[SEED.product_id, SEED]]),
      sellerHost: 'brand.example', cartId: 'gid://shopify/Cart/c1', env: ON, merchantDoor: door,
    });
    assert.deepEqual(priced.discounts.codes, ['GOOD1']);
    assert.equal(JSON.stringify(priced.discounts).includes('EVIL'), false);
  });

  test('the seller never priced the cart: catalog answer, the code echoed, nothing applied, and said so', async () => {
    const door = fakeDoor({ create: () => ({ ok: false, status: 503, error: { message: 'down' } }) });
    const { out } = await create({ door });
    assert.equal(out.messages[0].code, 'checkout.completes_on_seller_storefront');
    assert.deepEqual(out.discounts, { codes: [CODE], applied: [] });
    const [m] = codeMessages(out);
    assert.equal(m.code, 'discount_code_not_evaluated');
    assert.match(m.content, /did not price this checkout/);
  });
});

describe('what never leaves the door', () => {
  test('seller discount text never reaches the agent; the code never reaches a log', async () => {
    const log = fakeLog();
    const door = fakeDoor({
      create: () => sellerCart({
        discount: 2580, discounts: appliedCode(2580),
        messages: [{ type: 'info', code: 'note', content: SELLER_TEXT }],
      }),
    });
    const { out } = await create({ door, log });
    assert.equal(JSON.stringify(out).includes(SELLER_TEXT), false);
    assert.equal(JSON.stringify(log.lines).includes(CODE), false);
    assert.equal(JSON.stringify(log.lines).toLowerCase().includes(CODE.toLowerCase()), false);
    assert.ok(log.lines.some((l) => l.outcome === 'discount_codes' && l.sent === true));
  });
});

describe('the code content rule', () => {
  // Each range pinned on its own: one class edit can drop one without the others noticing.
  const REFUSED = {
    'DEL': 'A\u007fB', 'C1 control': 'A\u0085B', 'NUL': 'A\u0000B',
    'word joiner range (U+2060-206F)': 'A\u2061B', 'U+206F': 'A\u206fB', 'BOM': '\ufeffAB', 'Arabic letter mark': 'A\u061cB',
    'RLO': 'A\u202eB', 'zero-width space': 'A\u200bB', 'line separator': 'A\u2028B', 'paragraph separator': 'A\u2029B',
    'TAG letter (U+E0041)': 'AB\u{e0041}', 'TAG cancel (U+E007F)': 'AB\u{e007f}', 'soft hyphen': 'A\u00adB',
    'combining grapheme joiner': 'A\u034fB', 'Mongolian vowel separator': 'A\u180eB', 'Mongolian FVS1': 'A\u180bB', 'Mongolian FVS4': 'A\u180fB',
    'variation selector 16': 'A\ufe0fB', 'variation selector 17': 'A\u{e0100}B', 'Hangul choseong filler': 'A\u115fB',
    'Hangul jungseong filler': 'A\u1160B', 'Hangul filler': 'A\u3164B', 'halfwidth Hangul filler': 'A\uffa0B',
    'braille blank': 'A\u2800B', 'interlinear annotation anchor': 'A\ufff9B', 'lone high surrogate': 'A\ud800B',
    'lone low surrogate': 'A\udc00B', 'private use': 'A\ue000B', 'unassigned (U+0378)': 'A\u0378B', 'blank': '   ', 'empty': '',
  };
  for (const [name, code] of Object.entries(REFUSED)) {
    test(`refused: ${name}`, () => assert.equal(isAcceptableDiscountCode(code), false));
  }
  test('accepted: ordinary codes, accented and CJK letters, emoji', () => {
    for (const code of ['SAVE10', 'save-10_x', 'Café10', '日本10', 'A\u{1f600}', 'A'.repeat(128)]) assert.equal(isAcceptableDiscountCode(code), true, code);
  });
  test('length is counted in UTF-16 units, the unit the client bounds: 64 astral characters pass, 65 do not', () => {
    assert.equal(isAcceptableDiscountCode('\u{1f600}'.repeat(64)), true);
    assert.equal(isAcceptableDiscountCode('\u{1f600}'.repeat(65)), false);
    assert.equal(isAcceptableDiscountCode('A'.repeat(129)), false);
  });
});

describe('the pure readers', () => {
  const wanted = [{ gid: GID('44012345678901'), quantity: 2, product_id: SEED.product_id }];
  const payloadOf = (reply) => JSON.parse(reply.response.result.content[0].text);

  test('readSellerCart: a discount_code_* error blocks the price only while codes are off', () => {
    const p = payloadOf(sellerCart({ messages: [{ type: 'error', code: 'discount_code_invalid' }] }));
    assert.equal(readSellerCart(p, wanted, 'brand.example'), null);
    assert.ok(readSellerCart(p, wanted, 'brand.example', { discountCodesOn: true }));
    const other = payloadOf(sellerCart({ messages: [{ type: 'error', code: 'cart_invalid' }] }));
    assert.equal(readSellerCart(other, wanted, 'brand.example', { discountCodesOn: true }), null, 'any other error still blocks');
  });

  test('readSellerDiscounts: nothing to say is null; a not-sent reason wins over anything the seller said', () => {
    const plain = payloadOf(sellerCart());
    assert.equal(readSellerDiscounts(plain, wanted, readSellerCart(plain, wanted, 'brand.example'), {}), null);
    const p = payloadOf(sellerCart({ discount: 100, discounts: appliedCode(100) }));
    const read = readSellerCart(p, wanted, 'brand.example', { discountCodesOn: true });
    const d = readSellerDiscounts(p, wanted, read, { requested: CODE, notSentReason: 'not_sent_seller_does_not_advertise' });
    assert.deepEqual(d.outcomes, [{ code: CODE, status: 'not_confirmed', reason: 'not_sent_seller_does_not_advertise' }]);
    assert.deepEqual(d.applied, []);
  });

  test('matching ignores case and padding, as UCP matches codes', () => {
    const p = payloadOf(sellerCart({ discount: 100, discounts: appliedCode(100, '$.line_items[0]', ' WELCOME10 ') }));
    const read = readSellerCart(p, wanted, 'brand.example', { discountCodesOn: true });
    assert.equal(readSellerDiscounts(p, wanted, read, { requested: CODE }).outcomes[0].status, 'applied');
  });

  test('a RE-READ reports the codes on the seller cart, never a code handed to it', async () => {
    const door = fakeDoor({ get: () => sellerCart({ discount: 100, discounts: appliedCode(100, '$.line_items[0]', 'CARTCODE') }) });
    const priced = await priceOnMerchantDoor({
      items: [{ product_id: SEED.product_id, quantity: 2 }], rows: new Map([[SEED.product_id, SEED]]),
      sellerHost: 'brand.example', cartId: 'gid://shopify/Cart/c1', discountCode: CODE, env: ON, merchantDoor: door,
    });
    assert.deepEqual(priced.discounts.codes, ['CARTCODE']);
    assert.deepEqual(priced.discounts.outcomes, [{ code: 'CARTCODE', status: 'applied', reason: null }]);
  });

  test('the REAL door sends the code only when the seller profile it discovered advertises codes', async () => {
    const D = 'dev.ucp.shopping.discount';
    for (const [capabilities, expectSent] of [
      [{ [D]: [{ extends: ['dev.ucp.shopping.cart', 'dev.ucp.shopping.checkout'] }] }, true],
      [{ [D]: [{ extends: 'dev.ucp.shopping.cart' }] }, true],
      [{ [D]: [{ extends: ['dev.ucp.shopping.checkout'] }] }, false], // checkout only: codes are not sent on a cart
      [{ [D]: [{}] }, false],
      [{}, false],
    ]) {
      const sent = [];
      const client = {
        async discoverEndpoint(origin) {
          return { mcpEndpoint: ENDPOINT, businessProfile: { ucp: { capabilities } }, wellKnownUrl: `${origin}/.well-known/ucp`, status: 200 };
        },
        async createCart(ep, args) { sent.push(args); return sellerCart(); },
        async callTool() { return sellerCart(); },
      };
      const door = createMerchantDoor({ client, catalogQuery: async () => ({ rows: [{ shop_ids: 1 }] }) });
      const priced = await priceOnMerchantDoor({
        items: [{ product_id: SEED.product_id, quantity: 2 }], rows: new Map([[SEED.product_id, SEED]]),
        sellerHost: 'brand.example', discountCode: CODE, env: ON, merchantDoor: door,
      });
      assert.ok(priced, JSON.stringify(capabilities));
      assert.deepEqual(sent[0].discountCodes, expectSent ? [CODE] : undefined, JSON.stringify(capabilities));
    }
  });

  test('priceOnMerchantDoor without the code switch never reads discounts', async () => {
    const door = fakeDoor({ create: () => sellerCart({ discount: 100, discounts: appliedCode(100) }) });
    const priced = await priceOnMerchantDoor({
      items: [{ product_id: SEED.product_id, quantity: 2 }], rows: new Map([[SEED.product_id, SEED]]),
      sellerHost: 'brand.example', discountCode: CODE, env: PRICING, merchantDoor: door,
    });
    assert.equal(priced.discounts, undefined);
    assert.equal(sentArgs(door)[0].discountCodes, undefined);
  });
});

describe('through the UCP door', () => {
  const META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' }, 'idempotency-key': 'idem-0001-codes' };
  const SESSION = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
  const withEnv = async (vars, fn) => {
    const keys = [UCP_ESCALATION_FLAG, MERCHANT_PRICING_FLAG, SELLER_DISCOUNT_CODES_FLAG, 'REAP_AGENTIC_LANE_ENABLED', 'REAP_AGENTIC_CART_LINK_LANE_ENABLED'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) { if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
    try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  const createArgs = (discounts) => ({
    meta: META,
    checkout: { line_items: [{ item: { id: SEED.product_id }, quantity: 2 }], context: { address_country: 'US' }, ...(discounts ? { discounts } : {}) },
  });
  const surface = (door) => ucpDialectSurface(createCommerceToolSurface(executorWith({ [SEED.product_id]: SEED }), { cache: false, merchantDoor: door }));
  const rejected = (p) => p.then(() => null, (e) => e);

  test('declared on create_checkout only while all three switches are on, with the storefront description', () => {
    const declared = (env) => ucpCommerceToolDefinitionsFor(env).find((d) => d.name === 'create_checkout').inputSchema.properties.checkout.properties.discounts;
    assert.equal(declared(PRICING), undefined);
    const on = declared(ON);
    assert.equal(on.properties.codes.maxItems, 1);
    assert.match(on.properties.codes.description, /seller's own storefront/);
    assert.doesNotMatch(on.properties.codes.description, /Reap/);
    const both = declared({ ...ON, REAP_AGENTIC_LANE_ENABLED: '1', REAP_AGENTIC_CART_LINK_LANE_ENABLED: '1' });
    assert.match(both.properties.codes.description, /seller's own storefront/);
    assert.match(both.properties.codes.description, /Reap/);
  });

  test('switches on: the code is accepted, sent and reported end to end', async () => {
    await withEnv(ON, async () => {
      const door = fakeDoor({ create: () => sellerCart({ discount: 2580, discounts: appliedCode(2580) }) });
      const out = await surface(door).callTool('create_checkout', createArgs({ codes: [CODE] }), SESSION);
      assert.deepEqual(sentArgs(door)[0].discountCodes, [CODE]);
      assert.equal(out.discounts.applied[0].code, CODE);
      assert.equal(codeMessages(out).length, 0, 'the generic "not applied" notice is not added to an answer that applied it');
    });
  });

  test('the automatic Shopify delivery discount is preserved without a submitted code', async () => {
    const deliveryPath = '$.totals[?@.type == "fulfillment"]';
    const shopifyCart = () => {
      const quote = sellerCart({
        discount: 500,
        discounts: {
          codes: [],
          applied: [{
            amount: 500,
            method: 'each',
            automatic: true,
            allocations: [{ path: deliveryPath, amount: 500 }],
          }],
        },
      });
      const content = quote.response.result.content[0];
      const payload = JSON.parse(content.text);
      const total = payload.totals.find(row => row.type === 'total');
      total.amount += 500;
      payload.totals.push({ type: 'fulfillment', amount: 500 });
      content.text = JSON.stringify(payload);
      return quote;
    };
    await withEnv(ON, async () => {
      const ucp = surface(fakeDoor({ create: shopifyCart, get: shopifyCart }));
      const created = await ucp.callTool('create_checkout', createArgs(), SESSION);
      const reread = await ucp.callTool('get_checkout', { meta: META, id: created.id }, SESSION);
      for (const result of [created, reread]) {
        assert.deepEqual(result.discounts?.applied, [{
          automatic: true,
          amount: 500,
          method: 'each',
          allocations: [{ path: deliveryPath, amount: 500 }],
        }]);
        assert.equal(result.totals.find(row => row.type === 'total').amount, 25800);
      }
    });
  });

  test('a storefront answer that did not apply it carries ITS warning, not the generic notice', async () => {
    await withEnv(ON, async () => {
      const door = fakeDoor({ advertises: false });
      const out = await surface(door).callTool('create_checkout', createArgs({ codes: [CODE] }), SESSION);
      const msgs = codeMessages(out);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].code, 'discount_code_not_evaluated');
    });
  });

  test('switches off: `checkout.discounts` is refused as an unknown field, exactly as before', async () => {
    await withEnv(PRICING, async () => {
      const door = fakeDoor();
      const err = await rejected(surface(door).callTool('create_checkout', createArgs({ codes: [CODE] }), SESSION));
      assert.ok(err, 'refused');
      assert.match(JSON.stringify(toToolError(err)), /checkout\.discounts/);
      assert.equal(door.calls.length, 0, 'no seller contacted');
    });
  });

  test('more than one code is refused at the door', async () => {
    await withEnv(ON, async () => {
      const err = await rejected(surface(fakeDoor()).callTool('create_checkout', createArgs({ codes: ['A1', 'B2'] }), SESSION));
      assert.ok(err);
    });
  });

  test('storefront codes OFF (partner codes armed): a storefront answer gets the partner-only wording, exactly as before', async () => {
    await withEnv({ ...PRICING, REAP_AGENTIC_LANE_ENABLED: '1', REAP_AGENTIC_CART_LINK_LANE_ENABLED: '1' }, async () => {
      const door = fakeDoor();
      const out = await surface(door).callTool('create_checkout', createArgs({ codes: [CODE] }), SESSION);
      assert.equal(sentArgs(door)[0].discountCodes, undefined);
      const msgs = codeMessages(out);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].content, DISCOUNT_CODE_NOT_APPLIED_MESSAGE.content);
    });
  });

  test('storefront codes ON: an answer that is neither lane (a native row) gets the both-lanes wording', async () => {
    await withEnv(ON, async () => {
      const NATIVE = { product_id: 'p_native_1', title: 'Native Serum', price: 20, currency: 'USD', merchant_id: 'merchant_native',
        canonical_url: 'https://native.example/products/serum', product_key: 'prod::merchant_native::shopify::77', variants: [{ variant_id: '48930014462260' }] };
      const ucp = ucpDialectSurface(createCommerceToolSurface(executorWith({ [NATIVE.product_id]: NATIVE }), { cache: false, merchantDoor: fakeDoor() }));
      const out = await ucp.callTool('create_checkout', {
        meta: META,
        checkout: { line_items: [{ item: { id: NATIVE.product_id }, quantity: 1 }], buyer: { email: 'shopper@example.test' }, context: { address_country: 'US' }, discounts: { codes: [CODE] } },
      }, SESSION).then((v) => v, (e) => ({ error: e }));
      assert.equal(out.error, undefined, String(out.error && (out.error.detail?.reason || out.error.message)));
      const msgs = codeMessages(out);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].content, DISCOUNT_CODE_NOT_APPLIED_ANY_LANE_MESSAGE.content);
    });
  });

  test('the generic notice names both lanes while storefront codes are on', () => {
    assert.match(DISCOUNT_CODE_NOT_APPLIED_ANY_LANE_MESSAGE.content, /Reap/);
    assert.match(DISCOUNT_CODE_NOT_APPLIED_ANY_LANE_MESSAGE.content, /seller's own storefront/);
    assert.equal(DISCOUNT_CODE_NOT_APPLIED_ANY_LANE_MESSAGE.code, 'discount_code_invalid');
  });
});
