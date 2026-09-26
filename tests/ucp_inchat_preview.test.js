'use strict';

/*
 * Money-safety tests for the Phase 1 in-chat PRICED PREVIEW (Part B of
 * docs/ucp_inchat_preview_build_2026-07-13.md).
 *   (c) create_checkout preview -> normalized { item, shipping_options, tax, total, currency } from a fixture.
 *   (e) flag-OFF no-op for UCP_INCHAT_PREVIEW_ENABLED (warm-handoff result unchanged) + the completion flag.
 * NO live network — every fetch is a fixture injected via fetchImpl; the warm-handoff client is a fake.
 */

const {
  createUcpBuyerAgentClient,
  TOOL,
  buildCheckoutArgs,
} = require('../src/services/ucpBuyerAgentClient');
const {
  createWarmHandoffService,
  isInchatPreviewEnabled,
} = require('../src/services/ucpWarmHandoff');

// ---- fixtures --------------------------------------------------------------

const BUSINESS_PROFILE_FIXTURE = {
  ucp: {
    version: '2026-04-08',
    services: {
      'dev.ucp.shopping': [
        { version: '2026-04-08', transport: 'mcp', endpoint: 'https://cosrx.example.myshopify.com/ucp/mcp' },
      ],
    },
  },
};

// LIVE-shaped cosrx create_checkout priced payload (2026-07-13): `totals` is an ARRAY of { type, amount,
// display_text } in MINOR units; line_items[].item = { id, title, price, image_url }; currency top-level;
// shipping_options + tax are ABSENT (Shopify collects the full delivery address on the storefront), surfaced
// as a recoverable `delivery_address_required` message. shipping_options=[] / tax=null is the HONEST response.
const CREATE_CHECKOUT_PRICED_FIXTURE = {
  jsonrpc: '2.0',
  id: '3',
  result: {
    content: [{
      type: 'json',
      json: {
        id: 'checkout_xyz',
        status: 'requires_escalation',
        currency: 'USD',
        line_items: [{
          item: {
            id: 'gid://shopify/ProductVariant/111',
            title: 'Snail Mucin 96 Power Essence',
            price: '1600',
            image_url: 'https://cdn.example/snail.jpg',
          },
          quantity: 1,
        }],
        totals: [
          { type: 'subtotal', amount: '1600', display_text: '$16.00' },
          { type: 'total', amount: '1600', display_text: '$16.00' },
        ],
        continue_url: 'https://cosrx.example.myshopify.com/checkouts/xyz',
        messages: [{ code: 'delivery_address_required', severity: 'info', content: 'Enter address at checkout' }],
      },
    }],
  },
};

function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj);
  return { ok: status >= 200 && status < 300, status, async json() { return obj; }, async text() { return text; } };
}

function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    let body;
    try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    calls.push({ url, headers: init.headers || {}, body });
    if (String(url).endsWith('/.well-known/ucp')) return jsonResponse(routes.wellKnown ?? BUSINESS_PROFILE_FIXTURE);
    const tool = body && body.params && body.params.name;
    const fixture = routes[tool];
    if (fixture === undefined) return jsonResponse({ error: { code: -32601, message: 'unknown tool' } }, 404);
    if (typeof fixture === 'function') return fixture(body, init);
    return jsonResponse(fixture);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// ---- (c) create_checkout preview normalization -----------------------------

