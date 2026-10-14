// Own-offer money freshness (pivota-backend #2601 follow-up b). `catalog_offers.price_checked_at` dates the
// last READ of a price (migration 246; NULL = none on record). CANONICAL_OWN_MONEY_FRESHNESS: `off` serves
// as before and never reads the column, `shadow` serves as before and logs what `enforce` would have served,
// `enforce` leaves out every row whose read is older than CANONICAL_OWN_MONEY_MAX_AGE_DAYS (default 14,
// clamped to 1..365) or was never made.
const logger = require('../src/logger');
const {
  readCanonicalOwnMoney, readCanonicalSellerOffersMoney, currentMoneyFromOwnRows, currentOwnMoneyReasonCode,
  ownMoneyFreshnessMode, ownMoneyMaxAgeDays, projectCanonicalProductMoney, projectSellerOffersMoney,
  resetOwnMoneyPriceCheckStateForTests,
} = require('../src/services/canonicalPdpOwnMoney');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-14T12:00:00Z');
const ago = days => new Date(NOW - days * DAY);
const ref = { product_key: 'ext:owned::abc', product_id: 'ext_owned', merchant_id: 'merch_obs_owned' };
const row = (id, checked, amount = '49.00') => ({ offer_id: `o_${id}_${amount}`, sku_key: `s_${id}`, source_variant_id: id,
  currency: 'USD', amount, price_checked_at: checked });
const at = (mode, rows, extra = {}) => currentMoneyFromOwnRows(rows, ref.product_key, { mode, maxAgeDays: 14, now: NOW, ...extra });
const twoSizes = (defaultId = '111') => ({ product_id: ref.product_id, default_variant_id: defaultId, variants: [
  { variant_id: '111', title: 'A', options: [{ name: 'Size', value: 'A' }], price: 45 },
  { variant_id: '222', title: 'B', options: [{ name: 'Size', value: 'B' }], price: 55 },
] });
const shadowEvents = () => info.mock.calls.map(call => call[0]).filter(e => e.event === 'pdp_own_money_freshness_shadow');

let info;
let warn;
beforeEach(() => {
  info = jest.spyOn(logger, 'info').mockImplementation(() => {});
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  resetOwnMoneyPriceCheckStateForTests();
});
afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
  delete process.env.CANONICAL_OWN_MONEY_FRESHNESS;
  delete process.env.CANONICAL_OWN_MONEY_MAX_AGE_DAYS;
});

describe('configuration', () => {
  test('mode defaults to off; only off, shadow and enforce are modes', () => {
    expect(ownMoneyFreshnessMode({})).toBe('off');
    expect(ownMoneyFreshnessMode({ CANONICAL_OWN_MONEY_FRESHNESS: ' Enforce ' })).toBe('enforce');
    expect(ownMoneyFreshnessMode({ CANONICAL_OWN_MONEY_FRESHNESS: 'shadow' })).toBe('shadow');
    expect(ownMoneyFreshnessMode({ CANONICAL_OWN_MONEY_FRESHNESS: 'enforced' })).toBe('off');
  });
  test('window defaults to 14 days and is clamped to 1..365', () => {
    expect(ownMoneyMaxAgeDays({})).toBe(14);
    expect(ownMoneyMaxAgeDays({ CANONICAL_OWN_MONEY_MAX_AGE_DAYS: '30' })).toBe(30);
    for (const bad of ['abc', 'Infinity', 'NaN']) expect(ownMoneyMaxAgeDays({ CANONICAL_OWN_MONEY_MAX_AGE_DAYS: bad })).toBe(14);
    for (const low of ['0', '-3', '1e-9']) expect(ownMoneyMaxAgeDays({ CANONICAL_OWN_MONEY_MAX_AGE_DAYS: low })).toBe(1);
    expect(ownMoneyMaxAgeDays({ CANONICAL_OWN_MONEY_MAX_AGE_DAYS: '1e9' })).toBe(365);
  });
});

