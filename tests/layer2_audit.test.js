const fs = require('fs');
const path = require('path');
const {
  createAuditAccumulator,
  consumeLookReplicatorEvent,
  finalizeAudit,
  streamJsonlFile,
} = require('../src/layer2/audit/layer2Audit');

describe('layer2 audit', () => {
  test('computes integrity, more availability, and funnel from JSONL', async () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'audit', 'look-replicator-2025-01-01.jsonl');
    expect(fs.existsSync(fixturePath)).toBe(true);

    const acc = createAuditAccumulator({ date: '2025-01-01', market: 'US' });
    await streamJsonlFile(fixturePath, async (row) => consumeLookReplicatorEvent(acc, row));

    const report = finalizeAudit(acc);
    expect(report.market).toBe('US');
    expect(report.metrics.eventIntegrity.lr_adjustments_exposed).toBe(2);
    expect(report.metrics.moreAvailability.exposuresWithMoreGte1Rate).toBeGreaterThan(0);
    expect(report.metrics.funnel.counts.exposed).toBeGreaterThanOrEqual(1);
    expect(report.metrics.funnel.counts.moreOpened).toBe(1);
    expect(report.metrics.funnel.counts.checkoutStarted).toBe(1);
  });

  test('flags missing exposureId/impressionId and rank swap violations', async () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'audit', 'look-replicator-2025-01-01.jsonl');
    const acc = createAuditAccumulator({ date: '2025-01-01', market: 'US' });
    await streamJsonlFile(fixturePath, async (row) => consumeLookReplicatorEvent(acc, row));

    const report = finalizeAudit(acc);
    expect(report.metrics.eventIntegrity.missingExposureIdRate).toBeGreaterThan(0);
    expect(report.metrics.eventIntegrity.missingImpressionIdRate).toBeGreaterThan(0);
    expect(report.metrics.explorationSanity.defaultMoreRankSwapViolationRate).toBeGreaterThan(0);
  });
});

