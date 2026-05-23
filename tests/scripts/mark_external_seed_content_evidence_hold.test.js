const {
  HOLD_VERSION,
  buildMarker,
  patchSeedData,
} = require('../../scripts/mark-external-seed-content-evidence-hold.cjs');
const fs = require('node:fs');
const path = require('node:path');

describe('mark-external-seed-content-evidence-hold', () => {
  test('adds content evidence hold marker without deleting commerce fields', () => {
    const marker = buildMarker({
      reason: 'official_source_missing_editorial_content',
      evidence: 'official PDP returned 200 but exposed no description/details',
      sourceUrl: 'https://sigmabeauty.com/products/caramel-apple-eyeshadow-quad',
      generatedAt: '2026-05-23T00:00:00.000Z',
    });
    const patched = patchSeedData(
      {
        price_amount: 14,
        price_currency: 'USD',
        availability: 'in_stock',
        snapshot: {
          price_amount: 14,
          price_currency: 'USD',
          availability: 'in_stock',
        },
      },
      marker,
    );

    expect(marker.contract_version).toBe(HOLD_VERSION);
    expect(patched.content_evidence_hold_v1).toEqual(
      expect.objectContaining({
        status: 'hold_for_evidence',
        public_serving_ready: false,
        content_evidence_ready: false,
      }),
    );
    expect(patched.snapshot.content_evidence_hold_v1).toEqual(patched.content_evidence_hold_v1);
    expect(patched.price_amount).toBe(14);
    expect(patched.price_currency).toBe('USD');
    expect(patched.availability).toBe('in_stock');
    expect(patched.snapshot.price_amount).toBe(14);
    expect(patched.snapshot.price_currency).toBe('USD');
    expect(patched.snapshot.availability).toBe('in_stock');
  });

  test('updates IPS using existing timestamp columns only', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../scripts/mark-external-seed-content-evidence-hold.cjs'),
      'utf8',
    );
    const ipsUpdate = source.match(/UPDATE index_pipeline_state ips[\s\S]+?WHERE cp\.content_key = ips\.content_key/)?.[0] || '';

    expect(ipsUpdate).toContain('quality_scored_at');
    expect(ipsUpdate).not.toContain('updated_at');
  });
});