describe('(c) create_checkout priced preview -> normalized shape', () => {
  test('normalizes a fixture checkout into { item, shipping_options, tax, total, currency, ... }', async () => {
    const fetchImpl = makeFetch({ [TOOL.CREATE_CHECKOUT]: CREATE_CHECKOUT_PRICED_FIXTURE });
    const client = createUcpBuyerAgentClient({
      credential: 'test-token', profileUrl: 'https://agent.pivota.cc/.well-known/ucp-agent', fetchImpl,
    });
    const endpoint = 'https://cosrx.example.myshopify.com/ucp/mcp';

    const preview = await client.createCheckoutPreview(endpoint, {
      cartId: 'cart_abc',
      lineItems: [{ item: { id: 'gid://shopify/ProductVariant/111' }, quantity: 1 }],
    });

    expect(preview.ok).toBe(true);
    const p = preview.priced;
    // Item passthrough (no math, no coercion).
    expect(p.item.title).toBe('Snail Mucin 96 Power Essence');
    expect(p.item.variant_gid).toBe('gid://shopify/ProductVariant/111');
    expect(p.item.price).toBe('1600');
    // Totals sourced from the live ARRAY `totals`.
    expect(p.subtotal).toBe('1600');
    expect(p.total).toBe('1600');
    // Honest passthrough: shipping/tax absent until the storefront collects the full address.
    expect(p.shipping_options).toEqual([]);
    expect(p.tax).toBeNull();
    expect(p.currency).toBe('USD');
    expect(p.continue_url).toBe('https://cosrx.example.myshopify.com/checkouts/xyz');
    // The delivery-address message flags escalation to the storefront (still NO completion, NO payment).
    expect(preview.requires_escalation).toBe(true);
    expect(p.messages.some((m) => m.code === 'delivery_address_required')).toBe(true);

    // The wire NEVER carried a `payment` field or a synthetic full street address (context HINTS only).
    const call = fetchImpl.calls.find((c) => c.body && c.body.params && c.body.params.name === TOOL.CREATE_CHECKOUT);
    expect(call.body.params.arguments.checkout.payment).toBeUndefined();
    expect(JSON.stringify(call.body)).not.toMatch(/complete_checkout/);
    // Context carries only localization hints (country/region/postal/currency), never a shipping_address object.
    expect(call.body.params.arguments.checkout.context.address_country).toBe('US');
    expect(call.body.params.arguments.checkout.shipping_address).toBeUndefined();
  });

  test('buildCheckoutArgs strips any payment field (hard bound)', () => {
    const args = buildCheckoutArgs({
      cartId: 'cart_abc',
      lineItems: [{ item: { id: 'x' }, quantity: 1 }],
      checkout: { payment: { token: 'should_be_removed' } },
    });
    expect(args.checkout.payment).toBeUndefined();
  });
});

// ---- (e) flag-OFF no-op ----------------------------------------------------

// A fake buyer-agent client so the warm-handoff test is deterministic and offline.
function fakeClient(overrides = {}) {
  const spy = { createCheckoutPreviewCalls: 0 };
  const client = {
    discoverEndpoint: async () => ({ mcpEndpoint: 'https://cosrx.example.myshopify.com/ucp/mcp', status: 200 }),
    createCart: async () => ({
      ok: true,
      status: 200,
      response: {
        result: {
          content: [{
            type: 'json',
            json: {
              id: 'cart_abc',
              line_items: [{ item: { id: 'gid://shopify/ProductVariant/111', title: 'Snail Mucin' }, quantity: 1 }],
              continue_url: 'https://cosrx.example.myshopify.com/cart/111:1',
            },
          }],
        },
      },
    }),
    extractHandoffUrl: () => 'https://cosrx.example.myshopify.com/cart/111:1',
    createCheckoutPreview: async () => {
      spy.createCheckoutPreviewCalls += 1;
      return {
        ok: true,
        status: 200,
        priced: {
          item: { variant_gid: 'gid://shopify/ProductVariant/111', title: 'Snail Mucin', price: '1600' },
          shipping_options: [],
          tax: null,
          subtotal: '1600',
          total: '1600',
          currency: 'USD',
          continue_url: 'https://cosrx.example.myshopify.com/checkouts/xyz',
          status: 'requires_escalation',
          messages: [],
        },
        requires_escalation: true,
      };
    },
    ...overrides,
  };
  return { client, spy };
}

const BASE_PARAMS = {
  brandDomain: 'cosrx.com',
  variantGid: 'gid://shopify/ProductVariant/111',
  quantity: 1,
};

describe('(e) UCP_INCHAT_PREVIEW_ENABLED flag-OFF no-op', () => {
  test('flag OFF => warm-handoff result has NO `preview` key and createCheckoutPreview is NOT called', async () => {
    const { client, spy } = fakeClient();
    const svc = createWarmHandoffService({ client, previewEnabled: false });
    const res = await svc.resolveWarmHandoff(BASE_PARAMS);
    expect(res).not.toBeNull();
    expect(res.disposition).toBe('warm_handoff');
    expect(res.continue_url).toBe('https://cosrx.example.myshopify.com/cart/111:1');
    expect(res).not.toHaveProperty('preview');
    expect(spy.createCheckoutPreviewCalls).toBe(0);
  });

  test('flag OFF result is byte-identical to a run where the client has no preview capability at all', async () => {
    const { client: withPreview } = fakeClient();
    const off = createWarmHandoffService({ client: withPreview, previewEnabled: false });
    const offResult = await off.resolveWarmHandoff(BASE_PARAMS);

    const { client: noPreviewClient } = fakeClient({ createCheckoutPreview: undefined });
    const legacy = createWarmHandoffService({ client: noPreviewClient, previewEnabled: false });
    const legacyResult = await legacy.resolveWarmHandoff(BASE_PARAMS);

    expect(JSON.stringify(offResult)).toBe(JSON.stringify(legacyResult));
  });

  test('flag ON => `preview` enrichment is added (proves the flag is what gates it)', async () => {
    const { client, spy } = fakeClient();
    const svc = createWarmHandoffService({ client, previewEnabled: true });
    const res = await svc.resolveWarmHandoff(BASE_PARAMS);
    expect(spy.createCheckoutPreviewCalls).toBe(1);
    expect(res.preview).toBeTruthy();
    expect(res.preview.total).toBe('1600');
    expect(res.preview.currency).toBe('USD');
    // Enrichment NEVER carries payment/completion state.
    expect(JSON.stringify(res.preview)).not.toMatch(/complete_checkout|payment_token|delegate_payment/);
  });

  test('isInchatPreviewEnabled is DEFAULT OFF (env unset) and the completion flag is independent', () => {
    expect(isInchatPreviewEnabled({})).toBe(false);
    expect(isInchatPreviewEnabled({ UCP_INCHAT_PREVIEW_ENABLED: '0' })).toBe(false);
    expect(isInchatPreviewEnabled({ UCP_INCHAT_PREVIEW_ENABLED: '1' })).toBe(true);
    // The completion flag does NOT turn the preview on.
    expect(isInchatPreviewEnabled({ UCP_INCHAT_COMPLETION_ENABLED: '1' })).toBe(false);
  });
});

