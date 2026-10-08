'use strict';

// The nightly build re-upserts every generated candidate it emits. If that upsert replaced
// provenance wholesale, the reviewer's negative memory (provenance.ai_review_last) would be wiped
// every night and the reviewer would re-pay for the same rejected pairs. This runs the real build
// upsert and the real reviewer SQL against a private, throwaway local Postgres.

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { LlmError } = require('../../src/llm/provider');
const { upsertRelationshipCandidateLabel } = require('../../src/auroraBff/productRelationshipGraph');
const { runReview } = require('../../scripts/review-relationship-candidate-labels');

const REJECT = {
  verdict: 'reject',
  confidence: 0.82,
  rationale: 'Glue remover is not used alongside pre-glued clusters in this evidence.',
  relationship_kind: 'none',
  recommendation_reason: '',
  shared_evidence: [],
  tradeoffs: [],
  watchouts: [],
};

function builtEdge(id, { generatedAt, candidateTitle = 'Impress Lash Glue Remover' } = {}) {
  return {
    id,
    edge_id: id,
    anchor_type: 'product',
    anchor_ref: `product:sig_anchor_${id}`,
    anchor_snapshot: { product_id: `sig_anchor_${id}`, brand: 'Impress', title: 'Impress Falsies Pre-Glued False Eyelashes - Demi Edgy', category: 'False Lashes' },
    candidate_product_ref: `product:sig_candidate_${id}`,
    candidate_snapshot: { product_id: `sig_candidate_${id}`, brand: 'Impress', title: candidateTitle, category: 'Lash Adhesive' },
    relation_type: 'related_product',
    market: 'US',
    category_taxonomy: ['False Lashes'],
    use_case: 'False Lashes',
    score_total: 0.8,
    score_breakdown: { score_total: 0.8 },
    price_evidence: { anchor_price_amount: 10, candidate_price_amount: 6, observed_at: generatedAt },
    source_refs: [{ type: 'external_product_seeds', authoritative: true }],
    evidence_grade: 'B',
    why_candidate: { summary: 'Possible routine companion; complementary usage requires review.' },
    label_state: 'generated',
    provenance: { pipeline: 'product_relationship_graph_builder.v1', generated_at: generatedAt },
  };
}

// Ambient database URLs are never read: always initialize a private local server.
const pgDescribe = process.env.RELGRAPH_TEST_POSTGRES === '1' ? describe : describe.skip;
pgDescribe('negative review memory survives the nightly rebuild (isolated local Postgres)', () => {
  let dir;
  let client;
  let started = false;
  const bin = process.env.RELGRAPH_TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@15/bin';
  const run = (cmd, args) => execFileSync(path.join(bin, cmd), args, { env: { ...process.env, LANG: 'C', LC_ALL: 'C' }, stdio: 'pipe' });
  beforeAll(async () => {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { const { port: p } = server.address(); server.close(() => resolve(p)); });
    });
    dir = fs.mkdtempSync('/tmp/relgraph-negative-memory-private-');
    run('initdb', ['-D', dir, '-A', 'trust', '--no-locale', '--encoding=UTF8']);
    run('pg_ctl', ['-D', dir, '-l', path.join(dir, 'server.log'), '-o', `-p ${port} -h 127.0.0.1 -F`, '-w', 'start']);
    started = true;
    client = new Client({ host: '127.0.0.1', port, database: 'postgres' });
    await client.connect();
    for (const number of ['046', '048', '050', '051']) {
      const file = fs.readdirSync(path.join(__dirname, '../../src/db/migrations')).find((n) => n.startsWith(`${number}_`));
      await client.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
    }
  }, 30000);
  afterAll(async () => {
    try {
      if (client) await client.end();
    } finally {
      if (started) run('pg_ctl', ['-D', dir, '-m', 'immediate', '-w', 'stop']);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const q = (sql, args) => client.query(sql, args);
  const label = async (id) => (await q('SELECT label_state, provenance, reviewed_at FROM relationship_candidate_labels WHERE id = $1', [id])).rows[0];
  const quietly = async (fn) => {
    const saved = process.env.RELGRAPH_AI_REVIEW_APPLY;
    process.env.RELGRAPH_AI_REVIEW_APPLY = '1';
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      return await fn();
    } finally {
      stdout.mockRestore();
      if (saved === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY;
      else process.env.RELGRAPH_AI_REVIEW_APPLY = saved;
    }
  };
  const review = (provider) => quietly(() => runReview({
    cutoff: '2026-01-01T00:00:00Z', minScore: 0, limit: 10, apply: true, queryFn: q, provider,
  }));

  test('reject -> rebuild keeps ai_review_last -> next run skips; a changed snapshot is reviewed again', async () => {
    await upsertRelationshipCandidateLabel(builtEdge('mem', { generatedAt: '2026-10-07T10:40:00.000Z' }), { queryFn: q });
    await upsertRelationshipCandidateLabel(builtEdge('plain', { generatedAt: '2026-10-07T10:40:00.000Z' }), { queryFn: q });

    // 'mem' is rejected; 'plain' hits a transport error, which must not be remembered.
    const night1 = {
      __meta: { model: 'gemini-test' },
      analyzeTextToJson: jest.fn(async ({ prompt }) => {
        if (prompt.includes('sig_anchor_mem')) return REJECT;
        throw new LlmError('LLM_REQUEST_FAILED', 'Vertex 503');
      }),
    };
    const first = await review(night1);
    expect(first.summary.negative_memory_recorded_count).toBe(1);
    const remembered = await label('mem');
    expect(remembered.label_state).toBe('generated');
    expect(remembered.reviewed_at).not.toBeNull();
    expect(remembered.provenance.ai_review_last).toEqual(expect.objectContaining({ verdict: 'reject', model: 'gemini-test' }));
    expect((await label('plain')).provenance.ai_review_last).toBeUndefined();

    // Next night's build re-emits both rows (new generated_at, new fallback price date).
    await upsertRelationshipCandidateLabel(builtEdge('mem', { generatedAt: '2026-10-08T10:40:00.000Z' }), { queryFn: q });
    await upsertRelationshipCandidateLabel(builtEdge('plain', { generatedAt: '2026-10-08T10:40:00.000Z' }), { queryFn: q });
    const rebuilt = await label('mem');
    expect(rebuilt.provenance.generated_at).toBe('2026-10-08T10:40:00.000Z');
    expect(rebuilt.provenance.ai_review_last).toEqual(remembered.provenance.ai_review_last);
    // A row with nothing to keep gets exactly the build's provenance.
    expect((await label('plain')).provenance).toEqual({ pipeline: 'product_relationship_graph_builder.v1', generated_at: '2026-10-08T10:40:00.000Z' });

    const night2 = { analyzeTextToJson: jest.fn(async () => REJECT) };
    const second = await review(night2);
    expect(second.decisions.map((d) => d.id)).toEqual(['plain']);
    expect(second.summary.negative_memory_skipped_count).toBe(1);

    // The candidate's snapshot changes: the pair is new evidence and is reviewed again.
    await upsertRelationshipCandidateLabel(builtEdge('mem', { generatedAt: '2026-10-09T10:40:00.000Z', candidateTitle: 'Impress Lash Glue Remover + Applicator' }), { queryFn: q });
    const night3 = { analyzeTextToJson: jest.fn(async () => REJECT) };
    const third = await review(night3);
    expect(third.decisions.map((d) => d.id)).toEqual(['mem']);
  });
});
