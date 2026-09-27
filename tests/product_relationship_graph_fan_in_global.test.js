// Global (whole-graph) fan-in cap. Peng, 2026-09-27: the cap must hold across the stored graph,
// not per build, before relationship-graph writes are turned on.
const {
  DEFAULT_MAX_ANCHORS_PER_CANDIDATE,
  DEFAULT_QUEUED_FRESH_DAYS,
  COUNTED_LABEL_STATES,
  UNWRITABLE_LABEL_STATES,
  LIVE_LABEL_STATES,
  capCandidateFanInGlobal,
  fanInLockKey,
  loadExistingAnchorsByCandidate,
  loadStoredAnchorsByCandidate,
  loadFanInCensus,
} = require('../src/auroraBff/relationshipFanIn');
const { persistEdgesWithGlobalFanInCap } = require('../scripts/build-product-relationship-graph');
const { upsertRelationshipCandidateLabel } = require('../src/auroraBff/productRelationshipGraph');

// A stored row as the loader's query returns it.
const storedRow = (anchor, label_state = 'ai_approved', { unexpired = true, fresh = true } = {}) => ({ candidate_ref: 'product:hub', anchor_ref: anchor, label_state, unexpired, fresh });

const NOW = '2026-09-27T00:00:00.000Z';

function edge(anchor, candidate, overrides = {}) {
  return {
    id: `prel_${anchor}_${candidate}`,
    anchor_type: 'product',
    anchor_ref: `product:${anchor}`,
    anchor_snapshot: { brand: `Brand ${anchor}`, name: `${anchor} Cream`, category: 'cream', price: 60 },
    candidate_product_ref: `product:${candidate}`,
    candidate_snapshot: { brand: 'ALBION', name: 'Excia Cream', category: 'cream', price: 90 },
    relation_type: 'competitive_alternative',
    market: 'US',
    category_taxonomy: ['skincare', 'cream'],
    use_case: 'cream',
    score_total: 0.8,
    score_breakdown: { category_use_case_match: 0.72 },
    price_evidence: { anchor_price_amount: 60, candidate_price_amount: 90, price_ratio: 1.5, observed_at: NOW },
    source_refs: [{ type: 'catalog_products', authoritative: true }],
    evidence_grade: 'B',
    review_status: 'pending',
    ...overrides,
  };
}

const existing = (map) => new Map(Object.entries(map).map(([k, v]) => [k, new Set(v)]));