describe('(f) the preview is bounded by REMAINING budget, not by "budget not yet spent"', () => {
  // The old check was a START GATE: `now() - startedAt <= totalBudgetMs`. It let the preview begin
  // at budget-minus-1ms and then take its own full per-call ceiling on top. Measured against a
  // 2000ms click budget: 1954ms without the preview, 3455ms with it — past the BACKEND caller's
  // hard 2.5s asyncio.wait_for, which aborts to a COLD redirect. So enabling the flag did not
  // degrade to cart-only as designed; it threw the whole warm handoff away. A shopper is waiting
  // on a 302 for this.

  // Built on the file's own fakeClient so the service's full client contract is satisfied — my
  // first version hand-rolled one and was missing `extractHandoffUrl`, which failed for a reason
  // that had nothing to do with budgets.
  function slowClient({ cartMs, previewMs }) {
    let clock = 0;
    const advance = (ms) => { clock += ms; };
    const { client: base } = fakeClient();
    const spy = { createCheckoutPreviewCalls: 0, previewTimeoutMs: null };
    return {
      spy,
      now: () => clock,
      client: {
        ...base,
        discoverEndpoint: async (...a) => { advance(10); return base.discoverEndpoint(...a); },
        createCart: async (...a) => { advance(cartMs); return base.createCart(...a); },
        createCheckoutPreview: async (ep, opts) => {
          spy.createCheckoutPreviewCalls += 1;
          spy.previewTimeoutMs = opts && opts.timeoutMs;
          advance(previewMs);
          return base.createCheckoutPreview(ep, opts);
        },
      },
    };
  }

  test('a preview is NOT started when too little of the budget is left', async () => {
    // The cart alone consumed nearly all of it. Starting a create_checkout here could only time
    // out inside the remaining window and cost the shopper the wait for nothing.
    const { client, spy, now } = slowClient({ cartMs: 1950, previewMs: 1500 });
    const svc = createWarmHandoffService({ client, previewEnabled: true, totalBudgetMs: 2000, now });
    const res = await svc.resolveWarmHandoff(BASE_PARAMS);

    expect(res).not.toBeNull();
    expect(res.continue_url).toBeTruthy();
    expect(res).not.toHaveProperty('preview');
    expect(spy.createCheckoutPreviewCalls).toBe(0);
    // ...and the warm handoff itself SURVIVES. Degrading to cart-only is the designed behaviour;
    // losing the handoff is what the old gate actually did.
    expect(now()).toBeLessThanOrEqual(2000);
  });

  test('a preview that IS started cannot outlive the budget it was admitted under', async () => {
    // The clock MUST be injected here too. Without it `now()` is the wall clock, elapsed is ~0,
    // and the remaining budget is the full 2000 — so the assertion passes for the wrong reason
    // and cannot tell a remaining-budget ceiling from an independent per-call one.
    const { client, spy, now } = slowClient({ cartMs: 200, previewMs: 100 });
    const svc = createWarmHandoffService({
      client, previewEnabled: true, totalBudgetMs: 2000, now,
    });
    const res = await svc.resolveWarmHandoff(BASE_PARAMS);

    expect(res.preview).toBeTruthy();
    expect(spy.createCheckoutPreviewCalls).toBe(1);
    // The call was handed the REMAINING window, not an independent per-call ceiling.
    expect(typeof spy.previewTimeoutMs).toBe('number');
    expect(spy.previewTimeoutMs).toBeLessThanOrEqual(2000 - 200);
    expect(spy.previewTimeoutMs).toBeGreaterThan(0);
  });
});
