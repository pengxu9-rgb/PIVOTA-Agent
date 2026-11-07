// Unit tests for src/services/seedDataEgressProjection.js: the allowlist every `seed_data` value is
// reduced to on its way out of the invoke route (src/invokeEgress.js projectInvokeResponse).
// The route-level tests live in tests/integration/invoke.seed_data_egress_projection.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  projectSeedData,
  projectSeedDataDeep,
  SEED_VARIANT_FIELDS,
  MAX_WALK_DEPTH,
} = require('../src/services/seedDataEgressProjection');
const { projectInvokeResponse } = require('../src/invokeEgress');
const { buildExternalSeedProduct } = require('../src/services/externalSeedProducts');
const { resolveVariantFromSeed } = require('../src/services/shopifyVariantResolver');
const { deriveWarmHandoffVariantGid } = require('../src/services/checkoutHandoffResolver');

function rawSeedData() {
  return {
    brand: 'Brand',
    category: 'moisturizer',
    description: 'A light cream.',
    image_url: 'https://cdn.example.com/a.jpg',
    images: [{ url: 'https://cdn.example.com/a.jpg' }],
    image_urls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
    price_read: { source: 'refresh_job', outcome: 'stale_kept' },
    variant_refresh: { attempts: 2 },
    review_summary: { rating: 4.1, count: 9 },
    authority_source: { source_role: 'primary', source_url: 'https://internal.example.com/x' },
    derived: {
      recall: { retrieval_summary: 'Light cream.', alias_tokens: 'cream', quality_signals: { score: 0.5 } },
      other: { x: 1 },
    },
    variants: [
      { variant_id: '44100000111', price: '10.00', option_name: 'Size', option_value: '50 ml', stock: 'in stock', cost: '2' },
    ],
    snapshot: {
      title: 'Cream',
      description: 'A light cream.',
      image_url: 'https://cdn.example.com/a.jpg',
      image_urls: ['https://cdn.example.com/a.jpg'],
      price_read: { source: 'crawl' },
      destination_url: 'https://shop.example.com/p/cream',
      variants: [
        {
          variant_id: '44100000111',
          option_name: 'Size',
          option_value: '50 ml',
          availability: 'in stock',
          price: '10.00',
          pricing: { a: 1 },
        },
        {
          variant_id: '44100000222',
          option_name: 'Size',
          option_value: '100 ml',
          availability: 'out of stock',
          inventory_quantity: 0,
        },
      ],
    },
  };
}

test('keeps exactly the allowlisted fields', () => {
  assert.deepEqual(projectSeedData(rawSeedData()), {
    image_url: 'https://cdn.example.com/a.jpg',
    images: [{ url: 'https://cdn.example.com/a.jpg' }],
    image_urls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
    variants: [{ variant_id: '44100000111', option_name: 'Size', stock: 'in stock' }],
    snapshot: {
      image_url: 'https://cdn.example.com/a.jpg',
      image_urls: ['https://cdn.example.com/a.jpg'],
      description: 'A light cream.',
      variants: [
        { variant_id: '44100000111', option_name: 'Size', availability: 'in stock' },
        { variant_id: '44100000222', option_name: 'Size', availability: 'out of stock' },
      ],
    },
    derived: { recall: { retrieval_summary: 'Light cream.' } },
  });
});

test('a seed_data with nothing allowlisted, or that is not an object, projects to nothing', () => {
  assert.equal(projectSeedData({ price_read: { a: 1 }, derived: { recall: { alias_tokens: 'x' } } }), undefined);
  assert.equal(projectSeedData({}), undefined);
  assert.equal(projectSeedData('{"price_read":{}}'), undefined);
  assert.equal(projectSeedData(['x']), undefined);
  assert.equal(projectSeedData(null), undefined);
  // Empty values are not "present": a blank image field does not keep the key alive.
  assert.equal(projectSeedData({ image_url: '  ', image_urls: [], snapshot: { variants: [{ price: '1' }] } }), undefined);
});

test('the deep walk rewrites seed_data at every depth and drops it when nothing is left', () => {
  const body = {
    products: [{ id: 'p1', seed_data: rawSeedData() }, { id: 'p2', seed_data: { price_read: {} } }],
    data: { products: [{ id: 'p3', seed_data: rawSeedData() }] },
    product: { id: 'p4', group_members: [{ id: 'm1', seed_data: rawSeedData() }] },
    metadata: { debug: { top: [{ raw: { seed_data: { review_summary: {} } } }] } },
  };
  const out = projectSeedDataDeep(body);
  assert.deepEqual(out.products[0].seed_data, projectSeedData(rawSeedData()));
  assert.equal('seed_data' in out.products[1], false, 'nothing allowlisted -> key dropped, not {}');
  assert.deepEqual(out.data.products[0].seed_data, projectSeedData(rawSeedData()));
  assert.deepEqual(out.product.group_members[0].seed_data, projectSeedData(rawSeedData()));
  assert.equal('seed_data' in out.metadata.debug.top[0].raw, false);
  assert.ok(!JSON.stringify(out).includes('price_read'));
  assert.ok(!JSON.stringify(out).includes('review_summary'));
});