describe('enforce', () => {
  test('a read inside the window is money', () => {
    expect(at('enforce', [row('111', ago(13.9))]).get('111').amount).toBe(49);
  });
  test('a stamp a few minutes ahead of the gateway clock is skew, not a future read', () => {
    expect(at('enforce', [row('111', new Date(NOW + 5 * 60 * 1000))]).get('111').amount).toBe(49);
  });
  test.each([
    ['never read (NULL)', null],
    ['read past the window', ago(14.1)],
    ['stamped beyond the clock tolerance', new Date(NOW + 11 * 60 * 1000)],
    ['unparseable stamp', 'not-a-date'],
  ])('%s: the listing is CURRENT_OWN_OFFER_UNAVAILABLE', (_label, checked) => {
    let error;
    try { at('enforce', [row('111', checked)]); } catch (e) { error = e; }
    expect(currentOwnMoneyReasonCode(error)).toBe('CURRENT_OWN_OFFER_UNAVAILABLE');
  });
  test('a stale non-default variant alone loses its money; the default keeps its price', () => {
    const money = at('enforce', [row('111', ago(1)), row('222', null, '59.00')]);
    expect([...money.keys()]).toEqual(['111']);
    const product = projectCanonicalProductMoney(twoSizes('111'), money);
    expect(product.price).toEqual({ amount: 49, currency: 'USD' });
    expect(product.variants[1]).toMatchObject({ current_own_offer_status: 'unavailable' });
    expect(product.variants[1]).not.toHaveProperty('price');
  });
  test('a stale DEFAULT variant makes the whole listing unavailable, never another variant\'s price', () => {
    const money = at('enforce', [row('111', null), row('222', ago(1), '59.00')]);
    let error;
    try { projectCanonicalProductMoney(twoSizes('111'), money); } catch (e) { error = e; }
    expect(currentOwnMoneyReasonCode(error)).toBe('CURRENT_OWN_OFFER_UNAVAILABLE');
  });
  test('a stale row still refuses a conflicting price, exactly as off does', () => {
    const rows = [row('111', ago(1), '49.00'), row('111', null, '59.00')];
    expect(() => at('off', rows)).toThrow('Conflicting');
    expect(() => at('enforce', rows)).toThrow('Conflicting');
  });
  test('a wider window admits an older read', () => {
    expect(at('enforce', [row('111', ago(20))], { maxAgeDays: 30 }).get('111').amount).toBe(49);
  });
  test('ISO strings are dated like Date values', () => {
    expect(at('enforce', [row('111', ago(2).toISOString())]).get('111').amount).toBe(49);
  });
});

describe('off and shadow serve exactly what was served before', () => {
  test('off ignores the stamp entirely and logs nothing', () => {
    const product = projectCanonicalProductMoney(twoSizes(), at('off', [row('111', null), row('222', null, '59.00')]));
    expect(product.price.amount).toBe(49);
    expect(info).not.toHaveBeenCalled();
  });
  test('shadow serves a never-read listing and logs that enforce would make it unavailable', () => {
    const product = projectCanonicalProductMoney(twoSizes(), at('shadow', [row('111', null), row('222', null, '59.00')]), { ref });
    expect(product.price.amount).toBe(49);
    expect(product.variants[1].price).toEqual({ amount: 59, currency: 'USD' });
    expect(shadowEvents()).toEqual([expect.objectContaining({ scope: 'selected_listing', would: 'unavailable',
      product_key: ref.product_key, merchant_id: ref.merchant_id, stale_rows: 2, rows: 2, max_age_days: 14 })]);
  });
  test('shadow logs a stale DEFAULT variant as unavailable, the true enforce outcome', () => {
    projectCanonicalProductMoney(twoSizes('111'), at('shadow', [row('111', null), row('222', ago(1), '59.00')]), { ref });
    expect(shadowEvents()).toEqual([expect.objectContaining({ would: 'unavailable', stale_rows: 1 })]);
  });
  test('shadow logs variants_unpriced, counting variants once, when only a non-default variant is stale', () => {
    const rows = [row('111', ago(1)), row('gid://shopify/ProductVariant/222', ago(40), '59.00')];
    const product = projectCanonicalProductMoney(twoSizes('111'), at('shadow', rows), { ref });
    expect(product.variants[1].price).toEqual({ amount: 59, currency: 'USD' });
    expect(shadowEvents()).toEqual([expect.objectContaining({ would: 'variants_unpriced', unpriced_variants: 1, stale_rows: 1 })]);
  });
  test('shadow logs nothing when every row is fresh', () => {
    projectCanonicalProductMoney(twoSizes(), at('shadow', [row('111', ago(1)), row('222', ago(2), '59.00')]), { ref });
    expect(shadowEvents()).toEqual([]);
  });
  test('shadow still refuses what off refuses (conflicting prices)', () => {
    expect(() => at('shadow', [row('111', ago(1), '49.00'), row('111', ago(1), '59.00')])).toThrow('Conflicting');
  });
});

