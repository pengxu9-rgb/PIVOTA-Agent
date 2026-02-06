const test = require('node:test');
const assert = require('node:assert/strict');

const { assignExperiments, hashToBucket0to99 } = require('../src/auroraBff/experiments');

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function findRequestIdForBucket(expId, predicate, { limit = 5000 } = {}) {
  for (let i = 0; i < limit; i += 1) {
    const requestId = `req_${i}`;
    const bucket = hashToBucket0to99(`${expId}:${requestId}`);
    if (predicate(bucket)) return { requestId, bucket };
  }
  throw new Error('bucket_not_found');
}

test('Experiments: empty when env missing', () => {
  withEnv({ AURORA_EXPERIMENTS_JSON: undefined }, () => {
    const res = assignExperiments({ requestId: 'req_1' });
    assert.deepEqual(res.assignments, []);
    assert.deepEqual(res.byKind, {});
  });
});

test('Experiments: deterministic assignment for same request_id', () => {
  const cfg = JSON.stringify([
    {
      id: 'qgate_1',
      kind: 'quality_gate',
      variants: { control: 50, treatment: 50 },
      params: {
        control: { fail: { min_quality_factor: 0.25 } },
        treatment: { fail: { min_quality_factor: 0.35 } },
      },
    },
  ]);

  withEnv({ AURORA_EXPERIMENTS_JSON: cfg }, () => {
    const r1 = assignExperiments({ requestId: 'stable_req' });
    const r2 = assignExperiments({ requestId: 'stable_req' });
    assert.equal(r1.assignments.length, 1);
    assert.equal(r2.assignments.length, 1);
    assert.equal(r1.assignments[0].variant, r2.assignments[0].variant);
    assert.equal(r1.byKind.quality_gate.variant, r2.byKind.quality_gate.variant);
  });
});

test('Experiments: holdout when weights sum < 100', () => {
  const expId = 'holdout_exp';
  const cfg = JSON.stringify([
    {
      id: expId,
      kind: 'quality_gate',
      variants: { a: 10, b: 10 },
      params: { a: { fail: { min_quality_factor: 0.25 } }, b: { fail: { min_quality_factor: 0.3 } } },
    },
  ]);

  const { requestId } = findRequestIdForBucket(expId, (b) => b >= 20);
  withEnv({ AURORA_EXPERIMENTS_JSON: cfg }, () => {
    const res = assignExperiments({ requestId });
    assert.equal(res.assignments.length, 1);
    assert.equal(res.assignments[0].variant, 'holdout');
    assert.equal(res.byKind.quality_gate.variant, 'holdout');
  });
});

test('Experiments: weights normalize when sum > 100 (no holdout)', () => {
  const expId = 'normalize_exp';
  const cfg = JSON.stringify([
    {
      id: expId,
      kind: 'llm_prompt',
      variants: { a: 60, b: 60 },
      params: { a: { prompt_version: 'v1' }, b: { prompt_version: 'v2' } },
    },
  ]);

  const { requestId, bucket } = findRequestIdForBucket(expId, (b) => b >= 50);
  withEnv({ AURORA_EXPERIMENTS_JSON: cfg }, () => {
    const res = assignExperiments({ requestId });
    assert.equal(res.assignments.length, 1);
    assert.equal(res.assignments[0].bucket, bucket);
    assert.equal(res.assignments[0].reason, 'normalized');
    assert.equal(res.assignments[0].variant, 'b');
  });
});

test('Experiments: last experiment wins per kind (byKind)', () => {
  const cfg = JSON.stringify([
    { id: 'qgate_old', kind: 'quality_gate', variants: { a: 100 }, params: { a: { fail: { min_quality_factor: 0.2 } } } },
    { id: 'qgate_new', kind: 'quality_gate', variants: { b: 100 }, params: { b: { fail: { min_quality_factor: 0.4 } } } },
  ]);

  withEnv({ AURORA_EXPERIMENTS_JSON: cfg }, () => {
    const res = assignExperiments({ requestId: 'req' });
    assert.equal(res.assignments.length, 2);
    assert.equal(res.byKind.quality_gate.experiment_id, 'qgate_new');
    assert.equal(res.byKind.quality_gate.variant, 'b');
  });
});

