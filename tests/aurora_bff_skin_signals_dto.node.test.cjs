const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVisionSignalsDto,
  buildReportSignalsDto,
  buildDeepeningSignalsDto,
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
  assert.equal('lang' in a, false);
  assert.equal('user_goal' in a, false);
  assert.equal('locked_features_summary' in a, false);
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
    visionCanonical: {
      observations: [
        { cue: 'redness', region: 'cheeks', severity: 'mild', confidence: 'high', evidence: 'pink tone' },
        { cue: 'shine', region: 't_zone', severity: 'moderate', confidence: 'med', evidence: 't-zone reflectance' },
      ],
    },
    imageBuffer: Buffer.from('image-bytes-2'),
  });

  const keys = Object.keys(dto).sort();
  for (const key of [
    'input_hash',
    'concern_rank',
    'deterministic_signals',
    'routine_summary',
    'constraints',
    'open_questions',
    'photo_quality',
    'uncertainty_level',
    'vision_cues',
  ]) {
    assert.equal(keys.includes(key), true);
  }
  assert.equal(keys.includes('lang'), false);
  assert.equal(keys.includes('locked_features_summary'), false);
  assert.deepEqual(
    dto.vision_cues,
    [
      { cue: 'redness', region: 'cheeks', severity: 'mild', confidence: 'high', evidence: 'pink tone' },
      { cue: 'shine', region: 't_zone', severity: 'moderate', confidence: 'med', evidence: 't-zone reflectance' },
    ],
  );

  const size = Buffer.byteLength(JSON.stringify(dto), 'utf8');
  assert.ok(size < 1400, `dto size too large: ${size}`);
});

test('skin signals dto: deepening dto removes locale/profile text and canonicalizes reactions/advice', () => {
  const dto = buildDeepeningSignalsDto({
    lang: 'zh-CN',
    phase: 'reactions',
    questionIntent: 'reaction_check',
    photoChoice: 'uploaded',
    productsSubmitted: true,
    profileSummary: { goals: ['calm redness'] },
    routineCandidate: 'retinoid pm',
    reactions: ['stinging', 'unknown', 'redness'],
    summaryPriority: 'barrier',
    watchouts: ['pause_if_stinging'],
    twoWeekFocus: ['track_redness'],
    qualityObject: { grade: 'pass' },
  });

  assert.equal('lang' in dto, false);
  assert.equal('profile' in dto, false);
  assert.equal('quality' in dto, false);
  assert.deepEqual(dto.reaction_flags, ['stinging', 'redness']);
  assert.deepEqual(dto.suggested_advice_items, ['pause_if_stinging', 'track_redness']);
});
