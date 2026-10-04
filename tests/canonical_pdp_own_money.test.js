const {
  usesCanonicalOwnMoney, readCanonicalOwnMoney, projectCanonicalProductMoney,
  projectCanonicalOffersMoney, storedNumericVariant,
} = require('../src/services/canonicalPdpOwnMoney');
const { buildPdpPayload } = require('../src/pdpBuilder');

const ref = { product_key: 'prod::external_seed::ext_owned', product_id: 'ext_owned',
  merchant_id: 'merch_obs_owned', platform: 'external_seed', source_system: 'catalog_enrichment_agent_v1' };
const variant = (id = '111', extra = {}) => ({ variant_id: id, title: '50 mL',
  options: [{ name: 'Size', value: '50 mL' }], price: 45, currency: 'USD',
  in_stock: true, source_quality_status: 'captured', ...extra });
const rows = (identity = '111') => [{ sku_key: 'owned-stored-sku', source_variant_id: identity,
  amount: '49.00', currency: 'USD' }];
const load = (data = rows()) => readCanonicalOwnMoney({ ref, query: async () => ({ rows: data }) });

test('only exact enrichment canonical US/USD source selects this money reader', () => {
  expect(usesCanonicalOwnMoney(ref, 'US', 'USD')).toBe(true);
  for (const other of [{ ...ref, source_system: 'external_product_seeds_mirror_v1' },
    { ...ref, platform: 'shopify' }, { ...ref, product_key: null }]) {
    expect(usesCanonicalOwnMoney(other, 'US', 'USD')).toBe(false);
  }
  expect(usesCanonicalOwnMoney(ref, 'GB', 'GBP')).toBe(false);
});

test.each(['111', 'gid://shopify/ProductVariant/111', 'ext_owned:111'])('stored %s maps only its own identity', async id => {
  const money = await load(rows(id));
  const product = projectCanonicalProductMoney({ product_id: 'ext_owned', price: 45, variants: [variant()] }, money);
  expect(product.price).toEqual({ amount: 49, currency: 'USD' });
  expect(product.variants[0]).toMatchObject({ variant_id: '111', source_quality_status: 'captured', in_stock: true });
});

test('a different external namespace never gains a numeric alias', async () => {
  expect(storedNumericVariant('ext_foreign:111', ref.product_key)).toBeNull();
  const money = await load(rows('ext_foreign:111'));
  expect(() => projectCanonicalProductMoney({ variants: [variant()] }, money)).toThrow('unavailable');
});

test.each([
  { variant_attributes: { variant_id: '111' }, title: '50 mL', options: [{ name: 'Size', value: '50 mL' }] },
  { sku: '111', title: '50 mL', options: [{ name: 'Size', value: '50 mL' }] },
  { sku_id: '111', title: '50 mL', options: [{ name: 'Size', value: '50 mL' }] },
])('native builder attribute/SKU identity keeps selected variant eligible', async raw => {
  const product = projectCanonicalProductMoney({ product_id: 'ext_owned', price: 45,
    variants: [{ ...raw, price: 45, currency: 'USD', in_stock: true, source_quality_status: 'captured' }] }, await load());
  const payload = buildPdpPayload({ product });
  expect(payload.product.variants[0]).toMatchObject({ variant_id: '111', price: { current: { amount: 49, currency: 'USD' } } });
  expect(payload.modules.find(m => m.type === 'variant_selector').data.variants[0].variant_id).toBe('111');
});

test.each([{ in_stock: false }, { hidden_from_selector: true, source_quality_status: 'blocked' }])(
  'unpriced unselected sibling preserves identity and visibility but never stale money', async extra => {
    const product = projectCanonicalProductMoney({ product_id: 'ext_owned', price: 45, default_variant_id: '111',
      variants: [variant(), variant('222', extra)] }, await load());
    expect(product.variants[1]).toMatchObject({ variant_id: '222', current_own_offer_status: 'unavailable', ...extra });
    expect(product.variants[1]).not.toHaveProperty('price');
    const payload = buildPdpPayload({ product });
    expect(payload.product.variants[0].price.current.amount).toBe(49);
    expect(payload.product.variants[1]).not.toHaveProperty('price');
    expect(payload.product.variants[1].availability.in_stock).toBe(false);
    const visible = payload.modules.find(m => m.type === 'variant_selector')?.data?.variants || [];
    expect(visible.some(v => v.variant_id === '222')).toBe(extra.hidden_from_selector !== true);
  });

test('missing selected money refuses; valid sibling is never automatically selected', async () => {
  expect(() => projectCanonicalProductMoney({ default_variant_id: '222', variants: [variant(), variant('222')] },
    new Map([['111', { amount: 49, currency: 'USD' }]]))).toThrow('unavailable');
});

