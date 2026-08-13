// The second seam no other test crosses: UCP `checkout.fulfillment` -> the ORDER BODY pivota-backend receives.
//
// WHY THIS FILE EXISTS. BLOCKER #2 of lighting the UCP door. pivota-backend origin/main
// `routes/agent_v2.py::_coerce_shipping_address` (reached from `POST /agent/v2/orders`) requires
// name/address_line1/city/postal_code/country UNCONDITIONALLY. The UCP adapter published no address field at
// all, so a UCP completion was refused 400 INVALID_BUYER_CONTEXT — AFTER a valid payment authorization had
// verified. The lane could not place an order even with a perfect grant.
//
// The fix could not be checked by looking at either half. The address enters on `create_checkout` and the
// order is created by `complete_checkout`, and `complete_checkout` HAS NO FULFILLMENT MEMBER — its checkout
// object accepts only `{payment, attribution}`. What carries the address across that gap is four files deep:
//
//   ucpArgumentAdapter.mapFulfillment      -> quote.shipping_address
//   commerceToolSurface.pickQuote          -> the canonical create params
//   kernel.buyerContextFromQuotePayload    -> the LOCKED quote snapshot's buyer_context
//   kernel.createOrder                     -> prefers the LOCKED address (`lockedShipping || requestedShipping`)
//                                             over `params.shipping_address ?? {}` from the completing call
//
// Every one of those is individually correct-looking and none of them proves the chain. So this file wires the
// REAL commerce surface over the REAL canonical executor over the REAL SafetyKernel, drives UCP WIRE BODIES
// through it, and asserts on the `create_order` payload the BACKEND would receive — the last point before the
// 400. The subject here is the ADDRESS; the payment envelope's own gate is
// test/ucpPaymentAuthorizationContract.test.js, so payment verification is stubbed to attest.
//
// The load-bearing assertions, each written to fail against a specific wrong implementation:
//   - address never reaches the order            -> "the blocker is closed" (the whole point)
//   - address read from the COMPLETING call      -> same test: that call carries no address and must not need to
//   - a field dropped or transposed in mapping   -> "field for field, and nothing invented"
//   - guessing among several destinations        -> "multi-destination is refused, not resolved"
//   - a partial address reaching pricing         -> "an incomplete destination is refused BEFORE pricing"
//   - update silently keeping a dropped address  -> "an update RE-MINTS"
//   - the profile advertising a bound the door does not enforce -> "discovery matches the door"

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createCommerceToolSurface, ucpDialectSurface } from '../src/commerceToolSurface.js';
import { SafetyKernel } from '../../safety-kernel/src/kernel.js';
import { createCanonicalExecutor } from '../../safety-kernel/src/protocol/canonicalExecutor.js';
import { buildUcpProfile, activeCapabilityIntersection } from '../../safety-kernel/src/protocol/ucpProfile.js';
import { REQUIRED_ADDRESS_FIELDS, pickCompleteAddress } from '../../safety-kernel/src/protocol/buyerIntake.js';

// ---- the real stack ----------------------------------------------------------------------------------------

const KERNEL_SECRET = 'ucp-fulfillment-secret-0123456789';
const SESSION = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
const quiet = { info() {}, warn() {}, error() {} };

const QUOTE = {
  merchant_of_record: 'merch_A',
  currency: 'USD',
  locked_totals: { subtotal: 1800, tax: 100, shipping: 0, total: 1900 },
  line_items: [{ product_id: 'p_alpha', quantity: 1 }],
  acp_state: {},
};

