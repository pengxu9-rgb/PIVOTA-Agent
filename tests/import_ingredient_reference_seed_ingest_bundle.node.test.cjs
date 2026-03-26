const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInsertStatement,
  loadBundle,
  parseCsvText,
  splitQualifiedTableName,
} = require('../scripts/import_ingredient_reference_seed_ingest_bundle.js');

test('parseCsvText handles quoted commas, newlines, and escaped quotes', () => {
  const rows = parseCsvText('a,b,c\n1,"two, too","line 1\nline ""2"""\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', 'two, too', 'line 1\nline "2"'],
  ]);
});

test('buildInsertStatement emits parameterized multi-row insert sql', () => {
  const sql = buildInsertStatement('seed_ingest', 'ingredient_reference_seed', ['a', 'b'], 2);
  assert.equal(
    sql,
    'INSERT INTO "seed_ingest"."ingredient_reference_seed" ("a", "b") VALUES ($1, $2), ($3, $4)',
  );
});

test('splitQualifiedTableName validates schema-qualified names', () => {
  assert.deepEqual(splitQualifiedTableName('seed_ingest.ingredient_reference_seed'), {
    schema: 'seed_ingest',
    table: 'ingredient_reference_seed',
  });
  assert.throws(() => splitQualifiedTableName('ingredient_reference_seed'), /invalid_target_table/);
});

test('loadBundle validates header and row count against manifest', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-seed-bundle-'));
  const csvPath = path.join(tempDir, 'bundle.csv');
  const manifestPath = path.join(tempDir, 'manifest.json');
  fs.writeFileSync(csvPath, 'col_a,col_b\n1,"two, too"\n', 'utf8');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      out_csv: csvPath,
      target_table: 'seed_ingest.ingredient_reference_seed',
      row_count: 1,
      exported_columns: ['col_a', 'col_b'],
    }),
    'utf8',
  );

  const bundle = loadBundle(manifestPath);
  assert.equal(bundle.header.length, 2);
  assert.equal(bundle.dataRows.length, 1);
  assert.deepEqual(bundle.dataRows[0], ['1', 'two, too']);
});
