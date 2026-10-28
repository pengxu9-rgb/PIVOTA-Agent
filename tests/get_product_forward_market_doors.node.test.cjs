'use strict';

// PR-5 (verified-price design, section 6 row 5) THROUGH THE REAL DOORS: /mcp, /ucp/mcp and /public/mcp, every
// get_product shape and every tools/list, under each combination of UCP_LIVE_PRODUCT_READ (off | shadow |
// enforce) and UCP_GET_PRODUCT_FORWARD_MARKET (off | on).
//
//   - Both flags off, every answer is byte-identical to origin/main before PR-5 (fixture, sha256 per answer).
//   - UCP_GET_PRODUCT_FORWARD_MARKET alone changes ONE thing: the UCP get_product declaration.
//   - shadow changes no get_product answer; the descriptions ask for `market` exactly where it is declared.
//   - enforce + forward: a UCP get_product with `catalog.context.address_country` is read live for that market;
//     without one (absent, blank, other context members only) nothing is read and the stored price is served.
//   - price_verification_served counts get_product `live` only when this request verified its price.
//
// Each combination runs in its own process (tests/_support/getProductDoorsChild.cjs): the tool surfaces read
// the flags when they load. Nothing leaves the process (see the child's header).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAIN = require('./fixtures/get_product_forward_market_main.json');
const CHILD = path.join(__dirname, '_support', 'getProductDoorsChild.cjs');
const GP_CASES = ['ucp_gp', 'ucp_gp_ctx_blank', 'ucp_gp_ctx_other', 'ucp_gp_ctx', 'mcp_gp', 'mcp_gp_market', 'public_gp', 'public_gp_market'];
const sha = (text) => require('node:crypto').createHash('sha256').update(text).digest('hex');

const COMBOS = {
  base: {},
  fwd: { UCP_GET_PRODUCT_FORWARD_MARKET: 'on' },
  shadow: { UCP_LIVE_PRODUCT_READ: 'shadow' },
  shadowfwd: { UCP_LIVE_PRODUCT_READ: 'shadow', UCP_GET_PRODUCT_FORWARD_MARKET: 'on' },
  enforce: { UCP_LIVE_PRODUCT_READ: 'enforce' },
  enforcefwd: { UCP_LIVE_PRODUCT_READ: 'enforce', UCP_GET_PRODUCT_FORWARD_MARKET: 'on' },
};

function runCombo(env, port) {
  const childEnv = { ...process.env };
  for (const k of ['UCP_LIVE_PRODUCT_READ', 'UCP_GET_PRODUCT_FORWARD_MARKET', 'PRICE_VERIFICATION_LOG']) delete childEnv[k];
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, String(port)], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err.slice(-2000)}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()).cases);
      } catch (e) {
        reject(new Error(`unreadable child output: ${e.message}; ${out.slice(-500)}`));
      }
    });
  });
}

const R = {};
test.before(async () => {
  const entries = Object.entries(COMBOS);
  const results = await Promise.all(entries.map(([, env], i) => runCombo(env, 4101 + i)));
  entries.forEach(([name], i) => { R[name] = results[i]; });
  // The stock the UCP and public doors now read off the detail lane's availability OBJECT (main published none)
  // is taken back out here, so every comparison below stays against main's bytes; the test after that pins it.
  for (const cases of Object.values(R)) {
    for (const c of Object.values(cases)) {
      const { rest, stock } = revertStock(c.body);
      c.stock = stock;
      if (rest !== c.body) { c.body = rest; c.sha256 = sha(rest); }
    }
  }
}, { timeout: 240000 });

