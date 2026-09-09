'use strict';

// The acne primary role is ranked 11 by the concern planner, and 11 > 1, so the
// budget picker handed it the SUPPORT tier's 1600ms — against a query measured at
// 1720-1800ms in prod. It always overran, and whether rows came back was decided
// by a race between the query resolving and the deadline firing. Two passing and
// two failing prod turns had overlapping query_ms and identical budgets.

process.env.AURORA_BFF_USE_MOCK = 'true';
const { __internal } = require('../src/auroraBff/routes');

const ROLE = {
  role_id: 'acne_clogged_pore_treatment',
  rank: 11,
  preferred_step: 'treatment',
  query_terms: ['salicylic acid treatment'],
  fit_keywords: ['clogged', 'pore'],
  product_type_hypotheses: ['serum'],
};
const TARGET_CONTEXT = {
  framework_id: 'recofw_budget',
  primary_role_id: 'acne_clogged_pore_treatment',
  framework_roles: [ROLE, { role_id: 'lightweight_moisturizer', rank: 20, preferred_step: 'moisturizer' }],
};

async function budgetFor({ role, targetContext }) {
  const seen = [];
  await __internal.searchLocalExternalSeedProducts({
    query: 'salicylic acid treatment',
    limit: 6,
    role,
    targetContext,
    preferredStep: 'treatment',
    queryFn: async (sql, params, options) => {
      seen.push(Number(options?.timeoutMs) || 0);
      return { rows: [] };
    },
  });
  return Math.max(0, ...seen);
}

describe('primary-role query budget', () => {
  test('the primary role gets the primary budget even when its rank is not 1', async () => {
    const budget = await budgetFor({ role: ROLE, targetContext: TARGET_CONTEXT });
    // Anything at or below the support tier means the rank test is back and the
    // primary is racing a deadline it cannot reliably beat.
    expect(budget).toBeGreaterThan(1600);
  });

  test('a support role still gets the support budget', async () => {
    const supportRole = { ...ROLE, role_id: 'lightweight_moisturizer', rank: 20, preferred_step: 'moisturizer' };
    const budget = await budgetFor({ role: supportRole, targetContext: TARGET_CONTEXT });
    expect(budget).toBeLessThanOrEqual(1600);
  });

  test('with no primary_role_id the old rank fallback still applies', async () => {
    const budget = await budgetFor({ role: ROLE, targetContext: { framework_roles: [ROLE] } });
    expect(budget).toBeLessThanOrEqual(1600);
  });
});
