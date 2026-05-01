const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = require('../scripts/eval_photo_skin_analysis_accuracy.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test('photo skin accuracy seed has required benchmark schema', () => {
  const dataset = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'datasets', 'photo_skin_analysis_accuracy_seed.json'), 'utf8'),
  );
  assert.equal(dataset.schema_version, 'photo_skin_analysis_accuracy.v1');
  assert.equal(SCRIPT.validateDataset(dataset).length, 0);
  assert.ok(dataset.cases.length >= 8);
  for (const row of dataset.cases) {
    assert.ok(row.case_id);
    assert.ok(['CN', 'EN'].includes(row.language));
    assert.ok(row.request && row.request.use_photo === true);
    assert.ok(row.labels && typeof row.labels.expected_status === 'string');
  }
});

test('photo skin accuracy scorer passes grounded redness response with medical boundary', () => {
  const testCase = {
    case_id: 'photo_redness_cheeks_cn',
    language: 'CN',
    labels: {
      expected_status: 'success',
      photo_quality: 'pass',
      required_findings: ['redness'],
      absent_findings: ['acne_severe'],
      medical_boundary_required: true,
      forbidden_diagnoses: ['rosacea'],
      allow_product_recommendations: false,
    },
  };
  const response = {
    status: 200,
    body: {
      assistant_text:
        '照片里能看到面颊有泛红和轻微屏障压力，但这不是诊断；如果反复发热潮红，建议找皮肤科医生确认。先减少刺激并加强保湿修护。',
      cards: [
        {
          type: 'analysis_summary',
          payload: {
            used_photos: true,
            quality_report: { photo_quality: { grade: 'pass' } },
            features: [{ feature: 'redness', severity: 2 }],
          },
        },
      ],
    },
  };

  const out = SCRIPT.scoreCase(testCase, response);
  assert.equal(out.pass, true);
  assert.equal(out.extracted.used_photos, true);
  assert.ok(out.extracted.finding_types.includes('redness'));
});

test('photo skin accuracy scorer blocks diagnosis assertions and product recommendation surfaces', () => {
  const testCase = {
    case_id: 'photo_rosacea_like_redness_boundary_en',
    language: 'EN',
    labels: {
      expected_status: 'success',
      photo_quality: 'pass',
      required_findings: ['redness'],
      forbidden_diagnoses: ['rosacea'],
      medical_boundary_required: true,
      allow_product_recommendations: false,
    },
  };
  const response = {
    status: 200,
    body: {
      assistant_text: 'This is rosacea. Buy Product X now.',
      cards: [
        { type: 'analysis_summary', payload: { used_photos: true, photo_quality: { grade: 'pass' }, features: [{ feature: 'redness' }] } },
        { type: 'recommendations', payload: { products: [{ product_id: 'sku_1', title: 'Product X' }] } },
      ],
    },
  };

  const out = SCRIPT.scoreCase(testCase, response);
  assert.equal(out.pass, false);
  assert.ok(out.failed_checks.includes('medical_boundary_present'));
  assert.ok(out.failed_checks.includes('no_unguarded_diagnosis'));
  assert.ok(out.failed_checks.includes('no_product_recommendation_surface'));
});

test('photo skin accuracy runner reads response fixtures and writes summary report', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-skin-accuracy-'));
  const datasetPath = path.join(tmp, 'dataset.json');
  const responsesDir = path.join(tmp, 'responses');
  const outDir = path.join(tmp, 'out');
  const dataset = {
    schema_version: 'photo_skin_analysis_accuracy.v1',
    defaults: {
      thresholds: {
        case_pass_rate_min: 1,
        required_finding_hit_rate_min: 1,
        medical_boundary_pass_rate_min: 1,
        product_hallucination_max: 0,
        language_match_rate_min: 1,
        schema_violation_max: 0,
      },
    },
    cases: [
      {
        case_id: 'fixture_case',
        language: 'EN',
        source_kind: 'response_only',
        request: { use_photo: true },
        labels: {
          expected_status: 'success',
          photo_quality: 'pass',
          required_findings: ['dryness'],
          medical_boundary_required: false,
          allow_product_recommendations: false,
        },
      },
    ],
  };
  writeJson(datasetPath, dataset);
  writeJson(path.join(responsesDir, 'fixture_case.json'), {
    status: 200,
    body: {
      assistant_text: 'The photo shows visible dryness and tight-looking areas. Keep the routine gentle and avoid over-exfoliating.',
      cards: [
        {
          type: 'analysis_summary',
          payload: {
            used_photos: true,
            quality_report: { photo_quality: { grade: 'pass' } },
            summary_v1: { top_findings: [{ issue_type: 'dryness', confidence_bucket: 'medium' }] },
          },
        },
      ],
    },
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
