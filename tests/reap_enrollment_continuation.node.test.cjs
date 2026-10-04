'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReapAgenticPurchaseClient } = require('../src/services/reapAgenticPurchaseClient');

const PID = 'rp_283fba3ce85c4e59bb331e54';
const KEY = 'prod::external_seed::external_seed::ext_krave_fixture';
const VARIANT = '41596313010251';
const SKU = `${KEY}::sku_58ae6f8de2c8797993f2`;
const SELECTION = { product_key: KEY, variant_id: VARIANT, variant_key: SKU, merchant_domain: 'kravebeauty.com', market: 'US', currency: 'USD', unit_price_minor: 2800, quantity: 1, item_source: 'cart_link' };
const SNAPSHOT = { purchaseId: PID, productId: 'sig_krave_fixture', productKey: KEY, quantity: 1, currency: 'USD', unitMinor: 2800 };
const VIEW = { id: PID, state: 'needs_enrollment', product_key: KEY, merchant_domain: 'kravebeauty.com', quantity: 1, product_name: 'Synthetic fixture', totals: { currency: 'USD', our_price_minor: 2800 }, checkout_dispatch_state: 'not_dispatched', contact_reentry_required: true };
const SESSION = { user_ref: 'fixture-buyer', acp_session_id: 'fixture-session', agent_id: 'fixture-agent' };
const ON = { REAP_AGENTIC_LANE_ENABLED: '1', REAP_AGENTIC_CREATE_ENABLED: '1', REAP_AGENTIC_CART_LINK_LANE_ENABLED: '1', MERCHANT_PURCHASABILITY_GATE_ENABLED: '0', AGENT_CHECKOUT_UCP_ESCALATION_ENABLED: '1' };
function originalArgs() {
  return {
    meta: { 'ucp-agent': { profile: 'https://fixture.invalid/profile' }, 'idempotency-key': 'original-enrollment-fixture' },
    checkout: {
      line_items: [{ item: { id: SNAPSHOT.productId }, quantity: 1 }], context: { address_country: 'US' },
      buyer: { email: 'synthetic@example.test', consent_version: 'reap-agentic-v1' },
      fulfillment: { methods: [{ type: 'shipping', destinations: [{ first_name: 'Synthetic', last_name: 'Fixture', phone_number: '+14155550100', street_address: '900 Brannan St', address_locality: 'San Francisco', address_region: 'CA', postal_code: '94103', address_country: 'US' }] }] },
      reap: { expected_unit_price_minor: 2800, expected_currency: 'USD', expected_merchant_domain: 'kravebeauty.com', item_source: 'cart_link', selected_variant_id: VARIANT, selection: { ...SELECTION } },
    },
  };
}
async function withEnv(fn, extra = {}) {
  const before = {};
  for (const [key, value] of Object.entries({ ...ON, ...extra })) { before[key] = process.env[key]; process.env[key] = value; }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
async function setup({ recoveryView = VIEW, resumeView = { ...VIEW, state: 'resolving', contact_reentry_required: false }, recoveryStatus = 200, resumeStatus = 200, failResume = false, credentials = true, legacyIdentity = false } = {}) {
  const surfaceModule = await import('../mcp-server/src/commerceToolSurface.js');
  const lane = await import('../mcp-server/src/ucpReapAgenticLane.js');
  const calls = [], logs = [];
  const client = createReapAgenticPurchaseClient({
    baseUrl: 'https://backend.invalid', authHeaders: () => credentials ? { 'X-API-Key': 'fixture-key', 'X-Agent-User-JWT': 'fixture-jwt' } : {},
    logger: { warn: data => logs.push(data), info: data => logs.push(data) },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: init.method, body: JSON.parse(init.body), headers: init.headers });
      if (path.endsWith('/recover')) return { status: recoveryStatus, text: async () => JSON.stringify(recoveryView) };
      assert.equal(path, `/agent/v2/commerce/reap/purchases/${PID}/resume`, 'no create, prepare, or alternate transport');
      if (failResume) throw new Error('lost response');
      return { status: resumeStatus, text: async () => JSON.stringify(resumeView) };
    },
  });
  const surface = surfaceModule.ucpDialectSurface(surfaceModule.createCommerceToolSurface({ execute: async () => { throw new Error('no current catalog reads or alternate executor'); } }, {
    cache: false, reapAgentic: { client, recoveryIdentityReader: async () => { if (legacyIdentity) return { product_id: SNAPSHOT.productId, product_key: KEY, source_domain: 'kravebeauty.com', platform: 'external_seed', source_system: 'external_product_seeds_mirror_v1' }; throw new Error('selection witness must avoid current identity'); } },
  }));
  const id = lane.encodeReapCheckoutId(SNAPSHOT);
  return { surface, lane, calls, logs, client, id, args: { ...originalArgs(), checkout_id: id } };
}
function content(out, code) { return out.messages.find(message => message.code === code)?.content; }
const resumes = ctx => ctx.calls.filter(call => call.path.endsWith('/resume'));

for (const state of ['resolving', 'needs_enrollment', 'quoting']) {
  test(`paused ${state} resumes only the retained original purchase and exact owner body/key`, () => withEnv(async () => {
    const ctx = await setup({ recoveryView: { ...VIEW, state } });
    const out = await ctx.surface.callTool('resume_checkout', ctx.args, SESSION);
    assert.equal(out.id, ctx.id); assert.equal(out.status, 'incomplete');
    assert.equal(content(out, 'reap.checkout_dispatch_state'), 'not_dispatched');
    assert.equal(content(out, 'reap.contact_reentry_required'), 'false');
    assert.equal(ctx.calls.length, 2); assert.equal(resumes(ctx).length, 1);
    assert.deepEqual(ctx.calls[1].body, ctx.calls[0].body);
    assert.equal(ctx.calls[1].body.variant_key, SKU);
    assert.equal(ctx.calls[1].body.expected_unit_price_minor, 2800);
    assert.equal(ctx.calls[1].body.expected_currency, 'USD');
    assert.equal(ctx.calls[1].body.merchant_domain, 'kravebeauty.com');
    assert.equal(ctx.calls[1].body.item_source, 'cart_link');
    assert.equal(ctx.calls[1].headers['X-Agent-User-JWT'], 'fixture-jwt');
    for (const secret of ['synthetic@example.test', '900 Brannan St', 'fixture-jwt', PID, 'original-enrollment-fixture']) assert.equal(JSON.stringify(ctx.logs).includes(secret), false);
  }));
}

test('resume tool is explicitly a vendor mutation with exact original envelope plus opaque ID', () => withEnv(async () => {
  const ctx = await setup();
  const definition = ctx.surface.tools.find(tool => tool.name === 'resume_checkout');
  assert.equal(definition.annotations.readOnlyHint, false); assert.equal(definition.annotations.idempotentHint, true);
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.ok(definition.inputSchema.required.includes('checkout_id'));
  assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(), ['checkout', 'checkout_id', 'meta']);
  assert.equal(ctx.surface.isCommerceTool('resume_checkout'), true);
}));

for (const state of ['not_dispatched', 'dispatch_started', 'dispatched', 'unknown', undefined, null, 'NOT_DISPATCHED', true, '']) {
  test(`dispatch marker is authoritative and conservative for ${String(state)}`, async () => {
    const ctx = await setup();
    const out = ctx.lane.mapReapPurchaseToCheckout({ id: ctx.id, snapshot: SNAPSHOT, view: { ...VIEW, checkout_dispatch_state: state } });
    assert.equal(content(out, 'reap.checkout_dispatch_state'), ['not_dispatched', 'dispatch_started', 'dispatched', 'unknown'].includes(state) ? state : 'unknown');
    assert.equal(out.messages.find(message => message.code === 'reap.checkout_dispatch_state').path, '$.status');
    assert.equal(content(out, 'reap.contact_reentry_required'), 'true');
  });
}
for (const value of [true, false, undefined, null, 'true', 1]) {
  test(`contact marker emits only backend booleans: ${String(value)}`, async () => {
    const ctx = await setup();
    const out = ctx.lane.mapReapPurchaseToCheckout({ id: ctx.id, snapshot: SNAPSHOT, view: { ...VIEW, contact_reentry_required: value } });
    assert.equal(content(out, 'reap.contact_reentry_required'), typeof value === 'boolean' ? String(value) : undefined);
  });
}
for (const patch of [
  { state: 'new_backend_state' }, { state: 'processing' }, { state: 'awaiting_approval' }, { state: 'completed' }, { state: 'failed' }, { state: 'refused' }, { state: 'expired' },
  { checkout_dispatch_state: 'dispatch_started' }, { checkout_dispatch_state: 'dispatched' },
  { checkout_dispatch_state: 'unknown' }, { checkout_dispatch_state: undefined },
  { contact_reentry_required: false }, { contact_reentry_required: undefined },
]) {
  test(`repeated/non-resumable view ${JSON.stringify(patch)} remains the same read-only attempt`, () => withEnv(async () => {
    const ctx = await setup({ recoveryView: { ...VIEW, ...patch } });
    const out = await ctx.surface.callTool('resume_checkout', ctx.args, SESSION);
    assert.equal(out.id, ctx.id); assert.equal(ctx.calls.length, 1); assert.equal(resumes(ctx).length, 0);
  }));
}
for (const vars of [{ REAP_AGENTIC_CREATE_ENABLED: '0' }, { REAP_AGENTIC_LANE_ENABLED: '0' }]) {
  test(`dispatch gate ${JSON.stringify(vars)} refuses before any transport`, () => withEnv(async () => {
    const ctx = await setup();
    await assert.rejects(ctx.surface.callTool('resume_checkout', ctx.args, SESSION), error => error.detail?.reason === 'reap_create_paused');
    assert.equal(ctx.calls.length, 0);
  }, vars));
}
for (const [name, edit] of Object.entries({
  missing_id: args => delete args.checkout_id,
  malformed_id: args => args.checkout_id = '../other',
  wrong_id: (args, ctx) => args.checkout_id = ctx.lane.encodeReapCheckoutId({ ...SNAPSHOT, purchaseId: `rp_${'a'.repeat(24)}` }),
  changed_snapshot: (args, ctx) => args.checkout_id = ctx.lane.encodeReapCheckoutId({ ...SNAPSHOT, unitMinor: 2801 }),
  unknown_fields: args => args.payment = { card: 'never forwarded' },
  changed_key: args => args.meta['idempotency-key'] = '',
})) {
  test(`resume rejects ${name} with no dispatch or alternate checkout`, () => withEnv(async () => {
    const ctx = await setup(); edit(ctx.args, ctx);
    await assert.rejects(ctx.surface.callTool('resume_checkout', ctx.args, SESSION));
    assert.equal(resumes(ctx).length, 0);
  }));
}
for (const [name, options] of Object.entries({
  owner_miss: { recoveryStatus: 404, recoveryView: { detail: { error: 'purchase_not_found' } } },
  body_conflict: { recoveryStatus: 409, recoveryView: { detail: { error: 'idempotency_conflict' } } },
  no_credentials: { credentials: false },
})) {
  test(`${name} cannot authorize resume`, () => withEnv(async () => {
    const ctx = await setup(options);
    await assert.rejects(ctx.surface.callTool('resume_checkout', ctx.args, SESSION));
    assert.equal(resumes(ctx).length, 0);
  }));
}
test('resume requires verified existing buyer/session', () => withEnv(async () => {
  const ctx = await setup();
  await assert.rejects(ctx.surface.callTool('resume_checkout', ctx.args, {}));
  assert.equal(ctx.calls.length, 0);
}));
for (const [name, options] of Object.entries({
  lost_response: { failResume: true },
  server_error: { resumeStatus: 503, resumeView: {} },
  dispatch_uncertain: { resumeStatus: 409, resumeView: { detail: { error: 'checkout_dispatch_unresolved' } } },
  price_changed: { resumeStatus: 409, resumeView: { detail: { error: 'price_changed' } } },
  wrong_purchase: { resumeView: { ...VIEW, id: `rp_${'a'.repeat(24)}` } },
  wrong_price: { resumeView: { ...VIEW, totals: { currency: 'USD', our_price_minor: 2900 } } },
  wrong_seller: { resumeView: { ...VIEW, merchant_domain: 'other.invalid' } },
})) {
  test(`${name} after resume preserves same ID with unknown dispatch and no contact claim`, () => withEnv(async () => {
    const ctx = await setup(options);
    const out = await ctx.surface.callTool('resume_checkout', ctx.args, SESSION);
    assert.equal(out.id, ctx.id); assert.equal(out.status, 'incomplete');
    assert.equal(content(out, 'reap.checkout_dispatch_state'), 'unknown');
    assert.equal(content(out, 'reap.contact_reentry_required'), undefined);
    assert.ok(content(out, 'reap.view_unavailable')); assert.equal(resumes(ctx).length, 1);
  }));
}
test('backend client rejects malformed path selector without network access', async () => {
  const ctx = await setup();
  assert.equal((await ctx.client.resumePurchase('../other', {})).kind, 'not_found');
  assert.equal(ctx.calls.length, 0);
});


