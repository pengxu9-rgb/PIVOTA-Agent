const path = require('path');
const { SimilarityReportV0Schema } = require('../../../layer1/schemas/similarityReportV0');
const { runCompatibilityEngineUS } = require('../../../layer1/compatibility/us/runCompatibilityEngineUS');
const { defaultDatasetPath, loadJsonl } = require('./dataset');
const { assertInvariants } = require('./invariants');
const { computeMetrics } = require('./metrics');
const { writeArtifacts } = require('./report');
const { evalConfigUS } = require('./config');

function stableStringify(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

async function main() {
  const datasetPath = process.env.LAYER1_EVAL_DATASET_PATH || defaultDatasetPath();
  const samples = loadJsonl(datasetPath);
  if (samples.length < evalConfigUS.minSamples) {
    throw new Error(`Dataset too small: ${samples.length} (min ${evalConfigUS.minSamples})`);
  }

  const rows = [];
  for (const s of samples) {
    const report1 = runCompatibilityEngineUS({
      market: 'US',
      preferenceMode: s.preferenceMode,
      userFaceProfile: s.userFaceProfile ?? null,
      refFaceProfile: s.refFaceProfile,
      locale: s.locale,
    });
    const report = SimilarityReportV0Schema.parse(report1);

    // Determinism check: same input twice -> same output.
    const report2 = runCompatibilityEngineUS({
      market: 'US',
      preferenceMode: s.preferenceMode,
      userFaceProfile: s.userFaceProfile ?? null,
      refFaceProfile: s.refFaceProfile,
      locale: s.locale,
    });
    if (JSON.stringify(report) !== JSON.stringify(report2)) {
      throw new Error(`Non-deterministic output for sample ${s.id}`);
    }

    assertInvariants(s, report);

    rows.push({
      id: s.id,
      preferenceMode: s.preferenceMode,
      hasSelfie: Boolean(s.userFaceProfile),
      confidence: report.confidence,
      fitScore: report.fitScore,
      warnings: report.warnings || [],
    });
  }

  const summary = computeMetrics(rows);
  const outDir = path.join(process.cwd(), 'artifacts', 'eval');
  writeArtifacts({ outDir, summary, rows });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });

