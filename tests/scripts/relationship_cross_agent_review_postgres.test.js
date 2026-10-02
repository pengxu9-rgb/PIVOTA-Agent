'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { runReview, consumerCopyForKind } = require('../../scripts/review-relationship-candidate-labels');
const { listApprovedRelationshipEdgesForAnchorUncollapsed } = require('../../src/auroraBff/productRelationshipGraph');
const { scanServingLabels } = require('../../src/services/relationshipGraphServingScan');

const DATABASE_URL = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const pgDescribe = DATABASE_URL || process.env.RELGRAPH_TEST_POSTGRES === '1' ? describe : describe.skip;
pgDescribe('consensus apply and serving on throwaway PostgreSQL', () => {
  let dir; let client; let started = false;
  const bin = process.env.RELGRAPH_TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@15/bin';
  const run = (command, args) => execFileSync(path.join(bin, command), args, { env: { ...process.env, LANG: 'C', LC_ALL: 'C' }, stdio: 'pipe' });
  const savedEnv = { ...process.env };
  beforeAll(async () => {
    if (DATABASE_URL) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(DATABASE_URL).hostname)) throw new Error('Consensus tests require a local disposable database');
      client = new Client({ connectionString: DATABASE_URL });
    } else {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
    });
    dir = fs.mkdtempSync('/tmp/relgraph-consensus-pg-');
    run('initdb', ['-D', dir, '-A', 'trust', '--no-locale', '--encoding=UTF8']);
    run('pg_ctl', ['-D', dir, '-l', path.join(dir, 'server.log'), '-o', `-p ${port} -h 127.0.0.1 -F`, '-w', 'start']); started = true;
    client = new Client({ host: '127.0.0.1', port, database: 'postgres' });
    }
    await client.connect();
    await client.query('CREATE SCHEMA relgraph_consensus_test');
    await client.query('SET search_path TO relgraph_consensus_test');
    for (const number of ['046', '048', '050', '051']) {
      const file = fs.readdirSync(path.join(__dirname, '../../src/db/migrations')).find((name) => name.startsWith(`${number}_`));
      await client.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
    }
  }, 30000);
  afterAll(async () => {
    try { if (client) { await client.query('DROP SCHEMA IF EXISTS relgraph_consensus_test CASCADE'); await client.end(); } } finally {
      if (started) run('pg_ctl', ['-D', dir, '-m', 'immediate', '-w', 'stop']);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.env.RELGRAPH_AI_REVIEW_APPLY = '1';
    await client.query('TRUNCATE relationship_candidate_labels');
    const inci = 'Water, Glycerin, Squalane, Ceramide NP, Peptide, Phenoxyethanol';
    const a = { product_id: 'a', title: 'Barrier Peptide Face Cream', brand: 'Luxury', category: 'face cream', price: 50, price_currency: 'USD', ingredient_text: inci };
    const b = { ...a, product_id: 'b', brand: 'Value', price: 20 };
    await client.query(`INSERT INTO relationship_candidate_labels (id,anchor_type,anchor_ref,anchor_snapshot,candidate_product_ref,candidate_snapshot,
      relation_type,market,label_state,score_total,score_breakdown,price_evidence,source_refs,evidence_grade,category_taxonomy,use_case,updated_at)
      VALUES ('consensus_pg','product','product:a',$1,'product:b',$2,'dupe','US','generated',0.9,
        '{"category_use_case_match":0.9}',$3,'[{"type":"catalog_products","authoritative":true}]','B','["face cream"]','face cream','2026-10-01 00:00:00.000001+00')`,
    [JSON.stringify(a), JSON.stringify(b), JSON.stringify({ anchor_price_amount: 50, candidate_price_amount: 20, anchor_price_currency: 'USD', candidate_price_currency: 'USD', price_ratio: 0.4, observed_at: new Date().toISOString() })]);
  });
  afterEach(() => { jest.restoreAllMocks(); process.env = { ...savedEnv }; });
  function decision(extra = {}) {
    return { verdict: 'approve', confidence: 0.95, relationship_kind: 'dupe',
      rationale: 'The supplied barrier face creams have matching ingredients and a lower comparable price.',
      shared_evidence: [{ anchor_fact: 'Barrier Peptide Face Cream', candidate_fact: 'Barrier Peptide Face Cream' }],
      ...consumerCopyForKind('dupe'), ...extra };
  }
  async function review(mutate = async () => {}, second = decision()) {
    const providers = [
      { __meta: { provider: 'openai', model: 'gpt-fixture' }, analyzeTextToJson: async () => decision() },
      { __meta: { provider: 'gemini', model: 'gemini-2.5-flash' }, analyzeTextToJson: async () => { await mutate(); return second; } },
    ];
    return runReview({ cutoff: '2020-01-01', minScore: 0, limit: 10, apply: true,
      reviewMode: 'consensus', consensusProviders: providers, queryFn: (sql, args) => client.query(sql, args) });
  }
  test('genuine dupe reaches the real serving view and bounded coverage scan', async () => {
    const result = await review(); expect(result.summary.approved_applied_count).toBe(1);
    const read = () => listApprovedRelationshipEdgesForAnchorUncollapsed({ anchorRefs: ['product:a'], market: 'US', queryFn: (sql, args) => client.query(sql, args) });
    expect(await read()).toHaveLength(1);
    const scan = await scanServingLabels({ market: 'US', collectSuppressedIds: true, queryFn: (sql, args) => client.query(sql, args) });
    expect(scan).toMatchObject({ servedEdges: 1, suppressedCount: 0 });
    await client.query("UPDATE relationship_candidate_labels SET candidate_snapshot = jsonb_set(candidate_snapshot,'{price}','19')");
    expect(await read()).toHaveLength(0);
    expect(await scanServingLabels({ market: 'US', queryFn: (sql, args) => client.query(sql, args) })).toMatchObject({ servedEdges: 0, suppressedCount: 1 });
  });
  test.each(['human_approved', 'human_rejected'])('human %s edit during model review always wins', async (state) => {
    const result = await review(() => client.query('UPDATE relationship_candidate_labels SET label_state=$1', [state]));
    expect(result.summary.approved_applied_count).toBe(0);
    expect((await client.query('SELECT label_state, provenance FROM relationship_candidate_labels')).rows[0]).toEqual({ label_state: state, provenance: null });
  });
  test('a one-microsecond revision prevents applying an old decision', async () => {
    const result = await review(() => client.query("UPDATE relationship_candidate_labels SET updated_at=updated_at+interval '1 microsecond'"));
    expect(result.summary.approved_applied_count).toBe(0);
    expect((await client.query('SELECT label_state FROM relationship_candidate_labels')).rows[0].label_state).toBe('generated');
  });
  test.each(['price_evidence', 'source_refs', 'candidate_snapshot', 'score_total'])('%s changes without timestamp changes still invalidate apply', async (field) => {
    const sql = {
      price_evidence: "UPDATE relationship_candidate_labels SET price_evidence=jsonb_set(price_evidence,'{price_ratio}','0.5')",
      source_refs: "UPDATE relationship_candidate_labels SET source_refs='[]'",
      candidate_snapshot: "UPDATE relationship_candidate_labels SET candidate_snapshot=jsonb_set(candidate_snapshot,'{title}','\"Changed Product\"')",
      score_total: 'UPDATE relationship_candidate_labels SET score_total=0.91',
    }[field];
    const result = await review(() => client.query(sql)); expect(result.summary.approved_applied_count).toBe(0);
  });
  test('disagreement is durably queued, retains both reviews and cannot overwrite a human decision', async () => {
    const result = await review(async () => {}, decision({ verdict: 'reject' }));
    expect(result.summary).toMatchObject({ human_review_required_count: 1, consensus_disposition_applied_count: 1 });
    const stored = (await client.query('SELECT label_state,reason_flags,provenance,human_review FROM relationship_candidate_labels')).rows[0];
    expect(stored).toMatchObject({ label_state: 'needs_evidence', reason_flags: ['cross_agent_human_review'], human_review: null });
    expect(stored.provenance.cross_agent_review.reviews).toHaveLength(2);
    await client.query("UPDATE relationship_candidate_labels SET label_state='generated',provenance=NULL");
    const raced = await review(() => client.query("UPDATE relationship_candidate_labels SET label_state='human_approved'"), decision({ verdict: 'reject' }));
    expect(raced.summary.consensus_disposition_applied_count).toBe(0);
    expect((await client.query('SELECT label_state FROM relationship_candidate_labels')).rows[0].label_state).toBe('human_approved');
  });
});
