const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

const { resetVisionMetrics, snapshotVisionMetrics } = require('../src/auroraBff/visionMetrics');

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('normalizeClarificationField: maps common skinType ids (ASCII/CN) to canonical field', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    assert.equal(__internal.normalizeClarificationField('skin_type'), 'skinType');
    assert.equal(__internal.normalizeClarificationField('皮肤类型'), 'skinType');
    assert.equal(__internal.normalizeClarificationField('肤质:油皮'), 'skinType');
  } finally {
    delete require.cache[moduleId];
  }
});

test('normalizeClarificationField: never returns empty; falls back to stable hash + emits metric', () => {
  resetVisionMetrics();

  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out1 = __internal.normalizeClarificationField('!!!');
    const out2 = __internal.normalizeClarificationField('');
    const out3 = __internal.normalizeClarificationField(null);

    for (const out of [out1, out2, out3]) {
      assert.equal(typeof out, 'string');
      assert.ok(out.length > 0);
      assert.match(out, /^cid_[a-z0-9]+$/);
    }
  } finally {
    delete require.cache[moduleId];
  }

  const snap = snapshotVisionMetrics();
  assert.ok(Number(snap.clarificationIdNormalizedEmptyCount) >= 3);
});

