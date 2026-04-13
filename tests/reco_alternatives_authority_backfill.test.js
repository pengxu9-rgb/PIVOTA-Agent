describe('recoAlternativesAuthorityBackfill', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../src/db');
  });

  test('dedupes punctuated brand variants into the same backfill job key', () => {
    const backfill = require('../src/auroraBff/recoAlternativesAuthorityBackfill');
    expect(
      backfill._internals.buildBackfillJobKey({ brand: 'Supergoop!', market: 'US' }),
    ).toBe(backfill._internals.buildBackfillJobKey({ brand: 'Supergoop', market: 'US' }));
    expect(
      backfill._internals.buildBackfillJobKey({ brand: "Paula's Choice", market: 'US' }),
    ).toBe(backfill._internals.buildBackfillJobKey({ brand: 'Paulas Choice', market: 'US' }));
  });

  test('resolves source plans for punctuated brands through normalized authority lookups', async () => {
    const query = jest.fn(async (sql, params) => {
      if (sql.includes('FROM pdp_identity_listing')) {
        expect(params[0]).toContain('supergoop!');
        expect(params[1]).toContain('supergoop');
        expect(params[2]).toContain('supergoop');
        return { rows: [] };
      }
      if (sql.includes('FROM external_product_seeds')) {
        expect(params[0]).toContain('supergoop!');
        expect(params[2]).toContain('supergoop');
        expect(params[3]).toContain('supergoop');
        expect(params[1]).toBe('US');
        return {
          rows: [
            {
              domain: 'supergoop.com',
              source_role: 'primary',
              source_url: 'https://supergoop.com',
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    jest.doMock('../src/db', () => ({
      getPool: () => ({}),
      query,
    }));

    const backfill = require('../src/auroraBff/recoAlternativesAuthorityBackfill');
    const result = await backfill._internals.resolveBrandSourcePlanDefault({
      brand: 'Supergoop!',
      market: 'US',
    });

    expect(result).toMatchObject({
      ok: true,
      primaryDomain: 'https://supergoop.com',
      primaryRole: 'primary',
      fallbackDomains: [],
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  test('falls back to guessed official domain when authority tables have no brand domain', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const axiosGet = jest.fn(async (url) => ({
      status: 200,
      data: '<html><title>Beauty of Joseon</title></html>',
      config: { url },
      request: {
        res: {
          responseUrl: 'https://beautyofjoseon.com/',
        },
      },
    }));

    jest.doMock('../src/db', () => ({
      getPool: () => ({}),
      query,
    }));
    jest.doMock('axios', () => ({
      get: axiosGet,
    }));

    const backfill = require('../src/auroraBff/recoAlternativesAuthorityBackfill');
    const result = await backfill._internals.resolveBrandSourcePlanDefault({
      brand: 'Beauty of Joseon',
      market: 'US',
    });

    expect(result).toMatchObject({
      ok: true,
      primaryDomain: 'https://beautyofjoseon.com',
      primaryRole: 'guessed_official',
      fallbackDomains: [],
    });
    expect(axiosGet).toHaveBeenCalled();
  });

  test('runs post-apply enrichment and queues pivota insights for clean seeds', async () => {
    const query = jest.fn(async () => ({
      rows: [
        {
          id: 'seed_1',
          external_product_id: 'ext_1',
          market: 'US',
          domain: 'roundlab.com',
          canonical_url: 'https://roundlab.com/products/birch-juice',
          destination_url: 'https://roundlab.com/products/birch-juice',
          title: 'Birch Juice Moisturizing Sunscreen SPF50+ PA++++',
          seed_data: {
            brand: 'Round Lab',
            snapshot: {
              brand: 'Round Lab',
              canonical_url: 'https://roundlab.com/products/birch-juice',
            },
          },
          status: 'active',
        },
      ],
    }));
    const auditExternalSeedRow = jest.fn(() => ({ findings: [] }));
    const summarizeAuditResults = jest.fn(() => ({
      scanned: 1,
      flagged_rows: 0,
      findings_total: 0,
      by_severity: { blocker: 0, review: 0, info: 0 },
    }));
    const auditRow = jest.fn(async () => ({
      seed_id: 'seed_1',
      external_product_id: 'ext_1',
      failure_reasons: [],
    }));
    const runCoverageBatch = jest.fn(async () => ({
      status: 'ok',
      out_dir: '/tmp/pivota-insights',
      review: '/tmp/pivota-insights/review.json',
      count: 1,
    }));

    jest.doMock('../src/db', () => ({
      getPool: () => ({}),
      query,
    }));
    jest.doMock('../src/services/externalSeedContentAudit', () => ({
      auditExternalSeedRow,
      summarizeAuditResults,
    }));
    jest.doMock('../scripts/audit-external-product-pdp-quality.js', () => ({
      auditRow,
      resolveGatewayUrl: jest.fn((value) => value || 'https://agent.pivota.cc/api/gateway'),
    }));
    jest.doMock('../scripts/pivota_insights_coverage_batch.js', () => ({
      runCoverageBatch,
    }));

    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-backfill-enrichment-'));

    const backfill = require('../src/auroraBff/recoAlternativesAuthorityBackfill');
    const result = await backfill._internals.runPostApplyEnrichmentDefault({
      jobDir,
      brand: 'Round Lab',
      market: 'US',
      appliedSeedIds: ['seed_1'],
      logger: null,
    });

    expect(result.status).toBe('completed');
    expect(result.eligible_seed_ids).toEqual(['seed_1']);
    expect(result.eligible_external_product_ids).toEqual(['ext_1']);
    expect(result.remaining_followups).toEqual([]);
    expect(result.pivota_insights).toMatchObject({
      status: 'completed',
      queued_external_product_ids: ['ext_1'],
      count: 1,
    });
    expect(auditRow).toHaveBeenCalledTimes(1);
    expect(runCoverageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        productIds: ['ext_1'],
        model: expect.stringContaining('gemini-3'),
      }),
    );
  });

  test('stops post-apply enrichment before pivota insights when seed audit finds blocking issues', async () => {
    const query = jest.fn(async () => ({
      rows: [
        {
          id: 'seed_blocked',
          external_product_id: 'ext_blocked',
          market: 'US',
          domain: 'example.com',
          canonical_url: 'https://example.com/products/blocked',
          destination_url: 'https://example.com/products/blocked',
          title: 'Blocked Product',
          seed_data: {
            brand: 'Blocked Brand',
            snapshot: {
              brand: 'Blocked Brand',
            },
          },
          status: 'active',
        },
      ],
    }));
    const auditExternalSeedRow = jest.fn(() => ({
      findings: [
        {
          severity: 'review',
          anomaly_type: 'polluted_description',
        },
      ],
    }));
    const summarizeAuditResults = jest.fn(() => ({
      scanned: 1,
      flagged_rows: 1,
      findings_total: 1,
      by_severity: { blocker: 0, review: 1, info: 0 },
    }));
    const auditRow = jest.fn();
    const runCoverageBatch = jest.fn();

    jest.doMock('../src/db', () => ({
      getPool: () => ({}),
      query,
    }));
    jest.doMock('../src/services/externalSeedContentAudit', () => ({
      auditExternalSeedRow,
      summarizeAuditResults,
    }));
    jest.doMock('../scripts/audit-external-product-pdp-quality.js', () => ({
      auditRow,
      resolveGatewayUrl: jest.fn((value) => value || 'https://agent.pivota.cc/api/gateway'),
    }));
    jest.doMock('../scripts/pivota_insights_coverage_batch.js', () => ({
      runCoverageBatch,
    }));

    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-backfill-enrichment-'));

    const backfill = require('../src/auroraBff/recoAlternativesAuthorityBackfill');
    const result = await backfill._internals.runPostApplyEnrichmentDefault({
      jobDir,
      brand: 'Blocked Brand',
      market: 'US',
      appliedSeedIds: ['seed_blocked'],
      logger: null,
    });

    expect(result.status).toBe('partial');
    expect(result.eligible_seed_ids).toEqual([]);
    expect(result.eligible_external_product_ids).toEqual([]);
    expect(result.remaining_followups).toEqual(['seed_content_audit']);
    expect(result.seed_content_audit.blocked_rows).toHaveLength(1);
    expect(result.pivota_insights).toMatchObject({
      status: 'skipped_no_eligible_products',
    });
    expect(auditRow).not.toHaveBeenCalled();
    expect(runCoverageBatch).not.toHaveBeenCalled();
  });
});