test('sole-variant legacy continuation retains absent selection/variant fields and original cart-link key', () => withEnv(async () => {
  const ctx = await setup({ legacyIdentity: true });
  delete ctx.args.checkout.reap.selection;
  delete ctx.args.checkout.reap.selected_variant_id;
  const out = await ctx.surface.callTool('resume_checkout', ctx.args, SESSION);
  assert.equal(out.id, ctx.id); assert.equal(resumes(ctx).length, 1);
  assert.deepEqual(ctx.calls[1].body, ctx.calls[0].body);
  assert.equal(Object.hasOwn(ctx.calls[1].body, 'variant_key'), false);
  assert.equal(ctx.calls[1].body.idempotency_key, ctx.lane.reapCartLinkIdempotencyKey(ctx.args.meta['idempotency-key']));
}));
test('duplicate continuation after progress only rereads the same attempt', () => withEnv(async () => {
  const recoveryView = { ...VIEW };
  const ctx = await setup({ recoveryView });
  const first = await ctx.surface.callTool('resume_checkout', ctx.args, SESSION);
  recoveryView.state = 'quoting'; recoveryView.contact_reentry_required = false;
  const second = await ctx.surface.callTool('resume_checkout', ctx.args, SESSION);
  assert.equal(first.id, ctx.id); assert.equal(second.id, ctx.id);
  assert.equal(resumes(ctx).length, 1); assert.equal(ctx.calls.length, 3);
}));


test('resume schema keeps the existing opaque-ID codec length bound', async () => {
  const ctx = await setup();
  const adapter = await import('../mcp-server/src/ucpArgumentAdapter.js');
  const long = ctx.lane.encodeReapCheckoutId({ ...SNAPSHOT, productId: 'x'.repeat(256), productKey: 'k'.repeat(256) });
  assert.ok(long.length > 512); assert.ok(ctx.lane.decodeReapCheckoutId(long));
  assert.equal(adapter.UCP_REAP_RESUME_INPUT_SCHEMA.properties.checkout_id.maxLength, ctx.lane.REAP_CHECKOUT_ID_MAX_CHARS);
  assert.doesNotThrow(() => adapter.ucpResumeToNativeToolArgs({ ...ctx.args, checkout_id: long }));
});