/** The REAL surface -> REAL executor -> REAL kernel, recording what the BACKEND would receive. */
function realStack() {
  const upstreamCalls = [];
  const kernelUpstream = async (op, payload) => {
    upstreamCalls.push({ op, payload });
    if (op === 'preview_quote') return QUOTE;
    if (op === 'create_order') return { order_id: 'o_1', acp_state: {} };
    if (op === 'submit_payment') return { order_id: 'o_1', payment_id: 'pay_1', payment_status: 'succeeded' };
    return {};
  };
  // The catalog read the door resolves a default variant through; it must echo the id it was asked about or
  // buyerIntake's identity check refuses the answer.
  const readUpstream = async (op, payload) => (op === 'get_product_detail'
    ? { product: { product_id: payload?.product?.product_id, variants: [{ variant_id: `v_${payload?.product?.product_id}` }] } }
    : {});

  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: KERNEL_SECRET, log: quiet });
  const executor = createCanonicalExecutor({
    kernel,
    upstream: readUpstream,
    // The address is this file's subject; the envelope's real gate is the payment contract test.
    verifyPaymentAuthorization: async (_authz, bound) => ({
      ok: true, amount: bound.amount, currency: bound.currency, user_ref: bound.user_ref, method: 'ucp_handler',
    }),
  });
  const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));

  const payloadsFor = (op) => upstreamCalls.filter((c) => c.op === op).map((c) => c.payload);
  return {
    ucp,
    upstreamCalls,
    priced: () => payloadsFor('preview_quote'),
    /** The order body the backend would receive — where `_coerce_shipping_address` runs. */
    orderBody: () => {
      const orders = payloadsFor('create_order');
      assert.equal(orders.length, 1, `expected exactly one create_order, saw ${orders.length}`);
      return orders[0].order;
    },
  };
}

// ---- UCP wire bodies (the merchant's own spelling) ----------------------------------------------------------

const META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' }, 'idempotency-key': 'idem-create-1' };

/**
 * A complete live-shaped destination. Every value is DISTINCT and self-describing so a transposed field is
 * visible in the assertion rather than passing as "some string arrived".
 */
const DESTINATION = Object.freeze({
  id: 'dest_1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  phone_number: '+442071234567',
  street_address: '1 Analytical Way',
  extended_address: 'Flat 12',
  address_locality: 'London',
  address_region: 'Greater London',
  postal_code: 'EC1A 1BB',
  address_country: 'GB',
});

const fulfillment = (destination = DESTINATION, method = {}) => ({
  methods: [{ type: 'shipping', destinations: [destination], ...method }],
});

const createBody = (checkout = {}) => ({
  meta: META,
  checkout: {
    line_items: [{ item: { id: 'p_alpha' }, quantity: 1 }],
    buyer: { email: 'shopper@example.test' },
    ...checkout,
  },
});

/** `complete_checkout` as the spec defines it: an id and a payment envelope. NO address field exists here. */
const completeBody = (session_id) => ({
  meta: { ...META, 'idempotency-key': 'idem-complete-1' },
  id: session_id,
  checkout: { payment: { method: 'ucp_handler', token: 'grant.jwt.signature' } },
});

const rejected = (promise) => promise.then(() => null, (e) => e);

// ---- 1. the blocker, closed --------------------------------------------------------------------------------

