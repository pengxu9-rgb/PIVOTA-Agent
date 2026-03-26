const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function writeCsv(filePath, fieldnames, rows) {
  const lines = [fieldnames.join(',')];
  for (const row of rows) {
    lines.push(
      fieldnames
        .map((field) => {
          const raw = String(row[field] ?? '');
          if (/[",\n]/.test(raw)) {
            return `"${raw.replace(/"/g, '""')}"`;
          }
          return raw;
        })
        .join(','),
    );
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

test('build_ingredient_master_new_canonical_decision_packet maps researched decisions', () => {
  const repoRoot = '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-master-new-canonical-'));
  const termsCsv = path.join(tempDir, 'terms.csv');
  const rowsCsv = path.join(tempDir, 'rows.csv');
  const outCsv = path.join(tempDir, 'packet.csv');
  const outSummary = path.join(tempDir, 'summary.json');
  const outXlsx = path.join(tempDir, 'packet.xlsx');

  writeCsv(
    termsCsv,
    ['signal_key', 'display_signal_name', 'example_brands', 'example_products'],
    [
      { signal_key: 'viniferine', display_signal_name: 'Viniferine', example_brands: 'Caudalie', example_products: 'Serum' },
      { signal_key: 'thiamidol', display_signal_name: 'Thiamidol', example_brands: 'Eucerin', example_products: 'Spot Corrector' },
    ],
  );

  writeCsv(
    rowsCsv,
    ['term_keys', 'official_product_url'],
    [
      { term_keys: 'viniferine', official_product_url: 'https://us.caudalie.com/p/example' },
      { term_keys: 'thiamidol', official_product_url: 'https://int.eucerin.com/products/example' },
    ],
  );

  const result = spawnSync(
    'python3',
    [
      'scripts/build_ingredient_master_new_canonical_decision_packet.py',
      '--terms-csv',
      termsCsv,
      '--row-followup-csv',
      rowsCsv,
      '--out-csv',
      outCsv,
      '--out-summary-json',
      outSummary,
      '--out-xlsx',
      outXlsx,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(fs.readFileSync(outSummary, 'utf8'));
  assert.equal(summary.decision_count, 2);
  assert.equal(summary.decision_status_counts.approved_rewrite_to_underlying_inci_candidate, 1);
  assert.equal(summary.decision_status_counts.approved_hold_named_active_pending_exact_label_confirmation, 1);

  const packetText = fs.readFileSync(outCsv, 'utf8');
  assert.match(packetText, /Palmitoyl Grapevine Shoot Extract/);
  assert.match(packetText, /keep_signal_only_until_exact_inci_confirmed/);
  assert.ok(fs.existsSync(outXlsx));
});
