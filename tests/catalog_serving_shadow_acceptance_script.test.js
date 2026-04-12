const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('catalog serving shadow acceptance script', () => {
  test('writes markdown and json artifacts from a healthy fixture summary', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-serving-shadow-'));
    const fixturePath = path.join(outDir, 'fixture.json');
    const scriptPath = path.join(repoRoot, 'scripts', 'catalog_serving_shadow_acceptance.js');

    fs.writeFileSync(
      fixturePath,
      JSON.stringify(
        {
          schema_version: 'pivota.catalog_serving.shadow_acceptance.v1',
          generated_at_utc: '2026-04-12T08:30:00Z',
          requested: {
            limit: 50,
            brand: 'KraveBeauty',
            market: 'US',
            sample_query: 'serum',
            sample_limit: 5,
            skip_search: false,
          },
          index_config: {
            enabled: true,
            index_name: 'catalog_public_v1',
            shadow_read_enabled: true,
          },
          backfill: {
            source_rows_scanned: 120,
            live_identity_rows: 60,
            docs_built: 55,
            public_docs_built: 44,
            non_public_docs_built: 11,
          },
          search_probe: {
            status: 'ok',
            source: 'opensearch_compatible',
            returned: 5,
            has_next_page: true,
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const stdout = execFileSync(
      process.execPath,
      [scriptPath, '--out-dir', outDir, '--input-json', fixturePath],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );
    const payload = JSON.parse(String(stdout || '').trim());
    expect(payload.readiness_status).toBe('green');
    expect(fs.existsSync(payload.json_path)).toBe(true);
    expect(fs.existsSync(payload.markdown_path)).toBe(true);

    const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));
    const markdown = fs.readFileSync(payload.markdown_path, 'utf8');
    expect(json.readiness_status).toBe('green');
    expect(json.shadow_ratio).toBeCloseTo(0.2, 4);
    expect(markdown).toContain('# Catalog Serving Shadow Acceptance');
    expect(markdown).toContain('Backfill sample and index probe passed baseline readiness checks.');
  });

  test('marks readiness yellow when the index probe is disabled', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-serving-shadow-yellow-'));
    const fixturePath = path.join(outDir, 'fixture.json');
    const scriptPath = path.join(repoRoot, 'scripts', 'catalog_serving_shadow_acceptance.js');

    fs.writeFileSync(
      fixturePath,
      JSON.stringify(
        {
          schema_version: 'pivota.catalog_serving.shadow_acceptance.v1',
          generated_at_utc: '2026-04-12T08:30:00Z',
          requested: {
            limit: 20,
            brand: null,
            market: 'US',
            sample_query: 'serum',
            sample_limit: 5,
            skip_search: false,
          },
          index_config: {
            enabled: false,
            index_name: 'catalog_public_v1',
            shadow_read_enabled: false,
          },
          backfill: {
            source_rows_scanned: 50,
            live_identity_rows: 15,
            docs_built: 12,
            public_docs_built: 4,
            non_public_docs_built: 8,
          },
          search_probe: {
            status: 'disabled',
            source: 'disabled',
            returned: 0,
            has_next_page: false,
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const stdout = execFileSync(
      process.execPath,
      [scriptPath, '--out-dir', outDir, '--input-json', fixturePath],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );
    const payload = JSON.parse(String(stdout || '').trim());
    const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));
    expect(payload.readiness_status).toBe('yellow');
    expect(json.notes).toEqual(
      expect.arrayContaining(['Catalog serving index probe was skipped or disabled; backfill sample passed.']),
    );
  });

  test('writes a blocked red report when prerequisites are missing', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-serving-shadow-blocked-'));
    const scriptPath = path.join(repoRoot, 'scripts', 'catalog_serving_shadow_acceptance.js');

    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--out-dir',
        outDir,
        '--blocked-reason',
        'GitHub Actions secret DATABASE_URL is not configured; shadow backfill sampling cannot run.',
        '--blocked-reason',
        'CATALOG_SERVING_INDEX_BASE_URL is not configured; the OpenSearch-compatible probe is unavailable.',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );
    const payload = JSON.parse(String(stdout || '').trim());
    const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));
    const markdown = fs.readFileSync(payload.markdown_path, 'utf8');

    expect(payload.readiness_status).toBe('red');
    expect(json.blocked).toBe(true);
    expect(json.blocked_reasons).toEqual(
      expect.arrayContaining([
        'GitHub Actions secret DATABASE_URL is not configured; shadow backfill sampling cannot run.',
        'CATALOG_SERVING_INDEX_BASE_URL is not configured; the OpenSearch-compatible probe is unavailable.',
      ]),
    );
    expect(markdown).toContain('## Blockers');
    expect(markdown).toContain('## Prerequisites');
  });

  test('fails when fail-on-status threshold is met', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-serving-shadow-fail-'));
    const fixturePath = path.join(outDir, 'fixture.json');
    const scriptPath = path.join(repoRoot, 'scripts', 'catalog_serving_shadow_acceptance.js');

    fs.writeFileSync(
      fixturePath,
      JSON.stringify(
        {
          schema_version: 'pivota.catalog_serving.shadow_acceptance.v1',
          generated_at_utc: '2026-04-12T08:30:00Z',
          requested: {
            limit: 20,
            brand: null,
            market: 'US',
            sample_query: 'serum',
            sample_limit: 5,
            skip_search: false,
          },
          index_config: {
            enabled: false,
            index_name: 'catalog_public_v1',
            shadow_read_enabled: false,
          },
          backfill: {
            source_rows_scanned: 50,
            live_identity_rows: 15,
            docs_built: 12,
            public_docs_built: 4,
            non_public_docs_built: 8,
          },
          search_probe: {
            status: 'disabled',
            source: 'disabled',
            returned: 0,
            has_next_page: false,
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    expect(() =>
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--out-dir',
          outDir,
          '--input-json',
          fixturePath,
          '--fail-on-status',
          'yellow',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        },
      ),
    ).toThrow();
  });
});