describe('a UCP checkout can actually place an order', () => {
  test('the blocker is closed: the address supplied at create reaches the ORDER, though complete carries none', async () => {
    const stack = realStack();

    const created = await stack.ucp.callTool('create_checkout', createBody({ fulfillment: fulfillment() }), SESSION);
    const session_id = created.session_id ?? created.id;
    assert.ok(session_id, 'create_checkout must return a session id');

    // The completing call is the SPEC's complete_checkout — there is no field on it in which to put an
    // address, which is exactly why this test exists. If the chain depended on the completing call, this
    // would be the 400.
    const complete = completeBody(session_id);
    assert.equal(JSON.stringify(complete).includes('Analytical'), false, 'complete carries no address, by design');
    await stack.ucp.callTool('complete_checkout', complete, SESSION);

    // THE ASSERTION THE WHOLE CHANGE EXISTS FOR: what `_coerce_shipping_address` would receive.
    const address = stack.orderBody().shipping_address;
    assert.ok(address, 'the order must carry a shipping address, or the backend answers 400 INVALID_BUYER_CONTEXT');
    const missing = REQUIRED_ADDRESS_FIELDS.filter((f) => !address[f] && !(f === 'name' && address.recipient_name));
    assert.deepEqual(missing, [], `the backend requires all of ${REQUIRED_ADDRESS_FIELDS.join(', ')}`);
  });

  test('the blocker REPRODUCES without a destination — this test would have failed before the fix', async () => {
    // The control. A create with no `fulfillment` still completes through the gateway and still reaches
    // create_order — with an EMPTY address, which is precisely the 400. Pinning it proves the assertion above
    // is measuring the address and not merely that a completion happens.
    const stack = realStack();
    const created = await stack.ucp.callTool('create_checkout', createBody(), SESSION);
    await stack.ucp.callTool('complete_checkout', completeBody(created.session_id ?? created.id), SESSION);

    const address = stack.orderBody().shipping_address ?? {};
    const missing = REQUIRED_ADDRESS_FIELDS.filter((f) => !address[f]);
    assert.deepEqual(
      missing, [...REQUIRED_ADDRESS_FIELDS],
      'with no destination the order body is address-less — the 400 this change exists to prevent',
    );
  });

  test('field for field, and nothing invented', async () => {
    const stack = realStack();
    await stack.ucp.callTool('create_checkout', createBody({ fulfillment: fulfillment() }), SESSION);

    // Read at PRICING, the first place the canonical address exists. Values are distinct, so a mapper that
    // transposed `address_locality` and `address_region` (say) fails here rather than shipping to the wrong city.
    const address = stack.priced().at(-1).quote.shipping_address;
    assert.equal(address.name, 'Ada Lovelace', 'name is COMPOSED from first_name + last_name');
    assert.equal(address.address_line1, '1 Analytical Way');
    assert.equal(address.address_line2, 'Flat 12');
    assert.equal(address.city, 'London');
    assert.equal(address.state, 'Greater London');
    assert.equal(address.postal_code, 'EC1A 1BB');
    assert.equal(address.country, 'GB');
    assert.equal(address.phone, '+442071234567');
    // The destination's own `id` is routing metadata, not part of the address.
    assert.equal(JSON.stringify(address).includes('dest_1'), false, 'the destination id is not address data');
  });

  test('a surname is not required, and a missing one is not invented', async () => {
    const stack = realStack();
    const { last_name, ...noSurname } = DESTINATION;
    await stack.ucp.callTool('create_checkout', createBody({ fulfillment: fulfillment(noSurname) }), SESSION);

    const address = stack.priced().at(-1).quote.shipping_address;
    assert.equal(address.name, 'Ada', 'the name is whichever parts arrived — never padded out');
  });
});

// ---- 2. ambiguity is refused, never resolved by guessing ----------------------------------------------------

