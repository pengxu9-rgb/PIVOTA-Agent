const { _internals } = require('../../scripts/run_wave1_seed_sync_shards.cjs');

describe('run_wave1_seed_sync_shards', () => {
  test('parseArgs accepts timeout and range flags', () => {
    expect(_internals.parseArgs([
      '--start-offset', '2000',
      '--end-offset', '2900',
      '--step', '100',
      '--timeout-ms', '15000',
    ])).toMatchObject({
      startOffset: 2000,
      endOffset: 2900,
      step: 100,
      timeoutMs: 15000,
    });
  });

  test('buildOffsets returns an inclusive stepped range', () => {
    expect(_internals.buildOffsets({
      startOffset: 2000,
      endOffset: 2300,
      step: 100,
    })).toEqual([2000, 2100, 2200, 2300]);
  });

  test('summarize aggregates shard summaries', () => {
    const summary = _internals.summarize([
      {
        ok: true,
        resumed: false,
        data: {
          summary: {
            scanned: 100,
            changed: 3,
            updated: 3,
            eligible_for_wave_apply: 3,
            skipped_guardrail: 5,
            quarantine_reason: { manual_upstream_required: 5 },
            seed_quarantine_bucket: { manual_upstream_required: 5 },
            contamination_signal_source: { row_scope_bundle_signal: 3 },
            seed_kb_sync_status: { kb_only_unsynced: 3, missing_both: 97 },
          },
        },
      },
      {
        ok: true,
        resumed: true,
        data: {
          summary: {
            scanned: 100,
            changed: 0,
            updated: 0,
            eligible_for_wave_apply: 0,
            skipped_guardrail: 7,
            quarantine_reason: { non_beauty_domain: 2, manual_upstream_required: 5 },
            seed_quarantine_bucket: { non_beauty_domain: 2, manual_upstream_required: 5 },
            contamination_signal_source: { row_scope_non_beauty_signal: 2 },
            seed_kb_sync_status: { missing_both: 100 },
          },
        },
      },
    ]);

    expect(summary.shards).toBe(2);
    expect(summary.ok_shards).toBe(2);
    expect(summary.failed_shards).toBe(0);
    expect(summary.resumed_shards).toBe(1);
    expect(summary.scanned).toBe(200);
    expect(summary.changed).toBe(3);
    expect(summary.updated).toBe(3);
    expect(summary.eligible_for_wave_apply).toBe(3);
    expect(summary.skipped_guardrail).toBe(12);
    expect(summary.quarantine_reason.manual_upstream_required).toBe(10);
    expect(summary.quarantine_reason.non_beauty_domain).toBe(2);
    expect(summary.seed_kb_sync_status.kb_only_unsynced).toBe(3);
    expect(summary.seed_kb_sync_status.missing_both).toBe(197);
  });
});
