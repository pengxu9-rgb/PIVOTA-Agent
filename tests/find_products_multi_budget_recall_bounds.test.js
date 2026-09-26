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