// UCP: `availability` on each published variant; public: `availability` in place of main's "unknown".
function revertStock(body) {
  const o = JSON.parse(body);
  const r = o.result || {};
  const stock = {};
  if (r.structuredContent && typeof r.structuredContent.availability === 'string' && r.structuredContent.availability !== 'unknown') {
    stock.public = r.structuredContent.availability;
    r.structuredContent.availability = 'unknown';
  } else if (Array.isArray(r.content) && r.content[0] && !r.isError && /^\{/.test(r.content[0].text)) {
    const inner = JSON.parse(r.content[0].text);
    const variants = inner.ucp && inner.product && Array.isArray(inner.product.variants) ? inner.product.variants : [];
    if (variants.some((v) => 'availability' in v)) {
      stock.ucp = variants.map((v) => v.availability);
      for (const v of variants) delete v.availability;
      r.content[0].text = JSON.stringify(inner, null, 2);
    }
  }
  return Object.keys(stock).length ? { rest: JSON.stringify(o), stock } : { rest: body, stock };
}

const toolsOf = (c) => Object.fromEntries(JSON.parse(c.body).result.tools.map((t) => [t.name, t]));
const productOf = (c) => JSON.parse(JSON.parse(c.body).result.content[0].text).product;
const ucpMinor = (c) => productOf(c).price_range.min.amount;
const served = (c) => c.served.map((l) => ({ live: l.live, recent: l.recent, stored: l.stored, market: l.market, surface: l.surface }));

function assertSameAsMain(cases, combo, names) {
  for (const name of names) {
    assert.equal(cases[name].status, MAIN.combos[combo].cases[name].status, `${name}: status`);
    assert.equal(cases[name].sha256, MAIN.combos[combo].cases[name].sha256, `${name}: byte-identical to origin/main (${combo})`);
  }
}

test('the detail lane\'s stock reaches UCP and public get_product on every combination, and nothing else does', () => {
  const ucpCases = ['ucp_gp', 'ucp_gp_ctx_blank', 'ucp_gp_ctx_other', 'ucp_gp_ctx'];
  for (const [combo, cases] of Object.entries(R)) {
    for (const name of ucpCases) {
      assert.deepEqual(cases[name].stock, { ucp: [{ available: true, status: 'in_stock' }] }, `${combo}/${name}`);
    }
    // public get_product with a market is refused while `market` is undeclared (read off): nothing to carry stock.
    const publicCases = combo === 'base' || combo === 'fwd' ? ['public_gp'] : ['public_gp', 'public_gp_market'];
    for (const name of publicCases) assert.deepEqual(cases[name].stock, { public: 'in_stock' }, `${combo}/${name}`);
    for (const [name, c] of Object.entries(cases)) {
      if (!ucpCases.includes(name) && !publicCases.includes(name)) assert.deepEqual(c.stock, {}, `${combo}/${name}: unchanged`);
    }
  }
});

test('the door fixture serves the stock shape pdpBuilder emits: availability objects, no top-level in_stock', () => {
  const { buildPdpPayload } = require('../src/pdpBuilder.js');
  const built = buildPdpPayload({ product: {
    product_id: 'sig_shape', merchant_id: 'm', title: 'T', price: 25, currency: 'USD', in_stock: true, inventory_quantity: 4,
    variants: [{ variant_id: '1', title: 'Rose', price: 25, currency: 'USD', in_stock: true, inventory_quantity: 4 }],
  }, relatedProducts: [], entryPoint: 'agent' }).product;
  const shape = (p) => ({
    product: Object.keys(p.availability).sort(),
    variant: Object.keys(p.variants[0].availability).sort(),
    in_stock: 'in_stock' in p,
  });
  assert.deepEqual(shape(built), { product: ['available_quantity', 'in_stock'], variant: ['available_quantity', 'in_stock'], in_stock: false });
  const { storedProduct } = require('./_support/getProductDoorsProduct.cjs');
  assert.deepEqual(shape(storedProduct('sig_pr5_tint', 'store.price-log.test', '43734829564039')), shape(built));
});

test('both flags off: every get_product answer and every tools/list is byte-identical to origin/main', () => {
  assert.deepEqual(Object.keys(R.base).sort(), Object.keys(MAIN.combos.base.cases).sort());
  assertSameAsMain(R.base, 'base', Object.keys(MAIN.combos.base.cases));
  for (const name of GP_CASES) {
    assert.deepEqual(R.base[name].lookups, [], `${name}: the merchant is never asked`);
    assert.deepEqual(R.base[name].reads, [], `${name}: no reader runs`);
  }
});

test('UCP_GET_PRODUCT_FORWARD_MARKET alone: only the UCP get_product declaration changes', () => {
  const all = Object.keys(MAIN.combos.base.cases);
  assertSameAsMain(R.fwd, 'base', all.filter((n) => n !== 'ucp_tools'));
  const before = toolsOf(R.base.ucp_tools);
  const after = toolsOf(R.fwd.ucp_tools);
  assert.deepEqual(Object.keys(after), Object.keys(before), 'the same tools, in the same order');
  for (const name of Object.keys(before)) if (name !== 'get_product') assert.deepEqual(after[name], before[name], name);
  const was = before.get_product;
  const now = after.get_product;
  assert.deepEqual(now.annotations, was.annotations);
  assert.ok(now.description.startsWith(`${was.description} `), 'the description gains sentences, it loses none');
  const added = now.description.slice(was.description.length);
  assert.match(added, /catalog\.context\.address_country/);
  assert.match(added, /never inferred/);
  assert.match(added, /get_offers/, 'a stored price is discovery-only: get_offers before quoting');
  const ctx = now.inputSchema.properties.catalog.properties.context;
  assert.deepEqual(Object.keys(ctx.properties), ['address_country']);
  assert.equal(ctx.properties.address_country.type, 'string');
  assert.equal(ctx.additionalProperties, true, 'other context members stay accepted');
  // Everything but `context` is the published shape it was.
  const strip = (s) => ({ ...s, properties: { ...s.properties, catalog: { ...s.properties.catalog, properties: { ...s.properties.catalog.properties, context: null } } } });
  assert.deepEqual(strip(now.inputSchema), strip(was.inputSchema));
});

test('shadow: no get_product answer changes; /mcp and /public/mcp ask for the `market` they declare, nothing else changes', () => {
  assertSameAsMain(R.shadow, 'shadow', [...GP_CASES, 'ucp_tools']);
  for (const door of ['mcp_tools', 'public_tools']) {
    const base = toolsOf(R.base[door]).get_product;
    const shadowTool = toolsOf(R.shadow[door]).get_product;
    assert.ok('market' in shadowTool.inputSchema.properties, `${door}: market is declared under shadow (as on main)`);
    assert.ok(!('market' in base.inputSchema.properties), `${door}: and not when off`);
    assert.ok(shadowTool.description.startsWith(base.description), `${door}: sentences are appended`);
    const added = shadowTool.description.slice(base.description.length);
    assert.match(added, /Send `market`/);
    assert.match(added, /discovery only/);
    if (door === 'mcp_tools') assert.match(added, /call get_offers/);
    else assert.doesNotMatch(added, /get_offers/, 'the public tier has no get_offers to point at');
    // With the sentences taken out, the tool list is main's under shadow, byte for byte.
    const body = R.shadow[door].body;
    assert.equal(body.split(added).length, 2, `${door}: the added text occurs once`);
    assert.equal(sha(body.replace(added, '')), MAIN.combos.shadow.cases[door].sha256, `${door}: otherwise byte-identical to main`);
  }
});

test('shadow + forward: no answer changes, and the UCP door hands its declared market to the shadow read', () => {
  assertSameAsMain(R.shadowfwd, 'shadow', GP_CASES);
  assert.deepEqual(R.shadowfwd.ucp_gp_ctx.reads, [{ mode: 'shadow', market: 'US', status: 'verified', reason: null }]);
  assert.equal(R.shadowfwd.ucp_gp_ctx.lookups.length, 1, 'one lookup, for the UCP door');
  for (const name of ['ucp_gp', 'ucp_gp_ctx_blank', 'ucp_gp_ctx_other']) {
    assert.deepEqual(R.shadowfwd[name].reads, [{ mode: 'shadow', market: null, status: 'skipped', reason: 'no_market' }], `${name}: never a defaulted market`);
    assert.deepEqual(R.shadowfwd[name].lookups, [], name);
  }
  assert.deepEqual(R.shadow.ucp_gp_ctx.reads, [{ mode: 'shadow', market: null, status: 'skipped', reason: 'no_market' }], 'forward off: the context is not read');
});

// What enforce ADDS to an answer, taken back out: the UCP `price.*` message, the public `price_check`, and /mcp's
// `price_as_of`. Re-serialized the way the doors serialize (inner text JSON.stringify(_, null, 2), outer
// JSON.stringify), so "the rest is byte-identical to main" is checked against main's sha, and `added` is the label.
function stripEnforceLabels(body) {
  const o = JSON.parse(body);
  const added = {};
  const r = o.result || {};
  if (r.structuredContent && 'price_check' in r.structuredContent) {
    added.price_check = r.structuredContent.price_check;
    delete r.structuredContent.price_check;
  } else if (Array.isArray(r.content) && r.content[0] && !r.isError) {
    const inner = JSON.parse(r.content[0].text);
    if (Array.isArray(inner.messages)) {
      added.messages = inner.messages.filter((m) => /^price\./.test(m.code));
      const rest = inner.messages.filter((m) => !/^price\./.test(m.code));
      if (rest.length) inner.messages = rest;
      else delete inner.messages;
    }
    if (inner.ucp) {
      // The UCP shaper publishes no price_as_of: the message carries the read time instead.
      assert.equal(inner.product && 'price_as_of' in inner.product, false, 'UCP never carries price_as_of');
    } else if (inner.product && 'price_as_of' in inner.product) {
      added.price_as_of = inner.product.price_as_of;
      delete inner.product.price_as_of;
    }
    r.content[0].text = JSON.stringify(inner, null, 2);
  }
  return { rest: JSON.stringify(o), added };
}
const ucpPriceMessage = (c) => {
  const { added } = stripEnforceLabels(c.body);
  assert.equal((added.messages || []).length, 1, 'exactly one price message');
  return added.messages[0];
};

test('enforce, forward off: the UCP door reads nothing live, whatever context it is sent, and labels the stored price', () => {
  for (const name of GP_CASES) {
    const { rest } = stripEnforceLabels(R.enforce[name].body);
    assert.equal(sha(rest), MAIN.combos.enforce.cases[name].sha256, `${name}: main's enforce answer, once the label is taken out`);
  }
  for (const name of ['ucp_gp', 'ucp_gp_ctx_blank', 'ucp_gp_ctx_other', 'ucp_gp_ctx']) {
    assert.equal(ucpMinor(R.enforce[name]), 2500, `${name}: the stored price`);
    assert.deepEqual(R.enforce[name].lookups, [], name);
    assert.deepEqual(served(R.enforce[name]), [{ live: 0, recent: 0, stored: 1, market: null, surface: 'get_product' }], name);
    const m = ucpPriceMessage(R.enforce[name]);
    assert.deepEqual([m.type, m.code, m.path], ['warning', 'price.stored', '$.product.price_range'], name);
    assert.match(m.content, /not confirmed with the merchant \(no_market\)/);
  }
});

test('enforce: /mcp adds only price_as_of to a verified product; /public/mcp adds only price_check', () => {
  const { rest, added } = stripEnforceLabels(R.enforce.mcp_gp_market.body);
  assert.deepEqual(added, { price_as_of: '2026-10-22T12:00:00.000Z' });
  assert.equal(sha(rest), MAIN.combos.enforce.cases.mcp_gp_market.sha256, 'otherwise main\'s enforce answer');
  const p = productOf(R.enforce.mcp_gp_market);
  assert.equal(p.price, 23);
  assert.equal(p.live_read.status, 'verified');
  assert.equal(p.price_as_of, p.live_read.checked_at);
  assert.deepEqual(served(R.enforce.mcp_gp_market), [{ live: 1, recent: 0, stored: 0, market: 'US', surface: 'get_product' }]);
  const stored = productOf(R.enforce.mcp_gp);
  assert.equal(stored.price, 25, 'no market: the stored price, never blanked');
  assert.deepEqual(stored.live_read && [stored.live_read.status, stored.live_read.reason], ['skipped', 'no_market']);
  assert.equal(stored.price_as_of, undefined, 'an unread price is not dated');
  assert.deepEqual(stripEnforceLabels(R.enforce.mcp_gp.body).added, {}, '/mcp already carries live_read: nothing is added');
  assert.deepEqual(served(R.enforce.mcp_gp), [{ live: 0, recent: 0, stored: 1, market: null, surface: 'get_product' }]);
  assert.deepEqual(stripEnforceLabels(R.enforce.public_gp_market.body).added, { price_check: { confirmed_with_merchant: true, market: 'US' } });
  assert.deepEqual(stripEnforceLabels(R.enforce.public_gp.body).added, { price_check: { confirmed_with_merchant: false, reason: 'no_market' } }, 'an actionable reason is kept');
  assert.doesNotMatch(R.enforce.public_gp_market.body, /\d{4}-\d{2}-\d{2}T\d{2}:/, 'the public tier serves no timestamp');
});

test('enforce + forward: a declared UCP market is read live and says so; none, blank or other context members read nothing and say so', () => {
  const ctx = R.enforcefwd.ucp_gp_ctx;
  assert.equal(ucpMinor(ctx), 2300, 'the merchant\'s live price, in minor units');
  assert.deepEqual(ctx.reads, [{ mode: 'enforce', market: 'US', status: 'verified', reason: null }]);
  assert.equal(ctx.lookups.length, 1);
  assert.deepEqual(served(ctx), [{ live: 1, recent: 0, stored: 0, market: 'US', surface: 'get_product' }], 'counted live, for US');
  const m = ucpPriceMessage(ctx);
  assert.deepEqual([m.type, m.code], ['info', 'price.merchant_verified']);
  assert.match(m.content, /for US at 2026-10-22T12:00:00\.000Z/);
  // Without the label, the answer differs from main's only in the amounts.
  assert.equal(
    sha(stripEnforceLabels(ctx.body).rest.replace(/\\"amount\\": 2300/g, '\\"amount\\": 2500')),
    MAIN.combos.enforce.cases.ucp_gp_ctx.sha256,
    'only the amounts moved',
  );
  for (const name of ['ucp_gp', 'ucp_gp_ctx_blank', 'ucp_gp_ctx_other']) {
    assert.equal(R.enforcefwd[name].sha256, R.enforce[name].sha256, `${name}: as under enforce alone (stored, labelled)`);
    assert.equal(ucpMinor(R.enforcefwd[name]), 2500, `${name}: stored`);
    assert.deepEqual(R.enforcefwd[name].reads, [{ mode: 'enforce', market: null, status: 'skipped', reason: 'no_market' }], name);
    assert.deepEqual(served(R.enforcefwd[name]), [{ live: 0, recent: 0, stored: 1, market: null, surface: 'get_product' }], name);
  }
  for (const name of ['mcp_gp', 'mcp_gp_market', 'public_gp', 'public_gp_market']) {
    assert.equal(R.enforcefwd[name].sha256, R.enforce[name].sha256, name);
  }
  assert.equal(JSON.parse(R.enforcefwd.public_gp_market.body).result.structuredContent.price.amount, 23, 'public: live with a market');
  assert.equal(JSON.parse(R.enforcefwd.public_gp.body).result.structuredContent.price.amount, 25, 'public: stored without');
});

test('PRICE_VERIFICATION_LOG stays log-only on every get_product door and combination', () => {
  for (const [combo, cases] of Object.entries(R)) {
    for (const name of GP_CASES) assert.equal(cases[name].on_identical, true, `${combo}/${name}`);
  }
});
