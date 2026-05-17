const {
  toShopifyIdText,
  listShopifyIdTextValues,
  gidCandidateSet,
  gidCandidatesMatchList,
  gidMatchesList,
} = require('../../src/utils/shopifyGid');

describe('shopifyGid helpers', () => {
  describe('toShopifyIdText', () => {
    test('returns trimmed string', () => {
      expect(toShopifyIdText('  abc  ')).toBe('abc');
    });
    test('coerces numbers/booleans', () => {
      expect(toShopifyIdText(123)).toBe('123');
      expect(toShopifyIdText(true)).toBe('true');
    });
    test('extracts id/gid/productId from object', () => {
      expect(toShopifyIdText({ id: 'gid://shopify/Product/1' })).toBe('gid://shopify/Product/1');
      expect(toShopifyIdText({ product_id: 'p_2' })).toBe('p_2');
      expect(toShopifyIdText({ variantGid: 'gid://shopify/ProductVariant/9' })).toBe(
        'gid://shopify/ProductVariant/9'
      );
    });
    test('returns empty string for null/undefined/empty', () => {
      expect(toShopifyIdText(null)).toBe('');
      expect(toShopifyIdText(undefined)).toBe('');
      expect(toShopifyIdText({})).toBe('');
    });
  });

  describe('gidCandidateSet', () => {
    test('expands a Shopify GID into prefix-stripped + numeric tail', () => {
      const set = gidCandidateSet('gid://shopify/Product/10064567370025');
      expect(set.has('gid://shopify/Product/10064567370025')).toBe(true);
      expect(set.has('10064567370025')).toBe(true);
    });
    test('numeric input expands to itself only', () => {
      const set = gidCandidateSet('10064567370025');
      expect(set.has('10064567370025')).toBe(true);
      expect(set.size).toBe(1);
    });
    test('multiple inputs are unioned', () => {
      const set = gidCandidateSet('gid://shopify/Product/1', { id: 'gid://shopify/Product/2' });
      expect(set.has('gid://shopify/Product/1')).toBe(true);
      expect(set.has('1')).toBe(true);
      expect(set.has('gid://shopify/Product/2')).toBe(true);
      expect(set.has('2')).toBe(true);
    });
    test('non-shopify gid still produces numeric tail', () => {
      const set = gidCandidateSet('weird-thing-42');
      expect(set.has('weird-thing-42')).toBe(true);
      expect(set.has('42')).toBe(true);
    });
  });

  describe('gidMatchesList', () => {
    test('numeric candidate matches GID in list', () => {
      // The bug case: cached product_id is numeric, promo scope holds full GIDs.
      expect(
        gidMatchesList('10064567370025', ['gid://shopify/Product/10064567370025'])
      ).toBe(true);
    });
    test('GID candidate matches numeric in list', () => {
      expect(
        gidMatchesList('gid://shopify/Product/10064567370025', ['10064567370025'])
      ).toBe(true);
    });
    test('list of objects (Shopify .products.nodes shape) matches numeric pid', () => {
      expect(
        gidMatchesList('10064567370025', [
          { id: 'gid://shopify/Product/10064567370025' },
          { id: 'gid://shopify/Product/9999' },
        ])
      ).toBe(true);
    });
    test('no match returns false', () => {
      expect(gidMatchesList('10064567370025', ['gid://shopify/Product/9999'])).toBe(false);
    });
    test('empty list returns false', () => {
      expect(gidMatchesList('10064567370025', [])).toBe(false);
      expect(gidMatchesList('10064567370025', null)).toBe(false);
    });
    test('empty candidate returns false', () => {
      expect(gidMatchesList('', ['gid://shopify/Product/1'])).toBe(false);
      expect(gidMatchesList(null, ['gid://shopify/Product/1'])).toBe(false);
    });
  });

  describe('gidCandidatesMatchList', () => {
    test('candidate set intersects expanded list', () => {
      const cs = gidCandidateSet('gid://shopify/Product/42');
      expect(gidCandidatesMatchList(cs, ['gid://shopify/Product/42'])).toBe(true);
      expect(gidCandidatesMatchList(cs, ['42'])).toBe(true);
      expect(gidCandidatesMatchList(cs, ['gid://shopify/Product/99'])).toBe(false);
    });
  });

  describe('listShopifyIdTextValues', () => {
    test('flattens mixed array', () => {
      expect(
        listShopifyIdTextValues(['gid://shopify/Product/1', { id: 'gid://shopify/Product/2' }, null, ''])
      ).toEqual(['gid://shopify/Product/1', 'gid://shopify/Product/2']);
    });
  });
});