test('copy-on-write: the input is never mutated, untouched subtrees keep their identity', () => {
  const shared = { id: 'cached', title: 'no seed here' };
  const body = { products: [shared, { id: 'p1', seed_data: rawSeedData() }], metadata: { a: 1 } };
  const before = JSON.stringify(body);
  const out = projectSeedDataDeep(body);
  assert.equal(JSON.stringify(body), before, 'input must not be mutated');
  assert.notEqual(out, body);
  assert.equal(out.products[0], shared, 'a product without seed_data is the same reference');
  assert.equal(out.metadata, body.metadata, 'a subtree without seed_data is the same reference');
});

test('a body with no seed_data anywhere comes back as the same object', () => {
  const body = { products: [{ id: 'p1', images: ['x'] }], metadata: { nested: [{ a: [1, 2, { b: 3 }] }] } };
  assert.equal(projectSeedDataDeep(body), body);
  for (const value of [null, undefined, 0, 'x', true, [], {}, [1, 2]]) {
    assert.equal(projectSeedDataDeep(value), value);
  }
});

test('non-plain objects are passed through, and the walk is bounded', () => {
  const date = new Date(0);
  assert.equal(projectSeedDataDeep(date), date);
  let deep = { seed_data: { price_read: {} } };
  for (let i = 0; i < MAX_WALK_DEPTH + 5; i += 1) deep = { child: deep };
  assert.doesNotThrow(() => projectSeedDataDeep(deep));
});

test('the invoke egress projector applies it (the door, not just the helper)', () => {
  const body = { products: [{ id: 'p1', seed_data: rawSeedData() }] };
  const out = projectInvokeResponse(body, { operation: 'get_discovery_feed' });
  assert.deepEqual(out.products[0].seed_data, projectSeedData(rawSeedData()));
});

// The real producer: what buildExternalSeedProduct attaches is what partners received.
function realProduct() {
  return buildExternalSeedProduct({
    id: 'seed-row-9',
    external_product_id: 'ext_unit_9',
    market: 'US',
    destination_url: 'https://shop.example.com/products/cream',
    canonical_url: 'https://shop.example.com/products/cream',
    domain: 'shop.example.com',
    title: 'Cream',
    image_url: 'https://cdn.example.com/a.jpg',
    price_amount: '10.00',
    price_currency: 'USD',
    availability: 'in stock',
    status: 'active',
    seed_data: rawSeedData(),
  });
}

test('on the real producer output, every kept variant key is allowlisted and no price survives', () => {
  const product = realProduct();
  assert.ok(product.seed_data.price_read, 'precondition: the producer attaches internal keys');
  const projected = projectSeedData(product.seed_data);
  for (const variant of [...(projected.variants || []), ...(projected.snapshot?.variants || [])]) {
    assert.deepEqual(Object.keys(variant).filter((key) => !SEED_VARIANT_FIELDS.includes(key)), []);
  }
  assert.ok(!JSON.stringify(projected).includes('price'), JSON.stringify(projected));
});

test('agent-ui fallbacks still resolve after projection, and the product keeps its own seed evidence', () => {
  const product = projectSeedDataDeep({ products: [realProduct()] }).products[0];
  // src/lib/api.ts firstFromSeedData + mapToPdpPayload image candidates.
  assert.ok(product.seed_data.image_urls.length > 0 || product.seed_data.snapshot.image_urls.length > 0);
  // src/lib/productCardPresentation.ts text + variant badge fallbacks.
  assert.equal(product.seed_data.derived.recall.retrieval_summary, 'Light cream.');
  assert.equal(product.seed_data.snapshot.description, 'A light cream.');
  assert.equal(product.seed_data.snapshot.variants[0].option_name, 'Size');
  // src/lib/api.ts hasExternalSeedPdpSourceEvidence: seed_data is not the only evidence on a built product.
  assert.ok(product.external_seed_id);
  assert.ok(product.external_seed_recall);
});

test('the warm-handoff variant fallback resolves the same GID from projected seed_data', () => {
  const raw = realProduct().seed_data;
  const projected = projectSeedData(raw);
  const before = resolveVariantFromSeed(raw, { preferAvailable: true });
  const after = resolveVariantFromSeed(projected, { preferAvailable: true });
  assert.ok(before && before.variantGid, 'precondition: the raw blob resolves a variant');
  assert.equal(after.variantGid, before.variantGid);
  assert.equal(after.availability, before.availability);
  // And through the resolver's own entry point, with a product echoed back as the descriptor.
  assert.equal(
    deriveWarmHandoffVariantGid({ seed_data: projected }),
    deriveWarmHandoffVariantGid({ seed_data: raw }),
  );
});