describe('the door refuses what it cannot represent instead of choosing', () => {
  test('multi-destination is refused, not resolved', async () => {
    // Pivota's quote holds ONE address. Picking one of two would ship goods to an address the buyer did not
    // choose for those lines — a silent, physical wrong answer. `selected_destination_id` does NOT unlock it:
    // the bound is what Pivota advertises (`allows_multi_destination: {shipping: false}`), not a tie-break.
    const second = { ...DESTINATION, id: 'dest_2', street_address: '2 Difference Engine Row' };
    const stack = realStack();
    const error = await rejected(stack.ucp.callTool('create_checkout', createBody({
      fulfillment: { methods: [{ type: 'shipping', selected_destination_id: 'dest_2', destinations: [DESTINATION, second] }] },
    }), SESSION));

    assert.ok(error, 'two destinations must be refused');
    assert.equal(error.detail?.reason, 'ucp_fulfillment_multi_destination_unsupported');
    assert.equal(stack.priced().length, 0, 'refused BEFORE pricing — no upstream call, no inventory hold');
    // PII must never reach an error body.
    assert.equal(JSON.stringify(error.detail ?? {}).includes('Analytical'), false, 'no address value in the refusal');
  });

  test('an EMPTY destinations/methods list is refused, not silently read as "no address"', async () => {
    // REVIEW FINDING. The schema declares `minItems: 1` on both arrays, and the mapper used to return
    // `undefined` for `[]` — laxer than the contract it publishes, on the one field that decides whether an
    // order can be created. The failure it caused was not a rejected call but an ACCEPTED one: a platform
    // whose destination lookup came back empty opened an address-less checkout, authorized payment, and was
    // refused 400 INVALID_BUYER_CONTEXT by the backend at order creation — this blocker reappearing AFTER a
    // valid grant verified, naming canonical fields UCP has no word for. These bodies must die at the door.
    const EMPTY = [
      ['destinations: []', { methods: [{ type: 'shipping', destinations: [] }] }, 'ucp_fulfillment_destinations_empty'],
      ['methods: []', { methods: [] }, 'ucp_fulfillment_methods_empty'],
    ];
    for (const [label, ful, reason] of EMPTY) {
      const stack = realStack();
      const error = await rejected(stack.ucp.callTool('create_checkout', createBody({ fulfillment: ful }), SESSION));

      assert.ok(error, `${label} must be refused, not accepted with no address`);
      assert.equal(error.detail?.reason, reason, label);
      assert.equal(stack.priced().length, 0, `${label}: refused before pricing`);
      // The refusal has to be ACTIONABLE in both directions — supply one, or omit fulfillment entirely.
      const message = String(error.detail?.acp_message ?? error.message);
      assert.match(message, /update_checkout/, `${label}: must say the address can come later`);
    }
  });

  test('omitting fulfillment is still legal — the empty-list refusal is not an address requirement', async () => {
    // The other side of the rule above, so the fix cannot drift into "every checkout must carry an address".
    // A create with NO `fulfillment` key must still price: the address is optional at quote time and only
    // required by the time an order is created.
    const stack = realStack();
    await stack.ucp.callTool('create_checkout', createBody(), SESSION);
    assert.equal(stack.priced().length, 1, 'an address-less create must still price');
    assert.equal(stack.priced().at(-1).quote.shipping_address, undefined);

    // …and so must a method that carries no `destinations` key at all (the caller has not chosen one yet).
    const stack2 = realStack();
    await stack2.ucp.callTool('create_checkout', createBody({
      fulfillment: { methods: [{ type: 'shipping', line_item_ids: ['line_1'] }] },
    }), SESSION);
    assert.equal(stack2.priced().length, 1, 'a method with no destinations key must still price');
    assert.equal(stack2.priced().at(-1).quote.shipping_address, undefined);
  });

  test('combining fulfilment methods is refused', async () => {
    const stack = realStack();
    const error = await rejected(stack.ucp.callTool('create_checkout', createBody({
      fulfillment: { methods: [{ type: 'shipping', destinations: [DESTINATION] }, { type: 'pickup' }] },
    }), SESSION));

    assert.ok(error, 'two methods must be refused');
    assert.equal(error.detail?.reason, 'ucp_fulfillment_multi_method_unsupported');
    assert.equal(stack.priced().length, 0);
  });

  test('an incomplete destination is refused BEFORE pricing, naming UCP`s OWN field spellings', async () => {
    // The naming matters as much as the refusal. buyerIntake's shared message names `address_line1`/`city` —
    // fields that DO NOT EXIST in the UCP destination shape, so a model following it would retry the identical
    // call and be refused identically. This is the misdirection buyerIntake already records for `buyer.email`.
    const stack = realStack();
    const { street_address, address_locality, ...partial } = DESTINATION;
    const error = await rejected(stack.ucp.callTool(
      'create_checkout', createBody({ fulfillment: fulfillment(partial) }), SESSION,
    ));

    assert.ok(error, 'a partial destination must be refused');
    assert.equal(error.detail?.reason, 'ucp_fulfillment_destination_incomplete');
    assert.deepEqual(
      [...(error.detail?.acp_detail?.missing_fields ?? [])].sort(), ['address_locality', 'street_address'],
      'the missing fields must be named as UCP spells them',
    );
    const message = String(error.detail?.acp_message ?? error.message);
    assert.match(message, /street_address/);
    assert.match(message, /address_locality/);
    assert.equal(/address_line1|\bcity\b/.test(message), false, 'must not name canonical fields UCP has no word for');
    assert.equal(stack.priced().length, 0, 'refused before pricing');
    assert.equal(JSON.stringify(error.detail ?? {}).includes('Lovelace'), false, 'no address value in the refusal');
  });

  test('a field that WAS sent is never reported as missing — wrong-typed is its own answer', async () => {
    // REVIEW FINDING. `nonEmpty` requires a non-blank STRING, so a numeric postcode was dropped and then
    // listed under `missing_fields` — telling the caller to supply a field it had demonstrably just sent.
    // The likely repair is to re-send the identical body, burning a retry: the same "refusal that misdirects"
    // failure this module documents for `buyer.email`.
    const stack = realStack();
    const error = await rejected(stack.ucp.callTool('create_checkout', createBody({
      fulfillment: fulfillment({ ...DESTINATION, postal_code: 90210 }), // unquoted — a routine serialization slip
    }), SESSION));

    assert.ok(error);
    assert.equal(error.detail?.reason, 'ucp_fulfillment_destination_incomplete');
    assert.deepEqual(error.detail?.acp_detail?.missing_fields, [],
      'postal_code was SENT, so it must not be called missing');
    assert.deepEqual(error.detail?.acp_detail?.invalid_fields, ['postal_code'],
      'it must be named as sent-but-unusable instead');
    const message = String(error.detail?.acp_message ?? error.message);
    assert.match(message, /Sent but unusable/);
    assert.match(message, /NON-EMPTY JSON STRING/, 'the message must say what makes it unusable');
    assert.equal(/Missing: /.test(message), false, 'nothing is missing here');
    assert.equal(stack.priced().length, 0);
  });

  test('absent and unusable are reported SEPARATELY when both occur', async () => {
    // The mixed case is what proves the two lists are really distinct rather than one relabelled: a blank
    // string was sent (unusable) while another field never arrived (missing), and each lands in its own list.
    const stack = realStack();
    const { address_locality, ...noCity } = DESTINATION;
    const error = await rejected(stack.ucp.callTool('create_checkout', createBody({
      fulfillment: fulfillment({ ...noCity, street_address: '   ' }),
    }), SESSION));

    assert.deepEqual(error.detail?.acp_detail?.missing_fields, ['address_locality']);
    assert.deepEqual(error.detail?.acp_detail?.invalid_fields, ['street_address']);
    const message = String(error.detail?.acp_message ?? error.message);
    assert.match(message, /Missing: `address_locality`/);
    assert.match(message, /Sent but unusable: `street_address`/);
  });

  test('a BLANK name part is unusable too — the composed field is not exempt from the distinction', async () => {
    // `name` is the one canonical field with no single UCP counterpart, so it is the one place the
    // absent-vs-unusable split could quietly not apply: it is composed from two fields rather than copied
    // from one. A blank `first_name` with no `last_name` at all is the case that separates them — one part
    // was SENT (and is unusable), the other genuinely never arrived.
    const stack = realStack();
    const { last_name, ...noSurname } = DESTINATION;
    const error = await rejected(stack.ucp.callTool('create_checkout', createBody({
      fulfillment: fulfillment({ ...noSurname, first_name: '   ' }),
    }), SESSION));

    assert.ok(error);
    assert.equal(error.detail?.reason, 'ucp_fulfillment_destination_incomplete');
    assert.deepEqual(error.detail?.acp_detail?.invalid_fields, ['first_name'],
      'a blank first_name was SENT — it is unusable, not missing');
    assert.deepEqual(error.detail?.acp_detail?.missing_fields, ['last_name'],
      'the part that never arrived is the only missing one');
    assert.equal(stack.priced().length, 0);

    // …and the MIRROR, because the two parts are handled by one loop and a mutant that walks only the first
    // would leave a blank `last_name` reported as missing while the test above still passed.
    const stack2 = realStack();
    const { first_name, ...noFirst } = DESTINATION;
    const mirrored = await rejected(stack2.ucp.callTool('create_checkout', createBody({
      fulfillment: fulfillment({ ...noFirst, last_name: '   ' }),
    }), SESSION));

    assert.deepEqual(mirrored.detail?.acp_detail?.invalid_fields, ['last_name']);
    assert.deepEqual(mirrored.detail?.acp_detail?.missing_fields, ['first_name']);
  });

  test('the narrowed catch rests on a shape the SHARED refusal really has', async () => {
    // REVIEW FINDING. The translation used to catch EVERYTHING and rethrow it as
    // `ucp_fulfillment_destination_incomplete`, so an unrelated fault inside buyerIntake would have been
    // dressed up as "your destination is incomplete" with nothing named. It now translates only a refusal
    // carrying `detail.acp_detail.missing_fields` and rethrows anything else UNCHANGED.
    //
    // That narrowing is only correct while the shared refusal really carries that shape, and the failure if
    // it ever stops is silent in the other direction: every incomplete destination would propagate the raw
    // kernel refusal naming `address_line1`/`city`, the canonical spellings this whole translation exists to
    // avoid. So the assumption is pinned here against the REAL function rather than trusted.
    let refusal;
    try {
      pickCompleteAddress({ city: 'London' });
      assert.fail('an incomplete address must be refused');
    } catch (error) {
      refusal = error;
    }
    assert.ok(Array.isArray(refusal.detail?.acp_detail?.missing_fields),
      'the UCP translation keys off this array; if it moves, the translation silently stops applying');
    assert.ok(refusal.detail.acp_detail.missing_fields.length > 0);
    // …and the canonical names it carries are exactly the ones the UCP door must translate away.
    assert.ok(refusal.detail.acp_detail.missing_fields.includes('address_line1'));
  });

  test('the completeness rule is the SHARED one — every backend-required field is enforced', async () => {
    // Driven from REQUIRED_ADDRESS_FIELDS itself, so a field added to the backend's requirement is covered
    // here automatically rather than needing a new case written by hand.
    const CANONICAL_TO_UCP = {
      name: ['first_name', 'last_name'],
      address_line1: ['street_address'],
      city: ['address_locality'],
      postal_code: ['postal_code'],
      country: ['address_country'],
    };
    for (const field of REQUIRED_ADDRESS_FIELDS) {
      const destination = { ...DESTINATION };
      for (const ucpField of CANONICAL_TO_UCP[field]) delete destination[ucpField];
      const stack = realStack();
      const error = await rejected(stack.ucp.callTool(
        'create_checkout', createBody({ fulfillment: fulfillment(destination) }), SESSION,
      ));
      assert.ok(error, `dropping ${field} must be refused`);
      assert.equal(error.detail?.reason, 'ucp_fulfillment_destination_incomplete', `for ${field}`);
      assert.equal(stack.priced().length, 0, `for ${field}: refused before pricing`);
    }
  });
});

