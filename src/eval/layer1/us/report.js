const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeArtifacts({ outDir, summary, rows }) {
  ensureDir(outDir);
  const jsonPath = path.join(outDir, 'layer1_us_summary.json');
  const mdPath = path.join(outDir, 'layer1_us_summary.md');
  const rowsPath = path.join(outDir, 'layer1_us_rows.json');

  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(rowsPath, JSON.stringify(rows, null, 2));

  const md = [
    '# Layer1 US Eval Summary',
    '',
    `Samples: ${summary.n}`,
    '',
    '## Fit Score',
    `- min: ${summary.fitScore.min}`,
    `- p50: ${Math.round(summary.fitScore.p50)}`,
    `- p90: ${Math.round(summary.fitScore.p90)}`,
    `- max: ${summary.fitScore.max}`,
    '',
    '## Confidence counts',
    ...Object.entries(summary.confidenceCounts).map(([k, v]) => `- ${k}: ${v}`),
    '',
    'Artifacts:',
    `- ${path.relative(process.cwd(), jsonPath)}`,
    `- ${path.relative(process.cwd(), rowsPath)}`,
  ].join('\n');

  fs.writeFileSync(mdPath, md);
}

module.exports = {
  writeArtifacts,
};

