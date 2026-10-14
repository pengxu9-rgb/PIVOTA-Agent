// Own-offer money freshness (pivota-backend #2601 follow-up b). `catalog_offers.price_checked_at` dates the
// last READ of a price (migration 246; NULL = none on record). CANONICAL_OWN_MONEY_FRESHNESS: `off` serves
// as before, `shadow` serves as before and logs what `enforce` would change, `enforce` leaves out every row
// whose read is older than CANONICAL_OWN_MONEY_MAX_AGE_DAYS (default 14) or was never made.
const logger = require('../src/logger');
const {
  readCanonicalOwnMoney, readCanonicalSellerOffersMoney, currentMoneyFromOwnRows, currentOwnMoneyReasonCode,
  ownMoneyFreshnessMode, ownMoneyMaxAgeDays, projectCanonicalProductMoney,
} = require('../src/services/canonicalPdpOwnMoney');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-14T12:00:00Z');
const ago = days => new Date(NOW - days * DAY);
const ref = { product_key: 'ext:owned::abc', product_id: 'ext_owned', merchant_id: 'merch_obs_owned' };
const row = (id, checked, amount = '49.00') => ({ offer_id: `o_${id}`, sku_key: `s_${id}`, source_variant_id: id,
  currency: 'USD', amount, price_checked_at: checked });
const at = (mode, rows, extra = {}) => currentMoneyFromOwnRows(rows, ref.product_key, {}, { mode, maxAgeDays: 14, now: NOW, ...extra });

let info;
beforeEach(() => { info = jest.spyOn(logger, 'info').mockImplementation(() => {}); });
afterEach(() => {
  info.mockRestore();
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
  test('window defaults to 14 days; a non-positive or non-numeric window is the default', () => {
    expect(ownMoneyMaxAgeDays({})).toBe(14);
    expect(ownMoneyMaxAgeDays({ CANONICAL_OWN_MONEY_MAX_AGE_DAYS: '30' })).toBe(30);
    for (const bad of ['0', '-3', 'abc', 'Infinity']) expect(ownMoneyMaxAgeDays({ CANONICAL_OWN_MONEY_MAX_AGE_DAYS: bad })).toBe(14);
  });
});

describe('enforce', () => {
  test('a read inside the window is money', () => {
    expect(at('enforce', [row('111', ago(13.9))]).get('111').amount).toBe(49);
  });
  test.each([
    ['never read (NULL)', null],
    ['read past the window', ago(14.1)],
    ['stamped in the future', new Date(NOW + DAY)],
    ['unparseable stamp', 'not-a-date'],
  ])('%s: the listing is CURRENT_OWN_OFFER_UNAVAILABLE', (_label, checked) => {
    let error;
    try { at('enforce', [row('111', checked)]); } catch (e) { error = e; }
    expect(currentOwnMoneyReasonCode(error)).toBe('CURRENT_OWN_OFFER_UNAVAILABLE');
  });
  test('a stale variant alone loses its money; the fresh variants keep theirs', () => {
    const money = at('enforce', [row('111', ago(1)), row('222', null, '59.00')]);
    expect([...money.keys()]).toEqual(['111']);
    const product = projectCanonicalProductMoney({ product_id: ref.product_id, variants: [
      { variant_id: '111', title: 'A', options: [{ name: 'Size', value: 'A' }], price: 45 },
      { variant_id: '222', title: 'B', options: [{ name: 'Size', value: 'B' }], price: 55 },
    ] }, money);
    expect(product.variants[0].price).toEqual({ amount: 49, currency: 'USD' });
    expect(product.variants[1]).toMatchObject({ current_own_offer_status: 'unavailable' });
    expect(product.variants[1]).not.toHaveProperty('price');
  });
  test('a stale row never decides a price conflict: only the fresh row prices the variant', () => {
    const money = at('enforce', [row('111', ago(1), '49.00'), { ...row('111', ago(30), '59.00'), offer_id: 'o_old' }]);
    expect(money.get('111').amount).toBe(49);
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
    expect(at('off', [row('111', null)]).get('111').amount).toBe(49);
    expect(info).not.toHaveBeenCalled();
  });
  test('shadow serves a never-read listing and logs that enforce would make it unavailable', () => {
    expect(at('shadow', [row('111', null)]).get('111').amount).toBe(49);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toMatchObject({ event: 'pdp_own_money_freshness_shadow', would: 'unavailable',
      product_key: ref.product_key, stale_rows: 1, rows: 1, unpriced_keys: 1, max_age_days: 14 });
  });
  test('shadow logs variants_unpriced when only some variants are stale', () => {
    const money = at('shadow', [row('111', ago(1)), row('222', ago(40), '59.00')]);
    expect([...money.keys()].sort()).toEqual(['111', '222']);
    expect(info.mock.calls[0][0]).toMatchObject({ would: 'variants_unpriced', stale_rows: 1, unpriced_keys: 1 });
  });
  test('shadow logs nothing when every row is fresh', () => {
    at('shadow', [row('111', ago(1)), row('222', ago(2), '59.00')]);
    expect(info).not.toHaveBeenCalled();
  });
  test('shadow still refuses what off refuses (conflicting prices)', () => {
    expect(() => at('shadow', [row('111', ago(1), '49.00'), { ...row('111', ago(1), '59.00'), offer_id: 'o2' }]))
      .toThrow('Conflicting');
  });
});

describe('the reads take the mode from the environment', () => {
  test('selected listing: the SELECT returns price_checked_at and enforce applies the window', async () => {
    const calls = [];
    const query = async sql => { calls.push(sql); return { rows: [row('111', null)] }; };
    expect((await readCanonicalOwnMoney({ ref, query })).get('111').amount).toBe(49);
    expect(calls[0]).toContain('co.price_checked_at');
    process.env.CANONICAL_OWN_MONEY_FRESHNESS = 'enforce';
    await expect(readCanonicalOwnMoney({ ref, query })).rejects.toMatchObject({ code: 'CURRENT_OWN_OFFER_UNAVAILABLE' });
  });
  test('other sellers: under enforce a stale listing is left unverified, a fresh one is kept', async () => {
    process.env.CANONICAL_OWN_MONEY_FRESHNESS = 'enforce';
    const listingRow = (listing, checked) => {
      const [merchant, product] = listing.split('|');
      return { ...row('v1', checked), listing_merchant_id: merchant, listing_product_id: product, product_key: `pk::${listing}` };
    };
    const calls = [];
    const query = async sql => { calls.push(sql); return { rows: [listingRow('m_a|p_a', new Date()), listingRow('m_b|p_b', null)] }; };
    const verified = await readCanonicalSellerOffersMoney({ query, listings: [
      { merchant_id: 'm_a', product_id: 'p_a' }, { merchant_id: 'm_b', product_id: 'p_b' }] });
    expect(calls[0]).toContain('co.price_checked_at');
    expect(verified.has('m_a\u0000p_a')).toBe(true);
    expect(verified.has('m_b\u0000p_b')).toBe(false);
  });
});
