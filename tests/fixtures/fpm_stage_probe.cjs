'use strict';

// Boots the gateway, issues ONE find_products_multi invoke, and lets the server's own logger write the
// resulting `fpm_stage_breakdown` line to stdout. Run as a child process by
// tests/fpm_stage_attribution.node.test.cjs: pino writes through sonic-boom directly to fd 1, so an
// in-process patch of process.stdout.write never sees the line — reading a real child's stdout is the only
// way to assert on the telemetry the server actually emits.
//
// argv[2] is the search query.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.API_MODE = 'REAL';
// Nothing listens here; the upstream call fails fast and the pipeline still reports its stages, which is
// all this probe needs.
process.env.PIVOTA_API_BASE = 'http://127.0.0.1:4699';
const TEST_KEY = `ak_${'b'.repeat(64)}`;
process.env.PIVOTA_API_KEY = TEST_KEY;

const supertest = require('supertest');
const app = require('../../src/server');

const query = process.argv[2] || 'attribution probe running shoes';
// argv[3] optionally sets search.domain — 'beauty' drives the early indexed beauty lane
// (isPivotBeautyContractInvokeRequest keys off the explicit domain). Avoid ingredient words in the query:
// they trip earlyPreserveIngredientDirectForPivotBeautyContract and route elsewhere.
const domain = process.argv[3] || null;

(async () => {
  await supertest(app)
    .post('/agent/shop/v1/invoke')
    .set('x-agent-api-key', TEST_KEY)
    .send({
      operation: 'find_products_multi',
      metadata: { source: 'shopping_agent' },
      payload: { search: { query, page_size: 5, ...(domain ? { domain } : {}) } },
    });
  // The breakdown is emitted from res.on('finish'), after the response promise resolves.
  await new Promise((resolve) => setTimeout(resolve, 400));
  process.exit(0);
})().catch((err) => {
  console.error('PROBE_FAILED', err && err.message);
  process.exit(1);
});
