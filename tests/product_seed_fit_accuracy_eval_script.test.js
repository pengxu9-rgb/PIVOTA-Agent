const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = require('../scripts/eval_product_seed_fit_accuracy.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test('product seed fit accuracy seed has required schema', () => {
  const dataset = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'datasets', 'product_seed_fit_accuracy_seed.json'), 'utf8'),
  );
  assert.equal(dataset.schema_version, 'product_seed_fit_accuracy.v1');
  assert.equal(SCRIPT.validateDataset(dataset).length, 0);
  assert.ok(dataset.cases.length >= 5);
  for (const row of dataset.cases) {
    assert.ok(row.case_id);
    assert.ok(row.seed_product?.title);
    assert.ok(row.expected?.product_class_terms?.length > 0);
  }
});

test('product seed scorer passes product-analyze and recommendation relevance fixtures', () => {
  const testCase = {
    case_id: 'seed_sunscreen_oily_makeup_en',
    language: 'EN',
    seed_product: { title: 'Unseen Sunscreen SPF 50', brand: 'Supergoop' },
    expected: {
      product_class_terms: ['sunscreen', 'spf'],
      fit_terms: ['sunscreen', 'spf', 'makeup', 'oily'],
      contraindicated_terms: ['retinol'],
      min_relevant_top6: 2,
      must_include_any: [['reapply', 'SPF']],
    },
  };
  const raw = {
    product_analyze: {
      status: 200,
      body: {
        assistant_text:
          'Unseen Sunscreen SPF 50 fits as a sunscreen/SPF option for oily skin under makeup. Reapply SPF during the day.',
      },
    },
    shopping: {
      status: 200,
      body: {
        products: [
          { product_id: 'spf_1', title: 'Unseen Sunscreen SPF 50', category: 'Sunscreen' },
          { product_id: 'spf_2', title: 'Matte Fit Serum Sunscreen SPF 50', category: 'Sunscreen' },
        ],
      },
    },
  };

  const out = SCRIPT.scoreCase(testCase, raw);
  assert.equal(out.pass, true);
  assert.equal(out.steps.shopping.assessment.relevant_count, 2);
});

test('product seed scorer blocks contraindicated top products', () => {
  const assessment = SCRIPT.scoreProductList(
    [
      { title: 'Retinol Night Cream', category: 'Moisturizer', text: 'retinol cream' },
      { title: 'Peptide Moisturizer', category: 'Moisturizer', text: 'peptide cream' },
    ],
    {
      product_class_terms: ['moisturizer', 'cream'],
      contraindicated_terms: ['retinol'],
      min_relevant_top6: 1,
    },
  );
  assert.equal(assessment.pass, false);
  assert.equal(assessment.contraindicated_count, 1);
});

test('product seed fit runner reads offline responses and writes report', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'product-seed-fit-'));
  const datasetPath = path.join(tmp, 'dataset.json');
  const responsesDir = path.join(tmp, 'responses');
  const outDir = path.join(tmp, 'out');
  writeJson(datasetPath, {
    schema_version: 'product_seed_fit_accuracy.v1',
    defaults: {
      thresholds: {
        case_pass_rate_min: 1,
        http_2xx_rate_min: 1,
        language_match_rate_min: 1,
        safety_pass_rate_min: 1,
        product_relevance_rate_min: 1,
        contraindicated_product_max: 0,
      },
    },
    cases: [
      {
        case_id: 'fixture_seed',
        language: 'EN',
        seed_product: { title: 'Barrier Cream', brand: 'Example', category: 'Moisturizer' },
        expected: {
          product_class_terms: ['moisturizer', 'cream'],
          fit_terms: ['barrier', 'dry'],
          contraindicated_terms: ['retinol'],
          min_relevant_top6: 1,
        },
      },
    ],
  });
  writeJson(path.join(responsesDir, 'fixture_seed', 'product_analyze.json'), {
    status: 200,
    body: { assistant_text: 'Barrier Cream fits dry skin as a barrier moisturizer.' },
  });
  writeJson(path.join(responsesDir, 'fixture_seed', 'shopping.json'), {
    status: 200,
    body: { products: [{ product_id: 'm1', title: 'Barrier Cream', category: 'Moisturizer' }] },
  });

  const report = await SCRIPT.runBenchmark({
    dataset: datasetPath,
    responsesDir,
    outDir,
    runLive: false,
    failOnThreshold: false,
    timeoutMs: 1000,
  });

  assert.equal(report.summary.gate_pass, true);
  assert.equal(report.results[0].pass, true);
  assert.ok(fs.existsSync(path.join(outDir, 'summary.json')));
  assert.ok(fs.existsSync(path.join(outDir, 'report.md')));
});
