'use strict';

const { buildSeedSearchOfferScope } = require('../src/services/seedSearchOfferScope');

test('explicit seed stock scope requires affirmative availability', () => {
  const sql = buildSeedSearchOfferScope({ inStockOnly: true }, []);
  expect(sql).toContain("IN ('instock', 'available', 'true')");
  expect(sql).not.toContain('NOT IN');
});

test('unconstrained seed discovery has no availability predicate', () => {
  const sql = buildSeedSearchOfferScope({ inStockOnly: false }, []);
  expect(sql).not.toContain('availability');
});
