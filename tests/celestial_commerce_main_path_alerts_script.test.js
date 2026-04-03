const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('Celestial commerce main-path alerts script', () => {
  test('evaluates staging matrix records against default thresholds', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-main-path-alerts-'));
    const scriptPath = path.join(repoRoot, 'scripts', 'evaluate_celestial_commerce_main_path_alerts.js');
    const stagingMatrixSummaryPath = path.join(outDir, 'staging-matrix.json');
    const gatewayDailySummaryPath = path.join(outDir, 'gateway-daily-summary.json');

    fs.writeFileSync(
      stagingMatrixSummaryPath,
      JSON.stringify(
        {
          summary: {
            total_cases: 2,
            live_cases: 2,
            main_path_pass_count: 2,
            primary_path_degraded_count: 0,
            service_version_commit_missing_count: 0,
          },
          results: [
            {
              execution_mode: 'live',
              response_excerpt: {
                main_path_pass: true,
                primary_path_degraded: false,
                decision_locked: true,
                decision_authority: 'shopping_agent',
                query_source: 'shopping_agent',
                service_version_commit_present: true,
              },
            },
            {
              execution_mode: 'live',
              response_excerpt: {
                main_path_pass: true,
                primary_path_degraded: false,
                decision_locked: true,
                decision_authority: 'search',
                query_source: 'search',
                service_version_commit_present: true,
              },
            },
          ],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      gatewayDailySummaryPath,
      JSON.stringify(
        {
          shadow_summary: {
            runtime_would_enforce_count: 0,
          },
        },
        null,
        2,
      ),
    );

    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--staging-matrix-summary',
        stagingMatrixSummaryPath,
        '--gateway-daily-summary',
        gatewayDailySummaryPath,
        '--out-dir',
        outDir,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    const payload = JSON.parse(String(stdout || '').trim());
    const summary = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

    expect(payload.overall_status).toBe('green');
    expect(summary.metrics.total_records).toBe(2);
    expect(summary.metrics.main_path_pass_rate).toBe(1);
    expect(summary.metrics.fallback_authority_count).toBe(0);
    expect(summary.metrics.decision_unlocked_count).toBe(0);
  });

  test('turns red when fallback authority takes over live records', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-main-path-alerts-'));
    const scriptPath = path.join(repoRoot, 'scripts', 'evaluate_celestial_commerce_main_path_alerts.js');
    const searchStabilitySummaryPath = path.join(outDir, 'search-stability.json');
    const gatewayDailySummaryPath = path.join(outDir, 'gateway-daily-summary.json');

    fs.writeFileSync(
      searchStabilitySummaryPath,
      JSON.stringify(
        {
          summary: {
            total_requests: 2,
          },
          rows: [
            {
              main_path_pass: false,
              primary_path_degraded: true,
              decision_locked: false,
              decision_authority: 'agent_products_error_fallback',
              query_source: 'agent_products_error_fallback',
              service_version_commit_present: false,
            },
            {
              main_path_pass: true,
              primary_path_degraded: false,
              decision_locked: true,
              decision_authority: 'search',
              query_source: 'search',
              service_version_commit_present: true,
            },
          ],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      gatewayDailySummaryPath,
      JSON.stringify(
        {
          shadow_summary: {
            runtime_would_enforce_count: 1,
          },
        },
        null,
        2,
      ),
    );

    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--search-stability-summary',
        searchStabilitySummaryPath,
        '--gateway-daily-summary',
        gatewayDailySummaryPath,
        '--out-dir',
        outDir,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    const payload = JSON.parse(String(stdout || '').trim());
    const summary = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

    expect(payload.overall_status).toBe('red');
    expect(summary.metrics.fallback_authority_count).toBe(1);
    expect(summary.metrics.agent_products_error_fallback_count).toBe(1);
    expect(summary.metrics.decision_unlocked_count).toBe(1);
    expect(summary.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'max_fallback_authority_count', status: 'red' }),
        expect.objectContaining({ key: 'max_governance_would_enforce_count', status: 'amber' }),
      ]),
    );
  });

  test('does not count recall clarify as fallback authority when primary path stays authoritative', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-main-path-alerts-'));
    const scriptPath = path.join(repoRoot, 'scripts', 'evaluate_celestial_commerce_main_path_alerts.js');
    const searchStabilitySummaryPath = path.join(outDir, 'search-stability.json');
    const gatewayDailySummaryPath = path.join(outDir, 'gateway-daily-summary.json');

    fs.writeFileSync(
      searchStabilitySummaryPath,
      JSON.stringify(
        {
          summary: {
            total_requests: 1,
          },
          rows: [
            {
              main_path_pass: true,
              primary_path_degraded: false,
              decision_locked: true,
              decision_authority: 'agent_products_search',
              query_source: 'agent_products_recall_clarify',
              service_version_commit_present: true,
            },
          ],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      gatewayDailySummaryPath,
      JSON.stringify(
        {
          shadow_summary: {
            runtime_would_enforce_count: 0,
          },
        },
        null,
        2,
      ),
    );

    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--search-stability-summary',
        searchStabilitySummaryPath,
        '--gateway-daily-summary',
        gatewayDailySummaryPath,
        '--out-dir',
        outDir,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    const payload = JSON.parse(String(stdout || '').trim());
    const summary = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

    expect(payload.overall_status).toBe('green');
    expect(summary.metrics.fallback_authority_count).toBe(0);
    expect(summary.metrics.agent_products_error_fallback_count).toBe(0);
    expect(summary.metrics.recall_exhaustion_count).toBe(1);
  });
});
