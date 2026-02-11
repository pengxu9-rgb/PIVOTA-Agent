const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { _internals } = require('../src/services/productGroundingResolver');

function fixturePath(version) {
  return path.resolve(__dirname, 'fixtures', 'product_grounding', `golden_${version}.json`);
}

function loadGolden(version) {
  const raw = fs.readFileSync(fixturePath(version), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schema_version, `pivota.product_grounding.golden.${version}`);
  const cases = Array.isArray(parsed.cases) ? parsed.cases : [];
  assert.ok(cases.length >= 5, `golden_${version}.json should contain at least 5 cases`);
  return cases;
}

function keyOfRef(ref) {
  const mid = String(ref?.merchant_id || '').trim();
  const pid = String(ref?.product_id || '').trim();
  return mid && pid ? `${mid}::${pid}` : '';
}

function getTopRefs(scored, k) {
  const out = [];
  for (const item of scored || []) {
    const ref = item?.product_ref;
    const key = keyOfRef(ref);
    if (!key) continue;
    out.push(key);
    if (out.length >= k) break;
  }
  return out;
}

function formatMismatchExcerpt(mismatches, limit = 5) {
  const list = Array.isArray(mismatches) ? mismatches.slice(0, limit) : [];
  if (!list.length) return 'no_case_mismatch_excerpt';
  const parts = [];
  for (const item of list) {
    parts.push(
      `[${item.id}] expected=${item.expected} top1=${item.top1 || '-'} decision=${item.decision || '-'} top3=${item.top3 || '-'}`,
    );
  }
  return parts.join('\n');
}

function evaluateSuite({ cases, scoringVersion, k }) {
  let resolvedCases = 0;
  let resolvedDecisionCount = 0;
  let top1Correct = 0;
  let recallAtK = 0;
  let mrrSum = 0;
  const mismatches = [];

  for (const c of cases) {
    const query = String(c?.query || '').trim();
    const lang = String(c?.lang || 'en').trim().toLowerCase() === 'cn' ? 'cn' : 'en';
    const candidates = Array.isArray(c?.candidates) ? c.candidates : [];
    const expectResolved = Boolean(c?.expect && c.expect.resolved === true);
    const expectedKey = expectResolved ? keyOfRef(c.expect.product_ref) : '';
    const caseId = String(c?.id || query || 'unknown_case');

    const ranked = _internals.scoreAndRankCandidates({
      query,
      lang,
      products: candidates,
      options: { allow_external_seed: true, scoring_version: scoringVersion },
    });
    const scored = Array.isArray(ranked?.scored) ? ranked.scored : [];
    const decision = _internals.resolveFromRankedCandidates({
      ranked: scored,
      options: { scoring_version: scoringVersion },
    });

    if (!expectResolved) {
      if (decision.resolved) {
        mismatches.push({
          id: caseId,
          expected: 'unresolved',
          top1: getTopRefs(scored, 1)[0] || '',
          top3: getTopRefs(scored, k).join(','),
          decision: decision.reason || 'resolved',
        });
      }
      continue;
    }

    resolvedCases += 1;
    assert.ok(expectedKey, `expected product_ref missing for case=${caseId}`);
    if (decision.resolved) resolvedDecisionCount += 1;

    const top1 = getTopRefs(scored, 1)[0] || '';
    if (top1 && top1 === expectedKey) {
      top1Correct += 1;
    } else {
      mismatches.push({
        id: caseId,
        expected: expectedKey,
        top1,
        top3: getTopRefs(scored, k).join(','),
        decision: decision.reason || '',
      });
    }

    const topK = getTopRefs(scored, k);
    if (topK.includes(expectedKey)) recallAtK += 1;

    const idx = scored.findIndex((x) => keyOfRef(x?.product_ref) === expectedKey);
    if (idx >= 0) mrrSum += 1 / (idx + 1);
  }

  const top1Acc = resolvedCases ? top1Correct / resolvedCases : 0;
  const recallK = resolvedCases ? recallAtK / resolvedCases : 0;
  const mrr = resolvedCases ? mrrSum / resolvedCases : 0;
  const resolvedCoverage = resolvedCases ? resolvedDecisionCount / resolvedCases : 0;

  return {
    k,
    resolvedCases,
    resolvedCoverage,
    top1Acc,
    recallK,
    mrr,
    mismatches,
  };
}

function runGoldenSuite(t, { suiteName, fixtureVersion, scoringVersion, thresholds }) {
  const cases = loadGolden(fixtureVersion);
  const result = evaluateSuite({ cases, scoringVersion, k: 3 });
  t.diagnostic(
    `${suiteName} resolved_cases=${result.resolvedCases} resolved_coverage=${result.resolvedCoverage.toFixed(4)} top1=${result.top1Acc.toFixed(4)} recall@3=${result.recallK.toFixed(4)} mrr=${result.mrr.toFixed(4)}`,
  );

  if (result.mismatches.length > 0) {
    t.diagnostic(`${suiteName} mismatch_excerpt:\n${formatMismatchExcerpt(result.mismatches)}`);
  }

  const errors = [];
  if (result.resolvedCoverage < thresholds.resolvedCoverage) {
    errors.push(`resolvedCoverage=${result.resolvedCoverage.toFixed(4)} < ${thresholds.resolvedCoverage}`);
  }
  if (result.top1Acc < thresholds.top1) {
    errors.push(`top1=${result.top1Acc.toFixed(4)} < ${thresholds.top1}`);
  }
  if (result.recallK < thresholds.recallAt3) {
    errors.push(`recall@3=${result.recallK.toFixed(4)} < ${thresholds.recallAt3}`);
  }
  if (result.mrr < thresholds.mrr) {
    errors.push(`mrr=${result.mrr.toFixed(4)} < ${thresholds.mrr}`);
  }

  if (errors.length) {
    assert.fail(`${suiteName} failed thresholds:\n${errors.join('\n')}\n${formatMismatchExcerpt(result.mismatches)}`);
  }
}

test('product grounding golden v1 regression', (t) => {
  runGoldenSuite(t, {
    suiteName: 'golden_v1',
    fixtureVersion: 'v1',
    scoringVersion: 'v1',
    thresholds: {
      resolvedCoverage: 0.7,
      top1: 0.85,
      recallAt3: 0.95,
      mrr: 0.9,
    },
  });
});

test('product grounding golden v2 accuracy', (t) => {
  runGoldenSuite(t, {
    suiteName: 'golden_v2',
    fixtureVersion: 'v2',
    scoringVersion: 'v2',
    thresholds: {
      resolvedCoverage: 0.75,
      top1: 0.85,
      recallAt3: 0.95,
      mrr: 0.9,
    },
  });
});