test('genuine product-grain canonical placeholder gets current price without inventing a numeric variant', async () => {
  const money = await load([{ source_variant_id: ref.product_key, sku_key: `${ref.product_key}::canonical`, amount: 49, currency: 'USD' }]);
  const product = projectCanonicalProductMoney({ product_id: 'ext_owned', title: 'Default product', price: 45 }, money);
  expect(product.price.amount).toBe(49);
  expect(product.variants).toBeUndefined();
});

test('selected offer changes current money and best-price marker while preserving native referral semantics', async () => {
  const source = { offer_id: 'selected', merchant_id: ref.merchant_id, product_id: ref.product_id,
    selected_variant_id: '111', price: { amount: 45, currency: 'USD' }, purchase_route: 'affiliate_outbound',
    commerce_mode: 'links_out', checkout_handoff: 'redirect', variants: [variant()] };
  const sibling = { offer_id: 'sibling', merchant_id: 'another', product_id: 'another', price: { amount: 47, currency: 'USD' } };
  const result = projectCanonicalOffersMoney({ offers: [source, sibling], default_offer_id: 'selected',
    best_price_offer_id: 'selected' }, ref, await load());
  expect(result.best_price_offer_id).toBe('sibling');
  expect(result.default_offer_id).toBe('selected');
  expect(result.offers.find(o => o.offer_id === 'selected')).toMatchObject({
    price: { amount: 49, currency: 'USD' }, purchase_route: 'affiliate_outbound', commerce_mode: 'links_out', checkout_handoff: 'redirect' });
});

test('conflicting eligible same-variant prices and read failures are never stale seed fallback', async () => {
  await expect(load([...rows(), { ...rows()[0], amount: 59 }])).rejects.toThrow('Conflicting');
  await expect(readCanonicalOwnMoney({ ref, query: async () => { throw Error('owned read outage'); } })).rejects.toThrow('owned read outage');
});


test('canonical placeholder funds only the genuine implicit product variant, never a hydrated numeric variant', async () => {
  const money = await load([{ source_variant_id: ref.product_key, sku_key: `${ref.product_key}::canonical`, amount: 49, currency: 'USD' }]);
  const implicit = { merchant_id: ref.merchant_id, product_id: ref.product_id, variant_id: ref.product_id,
    variants: [{ variant_id: ref.product_id }] };
  expect(projectCanonicalOffersMoney({ offers: [implicit] }, ref, money, { productGrain: true }).offers[0].price.amount).toBe(49);
  for (const changed of [{ ...implicit, variant_id: '999' }, { ...implicit, variants: [{ variant_id: '999' }] }]) {
    expect(() => projectCanonicalOffersMoney({ offers: [changed] }, ref, money, { productGrain: true })).toThrow('unavailable');
  }
});

test('native multi-variant offer lacking a selected ID uses the already selected canonical identity only', async () => {
  const data = { offers: [{ merchant_id: ref.merchant_id, product_id: ref.product_id,
    variants: [{ variant_id: '111' }, { variant_id: '222', availability: { in_stock: false } }] }] };
  const result = projectCanonicalOffersMoney(data, ref, await load(), { selectedVariantId: '111' });
  expect(result.offers[0].price.amount).toBe(49);
  expect(result.offers[0].variants[1]).toMatchObject({ variant_id: '222', current_own_offer_status: 'unavailable' });
  expect(result.offers[0].variants[1]).not.toHaveProperty('price');
  expect(() => projectCanonicalOffersMoney(data, ref, new Map(), { selectedVariantId: '111' })).toThrow('unavailable');
});


test('native implicit default accepts only the resolved public signature or source product alias', async () => {
  const money = await load([{ source_variant_id: ref.product_key, sku_key: `${ref.product_key}::canonical`, amount: 49, currency: 'USD' }]);
  const sig = 'sig_0123456789abcdef';
  const offer = { merchant_id: ref.merchant_id, product_id: ref.product_id, variants: [{ variant_id: ref.product_id }] };
  expect(projectCanonicalOffersMoney({ offers: [offer] }, ref, money,
    { productGrain: true, selectedVariantId: sig, publicSignatureId: sig }).offers[0].price.amount).toBe(49);
  expect(() => projectCanonicalOffersMoney({ offers: [offer] }, ref, money,
    { productGrain: true, selectedVariantId: '999', publicSignatureId: sig })).toThrow('unavailable');
});


test('native external-seed default variant remains product-grain without inventing numeric SKU authority', async () => {
  const money = await load([{ source_variant_id: ref.product_key, sku_key: `${ref.product_key}::canonical`, amount: 49, currency: 'USD' }]);
  const product = { product_id: 'sig_public', variants: [{ id: ref.product_id, variant_id: ref.product_id, title: 'Default', options: [], price: 45 }] };
  expect(projectCanonicalProductMoney(product, money, { ref }).variants[0].price.amount).toBe(49);
  expect(() => projectCanonicalProductMoney({ ...product, variants: [{ ...product.variants[0], variant_id: '999' }] }, money, { ref })).toThrow('unavailable');
});
