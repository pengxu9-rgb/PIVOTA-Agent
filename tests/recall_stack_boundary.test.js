'use strict';

const { execSync } = require('child_process');
const path = require('path');

// Part A decision (2026-06-25, see docs/COMMERCE_INDEX_CONVERGENCE_AND_PUBLISH_PLAN.md §A.4):
// the Node gateway is the SINGLE live agent recall core; pivota-backend's
// /v1/pivot search stays INTERNAL-only and is NOT parity-guaranteed with the
// gateway (measured baseline: ~0.24 product overlap, 0.04 top-1 agreement).
//
// This guards the decoupling: the gateway must not gain a LIVE caller of
// /v1/pivot — that would re-couple the two divergent stacks and silently make
// agent results depend on which engine answered. If you deliberately decide to
// converge, do it as a scoped project and delete this test in that PR.
describe('recall stack boundary (Part A — keep /v1/pivot internal)', () => {
  test('the gateway source does not call the backend /v1/pivot recall path', () => {
    const srcRoot = path.join(__dirname, '..', 'src');
    let hits = '';
    try {
      hits = execSync(`grep -rIln "v1/pivot" "${srcRoot}" || true`, { encoding: 'utf8' }).trim();
    } catch (err) {
      hits = String((err && err.stdout) || '');
    }
    expect(hits).toBe('');
  });
});