describe('capCandidateFanInGlobal', () => {
  test('allows only (cap - existing) new anchors, best score first, ties on anchor_ref', () => {
    const edges = [
      edge('a1', 'hub', { score_total: 0.9 }),
      edge('a2', 'hub', { score_total: 0.85 }),
      edge('a3', 'hub', { score_total: 0.85 }),
      edge('a4', 'hub', { score_total: 0.7 }),
      edge('a5', 'hub', { score_total: 0.95 }),
    ];
    const out = capCandidateFanInGlobal(edges, existing({ 'product:hub': ['product:x1', 'product:x2', 'product:x3', 'product:x4', 'product:x5', 'product:x6'] }), { cap: 8 });

    expect(out.kept.map((e) => e.anchor_ref)).toEqual(['product:a1', 'product:a5']);
    expect(out.dropped.map((row) => row.anchor_ref)).toEqual(['product:a2', 'product:a3', 'product:a4']);
    expect(out.dropped[0]).toEqual(expect.objectContaining({ errors: ['candidate_fan_in_cap_global'], metrics: expect.objectContaining({ existing_anchors: 6, allowed_new: 2, cap: 8 }) }));
    expect(out.max_existing_anchors).toBe(6);
    expect(out.max_fan_in_global_before_cap).toBe(11);
    expect(out.candidates_checked).toBe(1);
  });

  test('anchors this build re-emits are not new and never count against it', () => {
    const edges = [edge('a1', 'hub', { score_total: 0.6 }), edge('a2', 'hub', { score_total: 0.9 }), edge('a3', 'hub', { score_total: 0.5 })];
    // 8 existing anchors, but two of them are a1 and a3 (re-emitted): only a2 is new, budget is 8 - 6 = 2.
    const out = capCandidateFanInGlobal(edges, existing({ 'product:hub': ['product:a1', 'product:a3', 'product:x1', 'product:x2', 'product:x3', 'product:x4', 'product:x5', 'product:x6'] }), { cap: 8 });
    expect(out.kept.map((e) => e.anchor_ref)).toEqual(['product:a1', 'product:a2', 'product:a3']);
    expect(out.dropped).toEqual([]);
  });

  test('a candidate already at the cap gets no new anchors; one over the cap is not trimmed here', () => {
    const edges = [edge('a1', 'hub'), edge('a2', 'hub')];
    const out = capCandidateFanInGlobal(edges, existing({ 'product:hub': Array.from({ length: 11 }, (_, i) => `product:x${i}`) }), { cap: 8 });
    expect(out.kept).toEqual([]);
    expect(out.dropped).toHaveLength(2);
    expect(out.dropped[0].metrics.allowed_new).toBe(0);
  });

  test('accepts: related_product and niche_specialist are never capped; the cap is configurable', () => {
    const edges = [
      edge('a1', 'hub', { relation_type: 'related_product' }),
      edge('a2', 'hub', { relation_type: 'niche_specialist', anchor_type: 'need' }),
      edge('a3', 'hub', { relation_type: 'dupe', score_total: 0.9 }),
      edge('a4', 'hub', { score_total: 0.8 }),
    ];
    const out = capCandidateFanInGlobal(edges, existing({ 'product:hub': ['product:x1', 'product:x2'] }), { cap: 3 });
    expect(out.kept.map((e) => e.anchor_ref)).toEqual(['product:a1', 'product:a2', 'product:a3']);
    expect(out.dropped.map((row) => row.anchor_ref)).toEqual(['product:a4']);
    expect(DEFAULT_MAX_ANCHORS_PER_CANDIDATE).toBe(8);
    expect(capCandidateFanInGlobal(edges, new Map()).cap).toBe(8);
  });

  test('equal scores break on anchor_ref, so the kept set is the same for any input order', () => {
    const stored = existing({ 'product:hub': Array.from({ length: 6 }, (_, i) => `product:x${i}`) });
    const forward = ['a3', 'a1', 'a2'].map((a) => edge(a, 'hub', { score_total: 0.8 }));
    const reversed = [...forward].reverse();
    const kept = (rows) => capCandidateFanInGlobal(rows, stored, { cap: 8 }).kept.map((e) => e.anchor_ref).sort();
    expect(kept(forward)).toEqual(['product:a1', 'product:a2']);
    expect(kept(reversed)).toEqual(kept(forward));
  });

  test('anchors whose stored row a builder write cannot change are skipped: no slot, no write', () => {
    const stored = new Map([['product:hub', {
      counted: new Set(['product:x1', 'product:x2', 'product:x3', 'product:x4', 'product:x5', 'product:x6', 'product:x7']),
      unwritable: new Set(['product:x1', 'product:rejected_anchor']),
    }]]);
    const edges = [edge('rejected_anchor', 'hub', { score_total: 0.99 }), edge('n1', 'hub', { score_total: 0.9 }), edge('n2', 'hub', { score_total: 0.8 })];
    const out = capCandidateFanInGlobal(edges, stored, { cap: 8 });
    expect(out.kept.map((e) => e.anchor_ref)).toEqual(['product:n1']);
    expect(out.skipped).toEqual([expect.objectContaining({ anchor_ref: 'product:rejected_anchor', errors: ['stored_row_not_writable'] })]);
    expect(out.dropped.map((row) => row.anchor_ref)).toEqual(['product:n2']);
    expect(out.max_fan_in_global_before_cap).toBe(9);
  });

  test('candidate refs match case-insensitively', () => {
    const out = capCandidateFanInGlobal([edge('a1', 'HUB')], existing({ 'product:hub': Array.from({ length: 8 }, (_, i) => `product:x${i}`) }));
    expect(out.kept).toEqual([]);
  });
});

