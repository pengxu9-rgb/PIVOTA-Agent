const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVisionSignalsDto,
  buildReportSignalsDto,
  buildInputHashPrefix,
} = require('../src/auroraBff/skinSignalsDto');

test('skin signals dto: input_hash is stable for same payload', () => {
  const image = Buffer.from('image-bytes-1');
  const common = {
    lang: 'EN',
    photoQuality: { grade: 'degraded', reasons: ['blur'] },
    profileSummary: { goals: ['oil control'], sensitivity: 'high' },
    diagnosisPolicy: { uncertainty: true, detector_confidence_level: 'low' },
    factLayer: {
      features: [{ observation: 'limited clarity around cheeks', confidence: 'not_sure' }],
    },
    imageBuffer: image,
  };

  const a = buildVisionSignalsDto(common);
  const b = buildVisionSignalsDto(common);
  assert.equal(a.input_hash, b.input_hash);
  assert.equal(buildInputHashPrefix(a.input_hash).length, 8);
});

test('skin signals dto: report dto contains signals-only fields and remains compact', () => {
  const dto = buildReportSignalsDto({
    lang: 'EN',
    diagnosisV1: {
      issues: [
        { issue_type: 'redness', severity_level: 3, confidence: 0.9 },
        { issue_type: 'shine', severity_level: 2, confidence: 0.8 },
      ],
    },
    diagnosisPolicy: { uncertainty: false, detector_confidence_level: 'high' },
    profileSummary: {
      goals: ['hydration', 'oil control'],
      sensitivity: 'high',
      contraindications: ['pregnancy unknown'],
    },
    routineCandidate: 'AM cleanser + SPF; PM cleanser + moisturizer',
    photoQuality: { grade: 'pass', reasons: ['qc_passed'] },
    factLayer: {
      features: [{ observation: 'mild redness around cheeks', confidence: 'somewhat_sure' }],
    },
    imageBuffer: Buffer.from('image-bytes-2'),
  });

  const keys = Object.keys(dto).sort();
  for (const key of [
    'lang',
    'input_hash',
    'concern_rank',
    'deterministic_signals',
    'routine_summary',
    'constraints',
    'open_questions',
    'photo_quality',
    'uncertainty_level',
    'locked_features_summary',
  ]) {
    assert.equal(keys.includes(key), true);
  }

  const size = Buffer.byteLength(JSON.stringify(dto), 'utf8');
  assert.ok(size < 1400, `dto size too large: ${size}`);
});
