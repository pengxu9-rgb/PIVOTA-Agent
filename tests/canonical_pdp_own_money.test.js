const {
  usesCanonicalOwnMoney, readCanonicalOwnMoney, projectCanonicalProductMoney,
  projectCanonicalOffersMoney, storedNumericVariant, currentOwnMoneyReasonCode,
  withholdCanonicalProductMoney, withholdCanonicalPdpPayloadMoney, withholdCanonicalOffersMoney,
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


test('a gap or failed read is a reason code, never a price', async () => {
  const gap = await load([]).catch(error => error);
  expect(currentOwnMoneyReasonCode(gap)).toBe('CURRENT_OWN_OFFER_UNAVAILABLE');
  expect(currentOwnMoneyReasonCode(Object.assign(Error('budget'), { code: 'STAGE_TIMEOUT' }))).toBe('CURRENT_OWN_OFFER_READ_FAILED');
  expect(currentOwnMoneyReasonCode(Error('owned read outage'))).toBe('CURRENT_OWN_OFFER_READ_FAILED');
});

test('withheld product renders with no seed money and every variant not purchasable', () => {
  const product = withholdCanonicalProductMoney({ product_id: 'ext_owned', title: 'Owned', price: 45, price_amount: 45,
    current_price: 45, currency: 'USD', in_stock: true, default_variant_id: '222',
    variants: [variant(), variant('222', { price_amount: 45 })] });
  expect(product).toMatchObject({ current_own_offer_status: 'unavailable', in_stock: false, currency: 'USD', title: 'Owned' });
  for (const field of ['price', 'price_amount', 'current_price']) expect(product).not.toHaveProperty(field);
  const payload = buildPdpPayload({ product });
  expect(payload.product.title).toBe('Owned');
  expect(payload.product).not.toHaveProperty('price');
  expect(payload.product.availability.in_stock).toBe(false);
  expect(payload.product.default_variant_id).toBe('222');
  for (const built of payload.product.variants) {
    expect(built).toMatchObject({ current_own_offer_status: 'unavailable', availability: { in_stock: false } });
    expect(built).not.toHaveProperty('price');
  }
  expect(payload.modules.some(m => m.type === 'price_promo')).toBe(false);
  expect(JSON.stringify(payload)).not.toMatch(/"(amount|price|price_amount)":45[,}]/);
});

test('withheld product-grain listing keeps its implicit variant identity without a price', () => {
  const payload = buildPdpPayload({ product: withholdCanonicalProductMoney({ product_id: 'ext_owned', title: 'Owned', price: 45 }) });
  expect(payload.product.purchase_grain).toBe('product');
  expect(payload.product.variants[0]).toMatchObject({ variant_id: 'ext_owned', current_own_offer_status: 'unavailable',
    availability: { in_stock: false } });
  expect(payload.product.variants[0]).not.toHaveProperty('price');
  expect(payload.product).not.toHaveProperty('price');
  expect(payload.modules.some(m => m.type === 'price_promo')).toBe(false);
});

test('withheld offers: only the exact selected listing loses money; it never wins best price; siblings are unchanged', () => {
  const selected = { offer_id: 'selected', merchant_id: ref.merchant_id, product_id: ref.product_id,
    selected_variant_id: '111', price: { amount: 45, currency: 'USD' }, inventory: { in_stock: true },
    purchase_route: 'affiliate_outbound', variants: [{ variant_id: '111', price: { current: { amount: 45, currency: 'USD' } },
      availability: { in_stock: true } }] };
  const sameMerchantOtherListing = { offer_id: 'other-listing', merchant_id: ref.merchant_id, product_id: 'ext_other',
    price: { amount: 52, currency: 'USD' } };
  const sibling = { offer_id: 'sibling', merchant_id: 'another', product_id: 'another', price: { amount: 47, currency: 'USD' } };
  const result = withholdCanonicalOffersMoney({ offers: [selected, sameMerchantOtherListing, sibling],
    default_offer_id: 'selected', best_price_offer_id: 'selected' }, ref);
  const own = result.offers.find(o => o.offer_id === 'selected');
  expect(own).toMatchObject({ current_own_offer_status: 'unavailable', inventory: { in_stock: false },
    purchase_route: 'affiliate_outbound', variants: [{ variant_id: '111', current_own_offer_status: 'unavailable',
      availability: { in_stock: false } }] });
  expect(own).not.toHaveProperty('price');
  expect(own.variants[0]).not.toHaveProperty('price');
  expect(result.offers.find(o => o.offer_id === 'sibling')).toBe(sibling);
  expect(result.offers.find(o => o.offer_id === 'other-listing')).toBe(sameMerchantOtherListing);
  expect(result.best_price_offer_id).toBe('sibling');
  expect(result.offers.at(-1).offer_id).toBe('selected');
  const alone = withholdCanonicalOffersMoney({ offers: [selected], default_offer_id: 'selected', best_price_offer_id: 'selected' }, ref);
  expect(alone.best_price_offer_id).toBeNull();
});

test('withheld built payload drops the projected card money, its price module and selector prices', async () => {
  const projected = projectCanonicalProductMoney({ product_id: 'ext_owned', title: 'Owned', price: 45, default_variant_id: '111',
    variants: [variant(), variant('222')] }, await load());
  const built = buildPdpPayload({ product: projected });
  expect(built.modules.some(m => m.type === 'price_promo')).toBe(true);
  const payload = withholdCanonicalPdpPayloadMoney(built);
  expect(payload.product.title).toBe('Owned');
  expect(payload.product).not.toHaveProperty('price');
  expect(payload.product.availability.in_stock).toBe(false);
  expect(payload.modules.some(m => m.type === 'price_promo')).toBe(false);
  const selector = payload.modules.find(m => m.type === 'variant_selector').data.variants;
  expect(selector.map(v => v.variant_id)).toEqual(['111', '222']);
  for (const v of [...payload.product.variants, ...selector]) {
    expect(v).toMatchObject({ current_own_offer_status: 'unavailable', availability: { in_stock: false } });
    expect(v).not.toHaveProperty('price');
  }
  expect(JSON.stringify(payload)).not.toMatch(/"amount":(45|49)[,}]/);
});