// ---- 3. update RE-MINTS, and the tool description must say so ------------------------------------------------

describe('update_checkout re-mints the locked quote', () => {
  test('an update that omits fulfillment DROPS the address — it does not merge', async () => {
    // The executor routes create and update through the same previewQuote, so an update replaces the snapshot.
    // A caller that assumed merging would silently lose the destination and hit the 400 at completion; the
    // tool description tells them to re-send it, and this pins the behaviour that makes that necessary.
    const stack = realStack();
    const created = await stack.ucp.callTool('create_checkout', createBody({ fulfillment: fulfillment() }), SESSION);
    assert.ok(stack.priced().at(-1).quote.shipping_address, 'create captured the address');

    await stack.ucp.callTool('update_checkout', {
      meta: { ...META, 'idempotency-key': 'idem-update-1' },
      id: created.session_id ?? created.id,
      checkout: { line_items: [{ item: { id: 'p_alpha' }, quantity: 2 }], buyer: { email: 'shopper@example.test' } },
    }, SESSION);

    assert.equal(
      stack.priced().at(-1).quote.shipping_address, undefined,
      'an update without fulfillment re-mints WITHOUT the address',
    );
  });

  test('an update CAN supply the address, with the live update-shaped method', async () => {
    // update_checkout's method requires `line_item_ids` (create's requires `type`) and permits a method `id` —
    // a genuine live difference. A door publishing one shape for both would refuse this conforming body.
    const stack = realStack();
    const created = await stack.ucp.callTool('create_checkout', createBody(), SESSION);

    await stack.ucp.callTool('update_checkout', {
      meta: { ...META, 'idempotency-key': 'idem-update-2' },
      id: created.session_id ?? created.id,
      checkout: {
        line_items: [{ item: { id: 'p_alpha' }, quantity: 1 }],
        buyer: { email: 'shopper@example.test' },
        fulfillment: { methods: [{ id: 'ful_1', line_item_ids: ['line_1'], destinations: [DESTINATION] }] },
      },
    }, SESSION);

    const address = stack.priced().at(-1).quote.shipping_address;
    assert.equal(address.address_line1, '1 Analytical Way');
    assert.equal(address.city, 'London');
  });
});

