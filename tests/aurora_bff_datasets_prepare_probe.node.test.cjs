const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildContentProbe,
  deriveProbeVerdict,
} = require('../scripts/datasets_prepare_probe.cjs');

test('datasets_prepare probe classifies likely repo zip', () => {
  const relFiles = [
    'README.md',
    'src/main.py',
    'src/train.py',
    'src/utils/io.py',
    'package.json',
    'docs/setup.md',
    'scripts/run.sh',
    'images/demo.png',
  ];
  const probe = buildContentProbe(relFiles);
  const verdict = deriveProbeVerdict({
    dataset: 'fasseg',
    contentProbe: probe,
    indexRecordCount: 0,
  });

  assert.equal(verdict.verdict, 'LIKELY_REPO_ZIP');
  assert.match(verdict.hint, /repository zip/i);
});

test('datasets_prepare probe classifies likely dataset zip', () => {
  const relFiles = [];
  for (let i = 0; i < 200; i += 1) {
    relFiles.push(`images/${i}.jpg`);
    relFiles.push(`masks/${i}_mask.png`);
  }
  const probe = buildContentProbe(relFiles);
  const verdict = deriveProbeVerdict({
    dataset: 'fasseg',
    contentProbe: probe,
    indexRecordCount: 180,
  });

  assert.equal(verdict.verdict, 'LIKELY_DATASET_ZIP');
  assert.equal(Boolean(verdict.hint), false);
});
