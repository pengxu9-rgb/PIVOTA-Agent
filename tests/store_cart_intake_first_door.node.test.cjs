'use strict';

// THE NATIVE STORE-CART PATH APPLIES BUYER INTAKE FIRST (AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED on).
//
// That path answers a create without the kernel. It ran before buyer intake, so a create the kernel path refuses at
// intake (no idempotency key, no buyer email, a malformed cart) built a cart at the seller's store. Now the same
// intake rules, and the kernel path's idempotency-key rule, run before any product read, gate read or store call.
//
// Through the real `/mcp` door (tests/_support/storeCartHardeningDoor.cjs). Each defective create is compared with
//   - the SAME defect on a connected merchant's cart, which only the kernel path answers: same code, same reason,
//     same message, and
//   - the same request with the flag off, where the refusal is one this door already gave.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./_support/storeCartHardeningDoor.cjs');

const { IDS, AS } = h;
const ORIGINAL_ENV = { ...process.env };
const door = h.bootHardeningDoor({ port: 4463 });

test.before(async () => { await door.listen(); });
test.after(async () => {
  await door.close();
  process.env = { ...ORIGINAL_ENV };
});
test.beforeEach(() => { door.resetHardening(); h.setFlags([]); });

let seq = 0;
const storefront = (market = 'US') => h.nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 1]], { ...(market ? { market } : {}), n: 700 + (seq += 1) });
const connected = () => h.nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], { n: 700 + (seq += 1) });
const create = (args) => door.call('/mcp', 'create_checkout_session', args, { buyer: AS.A });
const errorOf = (answer) => (answer.value && answer.value.error) || null;
const refusal = (answer) => { const e = errorOf(answer); return e ? { code: e.code, reason: e.detail ? e.detail.reason : null, message: e.message, retriable: e.retriable } : null; };
const touched = (answer) => ({ store: answer.store.length, gate: answer.gate.length, upstream: answer.upstream.length, referral: answer.referral.length });
const NOTHING = { store: 0, gate: 0, upstream: 0, referral: 0 };

// Each defect, as a change to an otherwise good create.
const DEFECTS = {
  'no idempotency key': (a) => { delete a.idempotency_key; },
  'a numeric idempotency key': (a) => { a.idempotency_key = 12345678; },
  'a blank idempotency key': (a) => { a.idempotency_key = '        '; },
  'no buyer email': (a) => { delete a.quote.customer_email; },
  'an invalid buyer email': (a) => { a.quote.customer_email = 'not-an-email'; },
  'a quantity of zero': (a) => { a.quote.items[0].quantity = 0; },
  'a fractional quantity': (a) => { a.quote.items[0].quantity = 1.5; },
  'an empty cart': (a) => { a.quote.items = []; },
  'a line with no product id': (a) => { a.quote.items = [{ quantity: 1 }]; },
  'more lines than a cart may hold': (a) => { a.quote.items = Array.from({ length: 51 }, () => ({ product_id: IDS.SIG_A, quantity: 1 })); },
};
const KEY_DEFECTS = ['no idempotency key', 'a numeric idempotency key', 'a blank idempotency key'];
const withDefect = (args, name) => { const copy = structuredClone(args); DEFECTS[name](copy); return copy; };

for (const name of Object.keys(DEFECTS)) {
  test(`${name}: refused as the kernel path refuses it, before any read, gate or store call`, async () => {
    h.setFlags([h.NATIVE_DOOR_FLAG]);
    const onStorefront = await create(withDefect(storefront(), name));
    assert.equal(onStorefront.isError, true, onStorefront.raw);
    assert.deepEqual(touched(onStorefront), NOTHING);

    // The same defect on a cart only the kernel path answers.
    const onKernel = await create(withDefect(connected(), name));
    assert.equal(onKernel.isError, true, onKernel.raw);
    assert.deepEqual(refusal(onStorefront), refusal(onKernel));
    assert.equal(refusal(onStorefront).retriable, false);
    assert.notEqual(refusal(onStorefront).reason, 'ucp_storefront_checkout_unavailable');

    // And with the flag off (no `market`: that argument does not exist there), this door's own refusal.
    h.setFlags([]);
    const off = await create(withDefect(storefront(null), name));
    assert.deepEqual(refusal(off), refusal(onStorefront));
    assert.equal(off.store.length, 0);
  });
}

test('the codes: a missing key is IDEMPOTENCY_CONFLICT, a missing email and a bad cart are QUOTE_REQUIRED by name', async () => {
  h.setFlags([h.NATIVE_DOOR_FLAG]);
  const codes = {};
  for (const name of Object.keys(DEFECTS)) {
    const r = refusal(await create(withDefect(storefront(), name)));
    codes[name] = [r.code, r.reason];
  }
  for (const name of KEY_DEFECTS) assert.equal(codes[name][0], 'IDEMPOTENCY_CONFLICT', name);
  assert.deepEqual(codes['no buyer email'], ['QUOTE_REQUIRED', 'acp_buyer_email_required']);
  assert.deepEqual(codes['an invalid buyer email'], ['QUOTE_REQUIRED', 'acp_buyer_email_required']);
  for (const name of ['a quantity of zero', 'a fractional quantity', 'an empty cart', 'a line with no product id']) assert.equal(codes[name][0], 'QUOTE_REQUIRED', name);
  assert.deepEqual(codes['more lines than a cart may hold'], ['QUOTE_REQUIRED', 'acp_cart_too_many_items']);
});

