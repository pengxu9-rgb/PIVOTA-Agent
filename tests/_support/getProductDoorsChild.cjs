'use strict';

// ONE FLAG COMBINATION OF THE REAL get_product DOORS (/mcp, /ucp/mcp, /public/mcp), offline, in its own process:
// the tool surfaces read UCP_LIVE_PRODUCT_READ when they load, so each combination needs a fresh process. Prints
// one JSON line: every answer body (ids masked), the price_verification_served line each wrote, and what the
// merchant's UCP client was asked. Driven by tests/get_product_forward_market_doors.node.test.cjs.
//
// No store, backend or merchant is contacted: tests/_support/priceLogDoors.cjs answers the merchant's UCP catalog
// with a fake client (VARIANT at 2300 USD minor for any country) and nock answers the unscoped detail's
// loopback get_pdp_v2 for PRODUCT_ID below.
//
// IT MUST RUN UNCHANGED ON A TREE WITHOUT PR-5 (the flag-off fixture is captured on one), so it requires nothing
// PR-5 adds.
//
// Usage: node tests/_support/getProductDoorsChild.cjs <port>   (env: the flags under test)

const crypto = require('node:crypto');
const { mock } = require('node:test');
const nock = require('nock');
const { createPriceLogDoors, rpc, AGENT_META, maskIds } = require('./priceLogDoors.cjs');

const PRODUCT_ID = 'sig_pr5_tint';
const STORE = 'store.price-log.test';
const VARIANT = '43734829564039';

const port = Number(process.argv[2]) || 3994;
const doors = createPriceLogDoors({ port });
const supertest = require('supertest');

// The unscoped detail: get_product_detail loops back into get_pdp_v2 (src/server.js); its canonical module is the
// stored product. One variant, priced 25 USD, sold on STORE at /products/tint (the fake merchant's handle).
nock(doors.LOOPBACK, { allowUnmocked: true }).persist()
  .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'get_pdp_v2' && body.payload?.product_ref?.product_id === PRODUCT_ID)
  .reply(200, {
    status: 'success',
    modules: [{
      type: 'canonical',
      data: {
        pdp_payload: {
          product: {
            product_id: PRODUCT_ID,
            title: 'Tint',
            brand: { name: 'Brand T' },
            description: 'A lip tint.',
            price: { current: { amount: 25, currency: 'USD' } },
            // The real lane's stock shape (src/pdpBuilder.js buildPdpPayload): an availability OBJECT on the product
            // and on each variant, and no top-level in_stock (the detail normalizer leaves it undefined). The door
            // test pins this shape against buildPdpPayload itself.
            availability: { in_stock: true, available_quantity: 4 },
            destination_url: `https://${STORE}/products/tint`,
            default_variant_id: VARIANT,
            variants: [{ variant_id: VARIANT, title: 'Rose', price: { current: { amount: 25, currency: 'USD' } }, availability: { in_stock: true, available_quantity: 4 } }],
          },
        },
      },
    }],
  });

const listTools = (path) => () => supertest(doors.app).post(path).send({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
const call = (path, name, args) => () => supertest(doors.app).post(path).send(rpc(name, args));
const ucpGet = (catalog) => call('/ucp/mcp', 'get_product', { meta: AGENT_META, catalog });

// The UCP cases run FIRST: the reader's 30 s lookup memo would otherwise hand them the /mcp read's answer, and
// whether THIS door asked the merchant is what they are here to show.
const CASES = {
  ucp_gp: ucpGet({ id: PRODUCT_ID }),
  ucp_gp_ctx_blank: ucpGet({ id: PRODUCT_ID, context: { address_country: '  ' } }),
  ucp_gp_ctx_other: ucpGet({ id: PRODUCT_ID, context: { currency: 'USD', language: 'en' } }),
  ucp_gp_ctx: ucpGet({ id: PRODUCT_ID, context: { address_country: 'US' } }),
  mcp_gp: call('/mcp', 'get_product', { merchant_id: 'external_seed', product_id: PRODUCT_ID }),
  mcp_gp_market: call('/mcp', 'get_product', { merchant_id: 'external_seed', product_id: PRODUCT_ID, market: 'US' }),
  public_gp: call('/public/mcp', 'get_product', { product_id: PRODUCT_ID }),
  public_gp_market: call('/public/mcp', 'get_product', { product_id: PRODUCT_ID, market: 'US' }),
  mcp_tools: listTools('/mcp'),
  ucp_tools: listTools('/ucp/mcp'),
  public_tools: listTools('/public/mcp'),
};

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
// The served line, without its per-request ids.
const servedLine = (lines) => lines
  .filter((l) => l.event === 'price_verification_served')
  .map(({ request_id: _r, agent_id: _a, ...rest }) => rest);
// The reader's own lines (get_product_ucp_live_read): the market it read for and what it found.
const reads = (lines) => lines
  .filter((l) => l.event === 'get_product_ucp_live_read')
  .map((l) => ({ mode: l.mode, market: l.market, status: l.status, reason: l.reason }));
// What the merchant was asked: the variant ids of each lookup.
const lookups = (calls) => calls.map((c) => JSON.parse(c)).filter((c) => c[1] && Array.isArray(c[1].ids)).map((c) => c[1].ids);

(async () => {
  await doors.start(mock.timers);
  const out = { env: {}, cases: {} };
  for (const k of ['UCP_LIVE_PRODUCT_READ', 'UCP_GET_PRODUCT_FORWARD_MARKET']) out.env[k] = process.env[k] || null;
  try {
    for (const [name, request] of Object.entries(CASES)) {
      const off = await doors.send(request, { flag: false });
      // A shadow read runs after the answer: let it settle, and count its lookups, before the next case.
      await new Promise((r) => setTimeout(r, 30));
      const asked = lookups(doors.merchantCalls);
      const read = reads(doors.lines);
      const on = await doors.send(request, { flag: true });
      await new Promise((r) => setTimeout(r, 30));
      const body = maskIds(off.text);
      out.cases[name] = {
        status: off.status,
        body,
        sha256: sha(body),
        on_identical: maskIds(on.text) === body,
        served: servedLine(on.lines),
        lookups: asked,
        reads: read,
      };
    }
  } finally {
    await doors.stop(mock.timers);
  }
  // Exit only once the line is written: a piped stdout is asynchronous, and exiting first truncates it.
  process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
})().catch((e) => {
  process.stderr.write(`${e && e.stack}\n`);
  process.exit(1);
});
