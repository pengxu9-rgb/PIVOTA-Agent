const path = require('path');

const {
  buildDefaultOutDir,
  parseArgs,
  summarizeReviewRows,
} = require('../scripts/pivota_insights_skill');

describe('pivota insights skill entrypoint', () => {
  test('parseArgs defaults to help and keeps review gate flags', () => {
    const args = parseArgs([
      'node',
      'script',
      'prepare',
      '--cases',
      'cases.json',
      '--batch-name',
      'merchant-upload-demo',
      '--write',
    ]);

    expect(args.command).toBe('prepare');
    expect(args.cases).toBe('cases.json');
    expect(args.batchName).toBe('merchant-upload-demo');
    expect(args.write).toBe(true);
  });

  test('summarizeReviewRows reports pending and blocked case ids', () => {
    const summary = summarizeReviewRows({
      rows: [
        { case_id: 'a', review_status: 'pass' },
        { case_id: 'b', review_status: 'rewrite' },
        { case_id: 'c', review_status: 'pending' },
      ],
    });

    expect(summary.counts).toEqual({
      total: 3,
      pass: 1,
      rewrite: 1,
      pending: 1,
    });
    expect(summary.ready_to_publish).toBe(false);
    expect(summary.blocked_case_ids).toEqual(['b', 'c']);
  });

  test('buildDefaultOutDir keeps reports under reports/pivota-insights', () => {
    const outDir = buildDefaultOutDir('/tmp/repo', 'merchant upload 1');
    expect(outDir).toBe(path.join('/tmp/repo', 'reports', 'pivota-insights', 'merchant-upload-1'));
  });
});