// ---- 4. discovery cannot advertise a bound the door does not enforce ------------------------------------------

describe('the published capability matches the rule the door enforces', () => {
  const capabilityOf = (profile) => profile.capabilities.find((c) => c.id === 'dev.ucp.shopping.fulfillment');

  test('the profile declares dev.ucp.shopping.fulfillment, extending checkout', async () => {
    const capability = capabilityOf(buildUcpProfile({
      baseUrl: 'https://shop.pivota.cc', mcpEndpoint: 'https://shop.pivota.cc/mcp',
    }));
    assert.ok(capability, 'a platform must be able to DISCOVER that this door takes an address');
    assert.deepEqual(capability.extends, ['dev.ucp.shopping.checkout']);
    // The bound the door actually enforces, above. Advertising `true` here while `mapFulfillment` refuses
    // would send platforms into a mid-checkout refusal they were told to expect not to hit.
    assert.equal(capability.config.allows_multi_destination.shipping, false);
    assert.deepEqual(capability.config.allows_method_combinations, [['shipping']]);
  });

  test('a modifier is withheld when what it extends is withheld', async () => {
    // Under the checkout kill-switch the checkout capability disappears; a fulfillment modifier left behind
    // would describe the input shape of a door that is not there. The switch cannot be half-thrown.
    const dark = buildUcpProfile({
      baseUrl: 'https://shop.pivota.cc',
      mcpEndpoint: 'https://shop.pivota.cc/mcp',
      omitCapabilityIds: ['dev.ucp.shopping.checkout'],
    });
    assert.equal(capabilityOf(dark), undefined, 'no fulfillment modifier without the checkout it extends');
  });

  test('the PER-REQUEST active list cannot orphan the modifier either', async () => {
    // REVIEW FINDING. The profile's own list was guarded; the negotiated one was not, and it can orphan a
    // modifier the profile never did — a platform whose advertised ids name the extension but not what it
    // extends. `POST /ucp/capabilities` would then answer that `dev.ucp.shopping.fulfillment` is ACTIVE while
    // `dev.ucp.shopping.checkout` is not: self-contradictory, and readable as permission to send
    // `checkout.fulfillment` at a checkout the same response says is unavailable.
    const profile = buildUcpProfile({
      baseUrl: 'https://shop.pivota.cc', mcpEndpoint: 'https://shop.pivota.cc/mcp',
    });

    const orphaned = activeCapabilityIntersection(profile, ['dev.ucp.shopping.fulfillment']);
    assert.deepEqual(orphaned.map((c) => c.id), [], 'a modifier alone is not an active capability');

    // …and the modifier IS returned when the platform supports both — the guard must not cost the real case.
    const both = activeCapabilityIntersection(
      profile, ['dev.ucp.shopping.fulfillment', 'dev.ucp.shopping.checkout'],
    );
    assert.deepEqual(
      both.map((c) => c.id).sort(),
      ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.fulfillment'],
      'both sides support fulfillment, so it is active',
    );

    // A platform that supports checkout but NOT the extension keeps checkout, and is not handed a modifier
    // it never asked for.
    const checkoutOnly = activeCapabilityIntersection(profile, ['dev.ucp.shopping.checkout']);
    assert.deepEqual(checkoutOnly.map((c) => c.id), ['dev.ucp.shopping.checkout']);
  });
});
