const baseline = require('../scripts/fixtures/celestial_commerce_gateway_governance_baseline.json');
const {
  buildGatewayGovernanceShadowSummary,
} = require('../src/modules/signals/readiness/buildGatewayGovernanceShadowSummary');
const fs = require('fs');
const path = require('path');

describe('Celestial gateway governance shadow summary', () => {
  test('summarizes baseline fixture into a green readiness result', () => {
    const summary = buildGatewayGovernanceShadowSummary({
      scenarios: baseline,
      shadow_mode: true,
    });

    expect(summary.schema_version).toBe('pivota.gateway.governance.shadow_summary.v1');
    expect(summary.readiness_status).toBe('green');
    expect(summary.total_scenarios).toBe(baseline.length);
    expect(summary.matched_scenarios).toBe(baseline.length);
    expect(summary.coverage.would_enforce_count).toBeGreaterThan(0);
    expect(summary.counters.by_surface.find((row) => row.key === 'mcp')).toBeTruthy();
    expect(summary.counters.by_reason_code.find((row) => row.key === 'merchant_sweep_blocked')).toBeTruthy();
  });

  test('aggregates sampled runtime shadow events without changing baseline readiness', () => {
    const samplePath = path.join(
      __dirname,
      '..',
      'scripts',
      'fixtures',
      'celestial_commerce_gateway_governance_shadow_runtime_sample.ndjson',
    );
    const runtimeEvents = fs
      .readFileSync(samplePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const summary = buildGatewayGovernanceShadowSummary({
      scenarios: baseline,
      runtime_events: runtimeEvents,
      shadow_mode: true,
    });

    expect(summary.readiness_status).toBe('green');
    expect(summary.runtime_samples.total_events).toBe(4);
    expect(summary.runtime_samples.shadow_events).toBe(3);
    expect(summary.runtime_samples.non_shadow_events).toBe(1);
    expect(summary.runtime_samples.coverage.would_enforce_count).toBe(2);
    expect(summary.runtime_samples.coverage.blocked_or_throttled_observed_count).toBe(1);
    expect(summary.runtime_samples.coverage.downgraded_or_truncated_observed_count).toBe(1);
    expect(summary.runtime_samples.counters.by_surface.find((row) => row.key === 'mcp')?.count).toBe(1);
    expect(summary.runtime_samples.counters.by_reason_code.find((row) => row.key === 'merchant_sweep_blocked')?.count).toBe(1);
  });
});
