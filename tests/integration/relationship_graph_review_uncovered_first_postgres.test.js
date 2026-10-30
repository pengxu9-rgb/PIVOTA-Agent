const { Client } = require('pg');
const { fetchCandidates } = require('../../scripts/review-relationship-candidate-labels');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// 2026-10-20: the review queue can rank anchors with no served alternative first, so a night's reviews
// add coverage before depth. "Served" is the serving view's predicate: approved, verified, unexpired,
// for the same relation type and market.
suite('review queue: uncovered anchors first, on PostgreSQL', () => {
  let db; let schema;
  const queryFn = (sql, params) => db.query(sql, params);
  beforeAll(async () => {
    db = new Client({ connectionString: url }); await db.connect();
    schema = `rg_uncovered_first_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`); await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE relationship_candidate_labels(id text PRIMARY KEY, edge_id text, anchor_type text DEFAULT 'product',
        anchor_ref text, anchor_snapshot jsonb, candidate_product_ref text, candidate_snapshot jsonb,
        relation_type text DEFAULT 'competitive_alternative', display_label text, market text DEFAULT 'US',
        vertical text DEFAULT 'beauty', category_taxonomy text, use_case text, label_state text DEFAULT 'generated',
        score_total double precision, score_breakdown jsonb, price_evidence jsonb, source_refs jsonb, evidence_grade text,
        why_candidate jsonb, tradeoffs jsonb, watchouts jsonb, provenance jsonb,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
        last_verified_at timestamptz, expires_at timestamptz);
    `);
  });
  afterAll(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } });
  beforeEach(async () => { await db.query('TRUNCATE relationship_candidate_labels'); });

  async function label(id, anchor, score, { state = 'generated', relation = 'competitive_alternative', market = 'US',
    verified = true, expiresDays = 30 } = {}) {
    await db.query(`INSERT INTO relationship_candidate_labels(id, anchor_ref, candidate_product_ref, score_total, label_state,
      relation_type, market, last_verified_at, expires_at)
      VALUES($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END, now() + ($9::int * interval '1 day'))`,
    [id, anchor, `product:cand_${id}`, score, state, relation, market, verified, expiresDays]);
  }
  const ids = async (opts = {}) => (await fetchCandidates({ cutoff: '2026-01-01T00:00:00Z', minScore: 0, limit: 50, queryFn, ...opts }))
    .map((row) => row.id);

  test('uncovered anchors come first, one per anchor per round by score; covered anchors follow in score order', async () => {
    // covered: product:a has a served alternative
    await label('a_served', 'product:a', 0.9, { state: 'ai_approved' });
    await label('a1', 'product:a', 0.99); await label('a2', 'product:a', 0.95);
    // uncovered: b and c have none
    await label('b1', 'product:b', 0.80); await label('b2', 'product:b', 0.79);
    await label('c1', 'product:c', 0.75);
    expect(await ids()).toEqual(['a1', 'a2', 'b1', 'b2', 'c1']);
    expect(await ids({ uncoveredFirst: true })).toEqual(['b1', 'c1', 'b2', 'a1', 'a2']);
  });

  test('a served label counts only if verified, unexpired, of the same relation type and market', async () => {
    await label('x_unverified', 'product:x', 0.9, { state: 'ai_approved', verified: false });
    await label('y_expired', 'product:y', 0.9, { state: 'human_approved', expiresDays: -1 });
    await label('z_other_type', 'product:z', 0.9, { state: 'ai_approved', relation: 'related_product' });
    await label('w_other_market', 'product:w', 0.9, { state: 'ai_approved', market: 'SG' });
    await label('v_served', 'PRODUCT:V', 0.9, { state: 'human_approved', market: 'us' });
    for (const a of ['x', 'y', 'z', 'w', 'v']) await label(`${a}1`, `product:${a}`, a === 'v' ? 0.99 : 0.5);
    const order = await ids({ uncoveredFirst: true, relationTypes: ['competitive_alternative'] });
    expect(order[order.length - 1]).toBe('v1');
    expect(order.slice(0, 4).sort()).toEqual(['w1', 'x1', 'y1', 'z1']);
  });

  test('pages with OFFSET walk the same order without gaps or repeats', async () => {
    await label('a_served', 'product:a', 0.9, { state: 'ai_approved' });
    for (let i = 0; i < 7; i += 1) {
      await label(`a${i}`, 'product:a', 0.9 - i / 100);
      await label(`b${i}`, 'product:b', 0.8 - i / 100);
      await label(`c${i}`, 'product:c', 0.7 - i / 100);
    }
    const all = await ids({ uncoveredFirst: true });
    const paged = [];
    for (let offset = 0; offset < all.length; offset += 4) {
      // eslint-disable-next-line no-await-in-loop
      paged.push(...(await fetchCandidates({ cutoff: '2026-01-01T00:00:00Z', minScore: 0, limit: 4, offset, queryFn, uncoveredFirst: true }))
        .map((row) => row.id));
    }
    expect(paged).toEqual(all);
    expect(all.slice(0, 2)).toEqual(['b0', 'c0']);
    expect(all.slice(-7)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });
});