describe('loadExistingAnchorsByCandidate', () => {
  test('counts live and queued, unexpired dupe / competitive_alternative rows for the market', async () => {
    const calls = [];
    const queryFn = async (text, params) => {
      calls.push({ text, params });
      return { rows: [
        storedRow('product:x1', 'ai_approved'),
        storedRow('product:X1', 'ai_approved'),
        storedRow('product:x2', 'human_approved'),
        storedRow('product:x3', 'generated', { fresh: true }),
        storedRow('product:x4', 'human_rejected'),
      ] };
    };
    const out = await loadExistingAnchorsByCandidate({ candidateRefs: ['product:HUB', 'product:hub', 'product:other'], market: 'US', queryFn });

    expect(out.get('product:hub')).toEqual(new Set(['product:x1', 'product:x2', 'product:x3']));
    expect(out.has('product:other')).toBe(false);
    expect(calls).toHaveLength(1);
    const { text, params } = calls[0];
    expect(text).toMatch(/FROM relationship_candidate_labels/);
    expect(text).toMatch(/expires_at IS NULL OR expires_at > now\(\)\) AS unexpired/);
    expect(text).toMatch(/updated_at >= now\(\) - make_interval\(days => \$5::int\)\) AS fresh/);
    expect(text).toMatch(/anchor_type = 'product'/);
    expect(params[0]).toBe('us');
    expect(params[1].sort()).toEqual(['competitive_alternative', 'dupe']);
    expect(params[2]).toEqual(['product:hub', 'product:other']);
    expect(params[3].sort()).toEqual([...new Set([...COUNTED_LABEL_STATES, ...UNWRITABLE_LABEL_STATES])].sort());
    expect(params[4]).toBe(DEFAULT_QUEUED_FRESH_DAYS);
    expect(DEFAULT_QUEUED_FRESH_DAYS).toBe(14);
    expect(COUNTED_LABEL_STATES).toEqual(['human_approved', 'ai_approved', 'generated', 'review_ready']);
    expect(LIVE_LABEL_STATES).toEqual(['human_approved', 'ai_approved']);
    expect(UNWRITABLE_LABEL_STATES).toEqual(['human_approved', 'ai_approved', 'human_rejected', 'needs_evidence']);
  });

  test('a queued row counts only while fresh; a serving row counts by expiry; expired rows never count', async () => {
    const queryFn = async () => ({ rows: [
      storedRow('product:old_generated', 'generated', { fresh: false }),
      storedRow('product:fresh_generated', 'generated', { fresh: true }),
      storedRow('product:old_review_ready', 'review_ready', { fresh: false }),
      storedRow('product:stale_but_serving', 'ai_approved', { fresh: false }),
      storedRow('product:expired_serving', 'human_approved', { unexpired: false, fresh: false }),
      storedRow('product:rejected', 'human_rejected', { fresh: true }),
      storedRow('product:needs', 'needs_evidence', { fresh: true }),
    ] });
    const stored = await loadStoredAnchorsByCandidate({ candidateRefs: ['product:hub'], queryFn, queuedFreshDays: 14 });
    const entry = stored.get('product:hub');
    expect([...entry.counted].sort()).toEqual(['product:fresh_generated', 'product:stale_but_serving']);
    expect([...entry.unwritable].sort()).toEqual(['product:expired_serving', 'product:needs', 'product:rejected', 'product:stale_but_serving']);
  });

  test('the freshness window is configurable and bounded', async () => {
    const calls = [];
    const queryFn = async (text, params) => { calls.push(params); return { rows: [] }; };
    await loadStoredAnchorsByCandidate({ candidateRefs: ['product:hub'], queryFn, queuedFreshDays: 30 });
    await loadStoredAnchorsByCandidate({ candidateRefs: ['product:hub'], queryFn, queuedFreshDays: 0 });
    await loadStoredAnchorsByCandidate({ candidateRefs: ['product:hub'], queryFn, queuedFreshDays: 9999 });
    expect(calls.map((params) => params[4])).toEqual([30, 14, 365]);
  });

  test('fails open to no existing anchors without a database, and asks nothing for no refs', async () => {
    const noDb = async () => { const err = new Error('no db'); err.code = 'NO_DATABASE'; throw err; };
    expect((await loadExistingAnchorsByCandidate({ candidateRefs: ['product:hub'], queryFn: noDb })).size).toBe(0);
    let asked = 0;
    expect((await loadExistingAnchorsByCandidate({ candidateRefs: [], queryFn: async () => { asked += 1; return { rows: [] }; } })).size).toBe(0);
    expect(asked).toBe(0);
    await expect(loadExistingAnchorsByCandidate({ candidateRefs: ['product:hub'], queryFn: async () => { throw new Error('boom'); } })).rejects.toThrow('boom');
  });
});

