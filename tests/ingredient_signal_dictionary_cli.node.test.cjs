const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-signal-dictionary-'));
}

function writeCsv(filePath, rows) {
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => JSON.stringify(String(row[header] ?? ''))).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  const [headerLine, ...dataLines] = text.split('\n');
  function parseCsvLine(line) {
    const out = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (char === ',' && !inQuotes) {
        out.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    out.push(current);
    return out;
  }

  const headers = parseCsvLine(headerLine);
  return dataLines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

test('build_ingredient_signal_dictionary groups approved candidates by bucket and key', () => {
  const tempDir = makeTempDir();
  const inputA = path.join(tempDir, 'signal_candidates_a.csv');
  const inputB = path.join(tempDir, 'signal_candidates_b.csv');
  const outCsv = path.join(tempDir, 'signal_dictionary.csv');
  const outJson = path.join(tempDir, 'signal_dictionary_summary.json');

  writeCsv(inputA, [
    {
      raw_token: 'AHA',
      normalized_token: 'aha',
      signal_bucket: 'acid_family_signal',
      signal_key: 'aha',
      source_decision: 'approve_suggestion',
      suggestion_confidence: 'high',
      priority_score: '10',
      unmatched_count: '4',
      sku_row_count: '4',
      full_inci_count: '',
      key_count: '4',
      top_categories: 'serum:2; cleanser:2',
      example_brands: 'Brand A',
      example_products: 'Product A',
      example_urls: 'https://example.com/a',
      resolution_rationale: 'Umbrella acid-family signal.',
      source_packet: 'ingredient_signal_review_packet',
    },
    {
      raw_token: 'Ceramides',
      normalized_token: 'ceramides',
      signal_bucket: 'ingredient_family_signal',
      signal_key: 'ceramides',
      source_decision: 'approve_suggestion',
      suggestion_confidence: 'high',
      priority_score: '8',
      unmatched_count: '6',
      sku_row_count: '6',
      full_inci_count: '',
      key_count: '6',
      top_categories: 'moisturizer:6',
      example_brands: 'Brand C',
      example_products: 'Product C',
      example_urls: 'https://example.com/c',
      resolution_rationale: 'Family signal.',
      source_packet: 'ingredient_signal_review_packet',
    },
  ]);

  writeCsv(inputB, [
    {
      raw_token: 'Alpha Hydroxy Acids',
      normalized_token: 'alphahydroxyacids',
      signal_bucket: 'acid_family_signal',
      signal_key: 'aha',
      source_decision: 'approve_override',
      suggestion_confidence: 'low',
      priority_score: '1',
      unmatched_count: '1',
      sku_row_count: '1',
      full_inci_count: '',
      key_count: '1',
      top_categories: 'cleanser:1',
      example_brands: 'Brand B',
      example_products: 'Product B',
      example_urls: 'https://example.com/b',
      resolution_rationale: 'Normalized to AHA family.',
      source_packet: 'ingredient_named_active_review_packet',
    },
    {
      raw_token: 'Thiamidol',
      normalized_token: 'thiamidol',
      signal_bucket: 'named_active_signal',
      signal_key: 'thiamidol',
      source_decision: 'approve_override',
      suggestion_confidence: 'low',
      priority_score: '6',
      unmatched_count: '3',
      sku_row_count: '3',
      full_inci_count: '',
      key_count: '3',
      top_categories: 'serum:3',
      example_brands: 'Brand D',
      example_products: 'Product D',
      example_urls: 'https://example.com/d',
      resolution_rationale: 'Named active signal.',
      source_packet: 'ingredient_named_active_review_packet',
    },
  ]);

  execFileSync(
    'python3',
    [
      'scripts/build_ingredient_signal_dictionary.py',
      '--candidate-csv',
      inputA,
      '--candidate-csv',
      inputB,
      '--out-csv',
      outCsv,
      '--out-summary-json',
      outJson,
    ],
    {
      cwd: '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend',
      stdio: 'pipe',
    },
  );

  const rows = readCsv(outCsv);
  assert.equal(rows.length, 3);

  const aha = rows.find((row) => row.signal_bucket === 'acid_family_signal' && row.signal_key === 'aha');
  assert.ok(aha);
  assert.equal(aha.display_signal_name, 'AHA');
  assert.equal(aha.row_count, '2');
  assert.equal(aha.total_unmatched_count, '5');
  assert.match(aha.raw_token_variants, /AHA/);
  assert.match(aha.raw_token_variants, /Alpha Hydroxy Acids/);

  const summary = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(summary.source_row_count, 4);
  assert.equal(summary.dictionary_row_count, 3);
  assert.equal(summary.signal_bucket_counts.acid_family_signal, 1);
  assert.equal(summary.signal_bucket_counts.ingredient_family_signal, 1);
  assert.equal(summary.signal_bucket_counts.named_active_signal, 1);
});