describe('the reads', () => {
  const ownRowsQuery = (rows, { missingColumn = false } = {}) => {
    const calls = [];
    const query = async sql => {
      calls.push(sql);
      if (missingColumn && sql.includes('price_checked_at')) {
        throw Object.assign(new Error('column co.price_checked_at does not exist'), { code: '42703' });
      }
      return { rows };
    };
    return { query, calls };
  };
  test('off never selects price_checked_at; shadow and enforce do', async () => {
    const { query, calls } = ownRowsQuery([row('111', null)]);
    expect((await readCanonicalOwnMoney({ ref, query })).get('111').amount).toBe(49);
    expect(calls[0]).not.toContain('price_checked_at');
    process.env.CANONICAL_OWN_MONEY_FRESHNESS = 'shadow';
    await readCanonicalOwnMoney({ ref, query });
    expect(calls[1]).toContain('co.price_checked_at');
    process.env.CANONICAL_OWN_MONEY_FRESHNESS = 'enforce';
    await expect(readCanonicalOwnMoney({ ref, query })).rejects.toMatchObject({ code: 'CURRENT_OWN_OFFER_UNAVAILABLE' });
    expect(calls[2]).toContain('co.price_checked_at');
  });
  test('a missing column degrades enforce to off (money served, one warning), and is not retried at once', async () => {
    process.env.CANONICAL_OWN_MONEY_FRESHNESS = 'enforce';
    const { query, calls } = ownRowsQuery([row('111', undefined)], { missingColumn: true });
    expect((await readCanonicalOwnMoney({ ref, query })).get('111').amount).toBe(49);
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain('price_checked_at');
    expect(warn.mock.calls.map(call => call[0].event)).toEqual(['pdp_own_money_freshness_unavailable']);
    expect((await readCanonicalOwnMoney({ ref, query })).get('111').amount).toBe(49);
    expect(calls).toHaveLength(3);
    expect(calls[2]).not.toContain('price_checked_at');
  });
  test('any other read failure still fails the read', async () => {
    process.env.CANONICAL_OWN_MONEY_FRESHNESS = 'enforce';
    const query = async () => { throw Object.assign(new Error('column co.other does not exist'), { code: '42703' }); };
    await expect(readCanonicalOwnMoney({ ref, query })).rejects.toThrow('co.other');
  });

  const listingRow = (listing, checked, variant = 'v1') => {
    const [merchant, product] = listing.split('|');
    return { ...row(variant, checked), listing_merchant_id: merchant, listing_product_id: product, product_key: `pk::${listing}` };
  };
  const sellerOffer = (merchantId, productId, variantId = 'v1') => ({ offer_id: `off_${merchantId}`, merchant_id: merchantId,
    product_id: productId, selected_variant_id: variantId, price: { amount: 1, currency: 'USD' } });

  test('other sellers under enforce: a stale listing is left unverified, a fresh one is kept', async () => {
    process.env.CANONICAL_OWN_MONEY_FRESHNESS = 'enforce';
    const { query, calls } = ownRowsQuery([listingRow('m_a|p_a', new Date()), listingRow('m_b|p_b', null)]);
    const verified = await readCanonicalSellerOffersMoney({ query, listings: [
      { merchant_id: 'm_a', product_id: 'p_a' }, { merchant_id: 'm_b', product_id: 'p_b' }] });
    expect(calls[0]).toContain('co.price_checked_at');
    expect(verified.has('m_a\u0000p_a')).toBe(true);
    expect(verified.has('m_b\u0000p_b')).toBe(false);
  });
  test('other sellers under shadow: still verified, and the projection logs the listing enforce would leave unverified', async () => {
    process.env.CANONICAL_OWN_MONEY_FRESHNESS = 'shadow';
    const { query } = ownRowsQuery([listingRow('m_a|p_a', new Date()), listingRow('m_b|p_b', null)]);
    const verified = await readCanonicalSellerOffersMoney({ query, listings: [
      { merchant_id: 'm_a', product_id: 'p_a' }, { merchant_id: 'm_b', product_id: 'p_b' }] });
    const { data, verifiedOffers } = projectSellerOffersMoney(
      { offers: [sellerOffer('m_a', 'p_a'), sellerOffer('m_b', 'p_b')] }, ref, verified);
    expect(verifiedOffers.map(o => o.merchant_id).sort()).toEqual(['m_a', 'm_b']);
    expect(data.offers.every(o => o.price_verification === 'verified')).toBe(true);
    expect(shadowEvents()).toEqual([expect.objectContaining({ scope: 'seller_listing', would: 'unavailable',
      merchant_id: 'm_b', listing_product_id: 'p_b', unpriced_variants: 1, stale_rows: 1 })]);
  });
});
