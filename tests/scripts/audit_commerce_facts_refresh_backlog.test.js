const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildBacklogEntries } = require('../../scripts/audit-commerce-facts-refresh-backlog.cjs');

describe('audit-commerce-facts-refresh-backlog', () => {
  test('collects DTC refresh manifests that were dry-run only and still need apply', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-facts-backlog-'));
    const summaryPath = path.join(tmpDir, 'summary.json');
    const manifestPath = path.join(tmpDir, 'boj-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          items: [
            {
              seed_row: {
                external_product_id: 'ext_boj_1',
                title: 'Glow Deep Serum',
                canonical_url: 'https://beautyofjoseon.com/products/glow-deep-serum',
                price_amount: 17,
                price_currency: 'USD',
                availability: 'in_stock',
              },
            },
          ],
        },
        null,
        2,
      ),
    );
    const summary = {
      manifests: [
        {
          file: path.basename(manifestPath),
          dry_run_file: 'boj-dry-run.json',
          brand: 'Beauty of Joseon',
          market: 'US',
          channel_row_count: 0,
          gate_pass_count: 1,
          matched_preferred_titles: ['Glow Deep Serum'],
          dry_run_summary: {
            database_available: false,
            would_insert_unverified: 1,
          },
        },
      ],
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    const entries = buildBacklogEntries(summary, summaryPath);

    expect(entries).toHaveLength(1);
    expect(entries[0].brand).toBe('Beauty of Joseon');
    expect(entries[0].targets).toHaveLength(1);
    expect(entries[0].targets[0].external_product_id).toBe('ext_boj_1');
    expect(entries[0].recommended_commands.dry_run_by_brand).toContain('--include-commerce-facts');
    expect(fs.existsSync(entries[0].targets_file)).toBe(true);
  });
});
