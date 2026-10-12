const { resolveBudgetConstraintsForRecall, resolveBudgetConstraintForCurrency } = require('../src/findProductsMulti/policy');
test('active budget SQL bounds share the final price conversion policy',()=>{
  const budget={currency:'EUR',min:5,max:10};
  for(const range of resolveBudgetConstraintsForRecall(budget)) expect(range).toEqual(resolveBudgetConstraintForCurrency(budget,range.currency).constraint);
});
test('no active budget does not introduce a recall filter',()=>{
  expect(resolveBudgetConstraintsForRecall(null)).toBeNull();expect(resolveBudgetConstraintsForRecall({currency:'USD'})).toBeNull();
});
test('undenominated budget retains native-unit semantics',()=>{
  expect(resolveBudgetConstraintsForRecall({max:20})).toEqual([{currency:null,min:null,max:20}]);
});
test('unconfigured FX supports only direct same-currency bounds, never fabricated conversions',()=>{
  expect(resolveBudgetConstraintsForRecall({currency:'ZZZ',max:20})).toEqual([{currency:'ZZZ',min:null,max:20}]);
});
test('every served market currency has a budget rate: an SG buyer budgeting in USD still gets an SGD range (ADR-026 P0)',()=>{
  const { BUYER_REGION_CURRENCY } = require('../src/auroraBff/buyerRegion');
  const served = ['US', 'SG'].map((m) => BUYER_REGION_CURRENCY[m]);
  for (const currency of served) {
    const out = resolveBudgetConstraintForCurrency({ currency: 'USD', max: 25 }, currency);
    expect(out.metadata.budget_fx_unresolved).toBe(false);
    expect(out.constraint.currency).toBe(currency);
  }
  const ranges = resolveBudgetConstraintsForRecall({ currency: 'USD', max: 25 });
  expect(ranges.map((r) => r.currency)).toEqual(expect.arrayContaining(['USD', 'SGD', 'AUD']));
  // An AUD budget for an SG buyer resolves too (USD-pivot), and the SGD bound is larger than the AUD one.
  const aud = resolveBudgetConstraintForCurrency({ currency: 'AUD', max: 40 }, 'SGD');
  expect(aud.constraint.max).toBeGreaterThan(30);
  expect(aud.constraint.max).toBeLessThan(40);
});
