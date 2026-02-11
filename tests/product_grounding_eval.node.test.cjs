const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { _internals } = require('../src/services/productGroundingResolver');

function loadGolden() {
  const p = path.resolve(__dirname, 'fixtures', 'product_grounding', 'golden_v1.json');
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schema_version, 'pivota.product_grounding.golden.v1');
  const cases = Array.isArray(parsed.cases) ? parsed.cases : [];
  assert.ok(cases.length >= 5);
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

test('product grounding golden: accuracy + MRR sanity', (t) => {
  const cases = loadGolden();

  const k = 3;
  let resolvedCases = 0;
  let resolvedDecisionCount = 0;
  let top1Correct = 0;
  let recallAtK = 0;
  let mrrSum = 0;

  for (const c of cases) {
    const query = String(c?.query || '').trim();
    const lang = String(c?.lang || 'en').trim().toLowerCase() === 'cn' ? 'cn' : 'en';
    const candidates = Array.isArray(c?.candidates) ? c.candidates : [];
    const expectResolved = Boolean(c?.expect && c.expect.resolved === true);
    const expectedKey = expectResolved ? keyOfRef(c.expect.product_ref) : '';

    const ranked = _internals.scoreAndRankCandidates({
      query,
      lang,
      products: candidates,
      options: { allow_external_seed: true },
    });
    const scored = Array.isArray(ranked?.scored) ? ranked.scored : [];
    const decision = _internals.resolveFromRankedCandidates({ ranked: scored, options: {} });

    if (!expectResolved) {
      assert.equal(decision.resolved, false, `expected unresolved for case=${c.id || query}`);
      continue;
    }

    resolvedCases += 1;
    assert.ok(expectedKey, `expected product_ref missing for case=${c.id || query}`);
    if (decision.resolved) resolvedDecisionCount += 1;

    const top1 = getTopRefs(scored, 1)[0] || '';
    if (top1 && top1 === expectedKey) top1Correct += 1;

    const topK = getTopRefs(scored, k);
    if (topK.includes(expectedKey)) recallAtK += 1;

    const idx = scored.findIndex((x) => keyOfRef(x?.product_ref) === expectedKey);
    if (idx >= 0) mrrSum += 1 / (idx + 1);
  }

  const top1Acc = resolvedCases ? top1Correct / resolvedCases : 0;
  const recallK = resolvedCases ? recallAtK / resolvedCases : 0;
  const mrr = resolvedCases ? mrrSum / resolvedCases : 0;
  const resolvedCoverage = resolvedCases ? resolvedDecisionCount / resolvedCases : 0;

  t.diagnostic(
    `golden_eval resolved_cases=${resolvedCases} resolved_coverage=${resolvedCoverage.toFixed(4)} top1=${top1Acc.toFixed(4)} recall@${k}=${recallK.toFixed(4)} mrr=${mrr.toFixed(4)}`,
  );

  // This fixture is intentionally small and hand-checked.
  // Keep accuracy thresholds strict while allowing confidence-threshold deferrals.
  assert.ok(resolvedCoverage >= 0.7, `resolvedCoverage too low: ${resolvedCoverage}`);
  assert.ok(top1Acc >= 0.85, `top1Acc too low: ${top1Acc}`);
  assert.ok(recallK >= 0.95, `recall@${k} too low: ${recallK}`);
  assert.ok(mrr >= 0.9, `mrr too low: ${mrr}`);
});