test('intake comes before this path\'s own refusals: a create with no email AND no market is refused for the email', async () => {
  h.setFlags([h.NATIVE_DOOR_FLAG]);
  const a = await create(withDefect(storefront(null), 'no buyer email'));
  assert.deepEqual([refusal(a).code, refusal(a).reason], ['QUOTE_REQUIRED', 'acp_buyer_email_required']);
  assert.deepEqual(touched(a), NOTHING);
  // With the email, the same create is refused for the market, as before.
  const b = await create(storefront(null));
  assert.equal(refusal(b).reason, 'market_required_for_seller_storefront');
});

test('a good create is answered exactly as before: the store\'s cart, one store call', async () => {
  h.setFlags([h.NATIVE_DOOR_FLAG]);
  const a = await create(storefront());
  assert.equal(a.isError, false, a.raw);
  assert.equal(a.value.status, 'completes_on_seller_storefront');
  assert.deepEqual(a.store.filter((c) => c.kind === 'tool').map((c) => c.tool), ['create_cart']);
  // Intake ran on a copy: the cart sent is the caller's cart.
  assert.equal(a.store.find((c) => c.kind === 'tool').arguments.cart.line_items[0].quantity, 1);
});

test('what the shared bounds refuse on the kernel path is refused here the same, and what they accept is accepted: a 3-character key, a key outside printable ASCII, a very large quantity', async () => {
  // THE RULE CHANGED, AND THIS TEST WITH IT. It used to pin that neither a short key nor a very large quantity was
  // an intake rule on either path, "so that adding either rule is a decision made for both paths at once". Both
  // are now the shared intake bounds (a present key: printable ASCII, at least 8 characters; a line: at most 999
  // units), and that decision WAS made for both paths at once: each is refused on this path exactly as on the
  // kernel path (code, reason, message), before any read, gate, referral or store call, for every market.
  h.setFlags([h.NATIVE_DOOR_FLAG]);
  const defects = {
    'a 3-character key': [(a) => { a.idempotency_key = 'abc'; }, 'IDEMPOTENCY_CONFLICT', 'idempotency_key_too_short'],
    'a 7-character key': [(a) => { a.idempotency_key = 'idem-07'; }, 'IDEMPOTENCY_CONFLICT', 'idempotency_key_too_short'],
    'a key with a letter outside ASCII': [(a) => { a.idempotency_key = 'clé-intake-0001'; }, 'IDEMPOTENCY_CONFLICT', 'idempotency_key_bad_characters'],
    'a key with DEL': [(a) => { a.idempotency_key = 'idem\u007fintake-01'; }, 'IDEMPOTENCY_CONFLICT', 'idempotency_key_bad_characters'],
    'a very large quantity': [(a) => { a.quote.items[0].quantity = 900000000; }, 'QUOTE_REQUIRED', 'quantity_above_line_maximum'],
    'a quantity of 1000': [(a) => { a.quote.items[0].quantity = 1000; }, 'QUOTE_REQUIRED', 'quantity_above_line_maximum'],
  };
  for (const [name, [apply, code, reason]] of Object.entries(defects)) {
    const kernelArgs = connected();
    apply(kernelArgs);
    const onKernel = await create(kernelArgs);
    assert.equal(onKernel.isError, true, `${name}: ${onKernel.raw}`);
    assert.deepEqual([refusal(onKernel).code, refusal(onKernel).reason, refusal(onKernel).retriable], [code, reason, false], name);
    assert.deepEqual(touched(onKernel), NOTHING, name);
    for (const market of ['US', 'SG', 'GB', 'DE']) {
      const args = storefront(market);
      apply(args);
      const onStorefront = await create(args);
      assert.equal(onStorefront.isError, true, `${name} ${market}: ${onStorefront.raw}`);
      assert.deepEqual(refusal(onStorefront), refusal(onKernel), `${name} ${market}`);
      assert.deepEqual(touched(onStorefront), NOTHING, `${name} ${market}`);
    }
    // The flag off (no `market`: that argument does not exist there): the same refusal.
    h.setFlags([]);
    const offArgs = storefront(null);
    apply(offArgs);
    const off = await create(offArgs);
    assert.deepEqual(refusal(off), refusal(onKernel), `${name}, flag off`);
    assert.deepEqual(touched(off), NOTHING, `${name}, flag off`);
    h.setFlags([h.NATIVE_DOOR_FLAG]);
  }
  // At the bounds, both paths answer: a key of exactly 8 characters, a line of exactly 999 units.
  const eightKernel = await create({ ...connected(), idempotency_key: 'idem-008' });
  assert.equal(eightKernel.isError, false, eightKernel.raw);
  const atBounds = { ...storefront(), idempotency_key: 'idem-009' };
  atBounds.quote.items[0].quantity = 999;
  const answered = await create(atBounds);
  assert.equal(answered.isError, false, answered.raw);
  assert.equal(answered.store.find((c) => c.kind === 'tool').arguments.cart.line_items[0].quantity, 999);
  // The seller here is priced in USD and the request names US: the answer states USD and no other currency.
  assert.equal(answered.value.currency, 'USD', answered.raw);
});