// A snake_case-shaped backend error is still untrusted data: ids, names,
// contact fragments and idempotency keys can all satisfy the syntax check.
for (const untrusted of [PID, 'buyer_ada_lovelace', 'ada_example_test', '14155550100', '900_brannan_st', 'original_enrollment_fixture', 'checkout_283fba3ce85c4e59bb331e54', 'price_changed']) {
  test(`resume logging never echoes canonical-shaped untrusted reason ${untrusted}`, () => withEnv(async () => {
    for (const response of [
      { detail: { error: untrusted } },
      { error: untrusted },
      { status: 'error', error: { code: 'CONFLICT', message: untrusted, details: { error: untrusted } } },
    ]) {
      const ctx = await setup({ resumeStatus: 409, resumeView: response });
      const out = await ctx.surface.callTool('resume_checkout', ctx.args, SESSION);
      assert.equal(out.id, ctx.id);
      assert.equal(content(out, 'reap.checkout_dispatch_state'), 'unknown');
      assert.equal(resumes(ctx).length, 1);
      const resumeLogs = ctx.logs.filter(entry => entry.route === 'resume');
      assert.equal(resumeLogs.length, 1);
      assert.equal(resumeLogs[0].code, 'resume_unavailable');
      assert.equal(JSON.stringify(ctx.logs).includes(untrusted), false);
      for (const sensitive of ['synthetic@example.test', '900 Brannan St', 'fixture-jwt', PID, 'original-enrollment-fixture']) {
        assert.equal(JSON.stringify(ctx.logs).includes(sensitive), false);
      }
    }
  }));
}

for (const [state, dispatch, error] of [
  ['quoting', 'dispatch_started', 'checkout_dispatch_unresolved'],
  ['awaiting_approval', 'dispatched', 'checkout_unresolvable:3:checkout_no_hosted_action'],
]) {
  test(`owner ${state}/${error} projects review-only nonterminal status without approval authority`, () => withEnv(async () => {
    const ctx = await setup({ recoveryView: { ...VIEW, state, checkout_dispatch_state: dispatch, contact_reentry_required: false, last_error_code: error, needs_human_count: 1 } });
    const out = await ctx.surface.callTool('resume_checkout', ctx.args, SESSION);
    assert.equal(out.id, ctx.id);
    assert.equal(out.status, 'incomplete');
    assert.equal(out.continue_url, undefined);
    assert.equal(content(out, 'reap.checkout_dispatch_state'), dispatch);
    const review = out.messages.find(message => message.code === 'reap.checkout_requires_review');
    assert.equal(review.type, 'warning'); assert.equal(review.path, '$.status');
    assert.equal(resumes(ctx).length, 0);
    assert.ok(content(out, 'reap.poll_after_seconds'));
    assert.equal(out.messages.some(message => message.code === 'reap.processing' || message.code === 'reap.completed'), false);
  }));
}
for (const error of [PID, 'arbitrary_provider_error', 'checkout_dispatch_unresolved_extra', 'checkout_unresolvable:2:checkout_no_hosted_action']) {
  test(`arbitrary backend reason ${error} cannot create review/approval authority`, () => withEnv(async () => {
    const ctx = await setup({ recoveryView: { ...VIEW, state: 'quoting', contact_reentry_required: false, last_error_code: error } });
    const out = await ctx.surface.callTool('resume_checkout', ctx.args, SESSION);
    assert.equal(content(out, 'reap.checkout_requires_review'), undefined);
    assert.equal(out.messages.some(message => message.code === 'reap.processing' || message.code === 'reap.completed'), false);
    assert.equal(JSON.stringify(ctx.logs).includes(error), false);
    assert.equal(resumes(ctx).length, 0);
  }));
}

test('recognized review reason blocks resume even with contradictory no-dispatch/contact flags', () => withEnv(async () => {
  const ctx = await setup({ recoveryView: { ...VIEW, state: 'quoting', last_error_code: 'checkout_dispatch_unresolved' } });
  const out = await ctx.surface.callTool('resume_checkout', ctx.args, SESSION);
  assert.ok(content(out, 'reap.checkout_requires_review'));
  assert.equal(content(out, 'reap.checkout_dispatch_state'), 'not_dispatched');
  assert.equal(resumes(ctx).length, 0);
}));