describe('persistEdgesWithGlobalFanInCap (write path)', () => {
  function fakeDb({ existingRows = [] } = {}) {
    const log = [];
    const client = {
      query: async (text, params) => {
        log.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
        if (/FROM relationship_candidate_labels/.test(text)) return { rows: existingRows };
        return { rows: [] };
      },
    };
    const direct = async (text, params) => { log.push({ text: `DIRECT ${String(text).replace(/\s+/g, ' ').trim()}`, params }); return { rows: [] }; };
    return { log, client, runInClient: async (fn) => fn(client), queryFn: direct };
  }

  test('one transaction per candidate: lock, recount, upsert only the allowed anchors, commit', async () => {
    const db = fakeDb({ existingRows: Array.from({ length: 7 }, (_, i) => storedRow(`product:x${i}`, 'ai_approved')) });
    const edges = [
      edge('a1', 'hub', { score_total: 0.7 }),
      edge('a2', 'hub', { score_total: 0.9 }),
      edge('s1', 'hub', { relation_type: 'related_product', score_total: 0.5 }),
    ];
    const out = await persistEdgesWithGlobalFanInCap({ edges, market: 'US', cap: 8, runInClient: db.runInClient, queryFn: db.queryFn });

    expect(out.applied).toBe(2);
    expect(out.dropped).toEqual([expect.objectContaining({ anchor_ref: 'product:a1', errors: ['candidate_fan_in_cap_global'] })]);
    const kinds = db.log.map((row) => (row.text.startsWith('DIRECT') ? 'direct-upsert'
      : row.text === 'BEGIN' ? 'begin'
        : /pg_advisory_xact_lock/.test(row.text) ? 'lock'
          : /FROM relationship_candidate_labels/.test(row.text) ? 'count'
            : /INSERT INTO relationship_candidate_labels/.test(row.text) ? 'upsert'
              : row.text));
    expect(kinds).toEqual(['direct-upsert', 'begin', 'lock', 'count', 'upsert', 'COMMIT']);
    expect(db.log[2].params).toEqual([fanInLockKey('product:hub')]);
    const upsertRow = db.log.find((row) => !row.text.startsWith('DIRECT') && /INSERT INTO relationship_candidate_labels/.test(row.text));
    expect(upsertRow.params).toContain('product:a2');
    expect(upsertRow.params).not.toContain('product:a1');
  });

  test('rolls back and rethrows when an upsert inside the transaction fails', async () => {
    const db = fakeDb();
    const failing = { ...db.client, query: async (text, params) => { if (/INSERT INTO/.test(text)) throw new Error('insert failed'); return db.client.query(text, params); } };
    await expect(persistEdgesWithGlobalFanInCap({ edges: [edge('a1', 'hub')], cap: 8, runInClient: async (fn) => fn(failing), queryFn: db.queryFn })).rejects.toThrow('insert failed');
    expect(db.log.map((row) => row.text).filter((t) => t === 'BEGIN' || t === 'ROLLBACK' || t === 'COMMIT')).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('two builds writing the same candidate: the second sees the first one\'s rows and stops at the cap', async () => {
    const stored = [];
    const client = {
      query: async (text, params) => {
        if (/FROM relationship_candidate_labels/.test(text)) return { rows: stored.map((anchor) => storedRow(anchor, 'generated', { fresh: true })) };
        if (/INSERT INTO relationship_candidate_labels/.test(text)) stored.push(String(params[3]).toLowerCase());
        return { rows: [] };
      },
    };
    const run = (anchors) => persistEdgesWithGlobalFanInCap({ edges: anchors.map((a) => edge(a, 'hub')), cap: 8, runInClient: async (fn) => fn(client), queryFn: client.query });
    const first = await run(['b1', 'b2', 'b3', 'b4', 'b5']);
    const second = await run(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(first.applied).toBe(5);
    expect(second.applied).toBe(3);
    expect(second.dropped.map((row) => row.anchor_ref)).toEqual(['product:c4', 'product:c5']);
    expect(stored).toHaveLength(8);
  });
});

describe('persistEdgesWithGlobalFanInCap: classification first, only real writes count', () => {
  function recordingClient(existingRows = []) {
    const log = [];
    const client = { query: async (text, params) => { log.push({ text: String(text).replace(/\s+/g, ' ').trim(), params }); return /FROM relationship_candidate_labels/.test(text) ? { rows: existingRows } : { rows: [] }; } };
    return { log, client, runInClient: async (fn) => fn(client), queryFn: client.query };
  }
  const upserts = (db) => db.log.filter((row) => /INSERT INTO relationship_candidate_labels/.test(row.text));

  test('a prefilter_rejected edge takes no slot, so a viable lower-scored anchor still lands', async () => {
    const db = recordingClient(Array.from({ length: 7 }, (_, i) => storedRow(`product:x${i}`, 'ai_approved')));
    const edges = [edge('bad', 'hub', { score_total: 0.95 }), edge('good', 'hub', { score_total: 0.8 })];
    const classify = (e) => (e.anchor_ref === 'product:bad'
      ? { label_state: 'prefilter_rejected', prefilter_reasons: ['category_leaf_mismatch:x_vs_y'], bucket: 'rejected' }
      : { label_state: 'generated', prefilter_reasons: null, bucket: 'passed' });
    const out = await persistEdgesWithGlobalFanInCap({ edges, cap: 8, classify, runInClient: db.runInClient, queryFn: db.queryFn });
    expect(out.dropped).toEqual([]);
    expect(out.applied).toBe(2);
    const states = upserts(db).map((row) => [row.params[3], row.params[13]]);
    expect(states).toEqual(expect.arrayContaining([['product:good', 'generated'], ['product:bad', 'prefilter_rejected']]));
  });

  test('an anchor whose stored row is human_rejected / needs_evidence is neither new nor written; applied counts real writes only', async () => {
    const db = recordingClient([storedRow('product:r1', 'human_rejected'), storedRow('product:n1', 'needs_evidence'), ...Array.from({ length: 7 }, (_, i) => storedRow(`product:x${i}`, 'ai_approved'))]);
    const edges = [edge('r1', 'hub', { score_total: 0.99 }), edge('n1', 'hub', { score_total: 0.98 }), edge('new', 'hub', { score_total: 0.7 })];
    const out = await persistEdgesWithGlobalFanInCap({ edges, cap: 8, runInClient: db.runInClient, queryFn: db.queryFn });
    expect(out.applied).toBe(1);
    expect(out.skipped.map((row) => row.anchor_ref).sort()).toEqual(['product:n1', 'product:r1']);
    expect(out.dropped).toEqual([]);
    expect(upserts(db).map((row) => row.params[3])).toEqual(['product:new']);
  });

  test('a prefilter_rejected edge whose stored row is unwritable is skipped, not written, not counted as applied', async () => {
    const db = recordingClient([storedRow('product:a1', 'ai_approved')]);
    const classify = () => ({ label_state: 'prefilter_rejected', prefilter_reasons: ['x'], bucket: 'rejected' });
    const out = await persistEdgesWithGlobalFanInCap({ edges: [edge('a1', 'hub')], cap: 8, classify, runInClient: db.runInClient, queryFn: db.queryFn });
    expect(out.applied).toBe(0);
    expect(out.skipped).toEqual([expect.objectContaining({ anchor_ref: 'product:a1', errors: ['stored_row_not_writable'] })]);
    expect(upserts(db)).toEqual([]);
  });

  test('the in-lock recount is pinned to the build market', async () => {
    const db = recordingClient();
    await persistEdgesWithGlobalFanInCap({ edges: [edge('a1', 'hub', { market: 'JP' })], market: 'JP', cap: 8, runInClient: db.runInClient, queryFn: db.queryFn });
    const count = db.log.find((row) => /FROM relationship_candidate_labels/.test(row.text));
    expect(count.params[0]).toBe('jp');
  });
});

describe('label upsert guard: a lower-trust write never overwrites a serving state', () => {
  test('prefilter_rejected cannot replace a serving row, and only a human path can change human_approved', async () => {
    const calls = [];
    const queryFn = async (text, params) => { calls.push({ text: String(text).replace(/\s+/g, ' ').trim(), params }); return { rows: [] }; };
    await upsertRelationshipCandidateLabel({ ...edge('a1', 'hub'), label_state: 'prefilter_rejected', prefilter_reasons: ['x'] }, { queryFn });
    const sql = calls[0].text;
    expect(sql).toMatch(/relationship_candidate_labels\.label_state = ANY \( ARRAY\['human_approved', 'ai_approved', 'human_rejected', 'needs_evidence'\]::text\[\] \) AND EXCLUDED\.label_state = ANY \(ARRAY\['generated', 'review_ready', 'prefilter_rejected'\]::text\[\]\)/);
    expect(sql).toMatch(/relationship_candidate_labels\.label_state = 'human_approved' AND NOT \(EXCLUDED\.label_state = ANY \(ARRAY\['human_approved', 'human_rejected', 'needs_evidence'\]::text\[\]\)\)/);
  });
});

describe('loadFanInCensus (read-only)', () => {
  test('reports candidates over the cap for live and live+queued rows', async () => {
    const queryFn = async (text, params) => {
      expect(text).toMatch(/GROUP BY lower\(candidate_product_ref\)/);
      expect(params[1]).toEqual(LIVE_LABEL_STATES);
      expect(params[3]).toEqual(COUNTED_LABEL_STATES);
      expect(params[4]).toBe(14);
      expect(text).toMatch(/updated_at >= now\(\) - make_interval\(days => \$5::int\)/);
      return { rows: [
        { candidate_ref: 'product:hub', brand: 'ALBION', name: 'Excia Cream', live_anchors: '12', live_or_pending_anchors: '20' },
        { candidate_ref: 'product:mid', brand: 'B', name: 'Mid', live_anchors: '3', live_or_pending_anchors: '9' },
        { candidate_ref: 'product:low', brand: 'C', name: 'Low', live_anchors: '1', live_or_pending_anchors: '1' },
      ] };
    };
    const census = await loadFanInCensus({ market: 'us', cap: 8, queryFn, top: 2 });
    expect(census).toEqual(expect.objectContaining({
      market: 'US', cap: 8, candidates_with_edges: 3, over_cap_live: 1, over_cap_live_or_pending: 2,
      excess_edges_live: 4, excess_edges_live_or_pending: 13, max_live_anchors: 12, max_live_or_pending_anchors: 20,
    }));
    expect(census.top.map((row) => row.candidate_ref)).toEqual(['product:hub', 'product:mid']);
  });
});
