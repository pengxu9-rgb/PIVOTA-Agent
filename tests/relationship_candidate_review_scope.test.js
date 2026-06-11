// Review scope-to-build-anchors: lets a targeted/manifest build be reviewed in the SAME pass (review
// scoped to the anchors the build produced) instead of the global top-N-by-score backlog.

const mod = require('../scripts/review-relationship-candidate-labels');

describe('review scope-to-build-anchors', () => {
  test('parseArgs reads --anchor-refs-file and --anchor-refs-from-build', () => {
    const p = mod.parseArgs([
      '--cutoff', '2026-01-01T00:00:00Z',
      '--anchor-refs-from-build', '/tmp/build.json',
      '--anchor-refs-file', '/tmp/refs.txt',
    ]);
    expect(p.anchorRefsFromBuild).toBe('/tmp/build.json');
    expect(p.anchorRefsFile).toBe('/tmp/refs.txt');
  });

  test('fetchCandidates scopes the query by anchor_ref when anchorRefs provided', async () => {
    let captured = null;
    const queryFn = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
    await mod.fetchCandidates({ cutoff: '2026-01-01', minScore: 0, limit: 10, anchorRefs: ['product:pg_x', 'product:pg_y'], queryFn });
    expect(captured.sql).toMatch(/lower\(anchor_ref\) = ANY/);
    expect(captured.params).toContainEqual(['product:pg_x', 'product:pg_y']);
  });

  test('NO REGRESSION: fetchCandidates does not scope by anchor_ref when none given', async () => {
    let captured = null;
    const queryFn = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
    await mod.fetchCandidates({ cutoff: '2026-01-01', minScore: 0, limit: 10, queryFn });
    expect(captured.sql).not.toMatch(/lower\(anchor_ref\) = ANY/);
  });

  test('runReview derives anchor scope from a build report and applies it to the candidate query', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const buildReport = path.join(os.tmpdir(), `rev_scope_build_${process.pid}.json`);
    fs.writeFileSync(buildReport, JSON.stringify({ edges: [
      { anchor_ref: 'product:pg_AAA', candidate_product_ref: 'product:pg_BBB' },
      { anchor_ref: 'product:pg_AAA', candidate_product_ref: 'product:pg_CCC' },
      { anchor_ref: 'product:pg_DDD', candidate_product_ref: 'product:pg_EEE' },
    ] }));
    let candidateQuery = null;
    const queryFn = async (sql, params) => {
      if (/label_state = 'generated'/.test(sql)) candidateQuery = { sql, params };
      return { rows: [] }; // no candidates -> no LLM calls
    };
    await mod.runReview({ cutoff: '2026-01-01', minScore: 0, limit: 50, anchorRefsFromBuild: buildReport, queryFn });
    fs.unlinkSync(buildReport);
    expect(candidateQuery).not.toBeNull();
    expect(candidateQuery.sql).toMatch(/lower\(anchor_ref\) = ANY/);
    // distinct, lowercased anchor_refs from the build report
    const scopeParam = candidateQuery.params.find((p) => Array.isArray(p) && p.includes('product:pg_aaa'));
    expect(scopeParam).toEqual(expect.arrayContaining(['product:pg_aaa', 'product:pg_ddd']));
    expect(scopeParam).toHaveLength(2); // pg_AAA deduped
  });

  test('FAIL CLOSED: a requested scope that resolves empty reviews NOTHING (not the global backlog)', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const buildReport = path.join(os.tmpdir(), `rev_scope_empty_${process.pid}.json`);
    fs.writeFileSync(buildReport, JSON.stringify({ edges: [] })); // a build that produced 0 edges
    let candidateQueryIssued = false;
    const queryFn = async (sql) => {
      if (/label_state = 'generated'/.test(sql)) candidateQueryIssued = true;
      return { rows: [] };
    };
    const r = await mod.runReview({ cutoff: '2026-01-01', minScore: 0, limit: 50, anchorRefsFromBuild: buildReport, queryFn });
    fs.unlinkSync(buildReport);
    // never queried the global backlog; scope was requested; reviewed nothing
    expect(candidateQueryIssued).toBe(false);
    expect(r.summary.anchor_refs_scope_requested).toBe(true);
    expect(r.summary.anchor_refs_scope_count).toBe(0);
    expect(r.summary.reviewed_count).toBe(0);
  });

  test('NO requested scope => not fail-closed (queries global as before)', async () => {
    let candidateQueryIssued = false;
    const queryFn = async (sql) => {
      if (/label_state = 'generated'/.test(sql)) candidateQueryIssued = true;
      return { rows: [] };
    };
    const r = await mod.runReview({ cutoff: '2026-01-01', minScore: 0, limit: 50, queryFn });
    expect(candidateQueryIssued).toBe(true); // no scope requested => global selection (unchanged)
    expect(r.summary.anchor_refs_scope_requested).toBe(false);
  });
});
