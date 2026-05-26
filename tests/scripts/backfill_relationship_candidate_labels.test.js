const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyCandidateLabels,
  loadLabelsFromReports,
} = require('../../scripts/backfill-relationship-candidate-labels');

const NOW = '2026-05-25T00:00:00.000Z';

function edge(overrides = {}) {
  return {
    id: 'prel_fixture',
    anchor_type: 'product',
    anchor_ref: 'product:anchor',
    anchor_snapshot: { product_id: 'anchor', brand: 'Anchor Brand', name: 'Anchor Serum' },
    candidate_product_ref: 'product:candidate',
    candidate_snapshot: { product_id: 'candidate', brand: 'Candidate Brand', name: 'Candidate Serum' },
    relation_type: 'dupe',
    display_label: 'budget_alternative',
    market: 'US',
    vertical: 'beauty',
    category_taxonomy: ['skincare', 'serum'],
    use_case: 'barrier support',
    review_status: 'approved',
    score_total: 0.88,
    score_breakdown: { category_use_case_match: 0.9, score_total: 0.88 },
    price_evidence: { price_ratio: 0.8, observed_at: NOW },
    source_refs: [{ type: 'products_cache', authoritative: true }],
    evidence_grade: 'A',
    why_candidate: { summary: 'Similar use case.' },
    tradeoffs: [],
    watchouts: [],
    provenance: { pipeline: 'fixture' },
    last_verified_at: NOW,
    expires_at: '2026-08-23T00:00:00.000Z',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function writeReport(dir, name, edges) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${JSON.stringify({ edges }, null, 2)}\n`, 'utf8');
  fs.utimesSync(filePath, new Date(NOW), new Date(NOW));
  return filePath;
}

function makeQueryStore() {
  const store = new Map();
  const queryFn = jest.fn(async (sql, params = []) => {
    if (/INSERT INTO relationship_candidate_labels/.test(sql)) {
      const key = [
        params[9],
        params[2],
        String(params[3]).toLowerCase(),
        String(params[5]).toLowerCase(),
        params[7],
      ].join('|');
      const inserted = !store.has(key);
      store.set(key, {
        label_state: params[13],
        human_review: params[22] ? JSON.parse(params[22]) : null,
      });
      return { rows: [{ inserted, label_state: params[13] }] };
    }
    if (/SELECT label_state, COUNT/.test(sql)) {
      const counts = new Map();
      for (const row of store.values()) {
        counts.set(row.label_state, (counts.get(row.label_state) || 0) + 1);
      }
      return {
        rows: Array.from(counts.entries()).map(([label_state, count]) => ({
          label_state,
          count,
        })),
      };
    }
    if (/COUNT\(\*\) FILTER/.test(sql)) {
      let humanReviewRows = 0;
      let noHumanReviewRows = 0;
      for (const row of store.values()) {
        if (row.human_review) humanReviewRows += 1;
        else noHumanReviewRows += 1;
      }
      return {
        rows: [
          {
            human_review_rows: humanReviewRows,
            no_human_review_rows: noHumanReviewRows,
          },
        ],
      };
    }
    throw new Error(`unexpected_sql:${sql}`);
  });
  return { queryFn, store };
}

describe('backfill-relationship-candidate-labels', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-backfill-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('loads fixture counts and extracts stable reviewer flags', () => {
    writeReport(tmpDir, 'fixture_a_consensus_publish_ready_report.json', [
      edge({
        id: 'prel_approved',
        review_status: 'approved',
        human_review: {
          consensus_timestamp: NOW,
          reviewer_decisions: [
            { flags: ['cross_brand', 'weak_source_support_for_relation'] },
            { flags: ['cross_brand'] },
          ],
        },
      }),
      edge({
        id: 'prel_rejected',
        candidate_product_ref: 'product:candidate_rejected',
        review_status: 'rejected',
        human_review: {
          consensus_timestamp: NOW,
          reviewer_decisions: {
            ingredient_formula_form: { flags: ['format_mismatch'] },
            effect_use_case_claims: { flags: ['product_job_mismatch', 'format_mismatch'] },
          },
        },
      }),
    ]);
    writeReport(tmpDir, 'fixture_b_consensus_publish_ready_report.json', [
      edge({
        id: 'prel_pending',
        candidate_product_ref: 'product:candidate_pending',
        review_status: 'pending',
        human_review: undefined,
      }),
    ]);

    const result = loadLabelsFromReports({ reportsDir: tmpDir });

    expect(result.summary).toEqual(
      expect.objectContaining({
        source_files: 2,
        rows_seen: 3,
        rows_planned: 3,
        rows_skipped: 0,
        human_review_rows: 2,
        no_human_review_rows: 1,
        state_counts: {
          human_approved: 1,
          human_rejected: 1,
          needs_evidence: 1,
        },
      }),
    );
    expect(result.labels.find((label) => label.edge_id === 'prel_approved').reason_flags).toEqual([
      'cross_brand',
      'weak_source_support_for_relation',
    ]);
    expect(result.labels.find((label) => label.edge_id === 'prel_rejected').reason_flags).toEqual([
      'format_mismatch',
      'product_job_mismatch',
    ]);
  });

  test('apply is idempotent on the relationship identity key', async () => {
    writeReport(tmpDir, 'fixture_consensus_publish_ready_report.json', [
      edge({ id: 'prel_approved', review_status: 'approved' }),
      edge({
        id: 'prel_rejected',
        candidate_product_ref: 'product:candidate_rejected',
        review_status: 'rejected',
      }),
    ]);
    const { labels } = loadLabelsFromReports({ reportsDir: tmpDir });
    const { queryFn, store } = makeQueryStore();

    const first = await applyCandidateLabels(labels, { queryFn });
    const second = await applyCandidateLabels(labels, { queryFn });

    expect(first).toEqual(
      expect.objectContaining({
        rows_inserted: 2,
        rows_updated: 0,
        final_state_counts: expect.objectContaining({
          human_approved: 1,
          human_rejected: 1,
          needs_evidence: 0,
        }),
      }),
    );
    expect(second).toEqual(
      expect.objectContaining({
        rows_inserted: 0,
        rows_updated: 2,
        final_state_counts: expect.objectContaining({
          human_approved: 1,
          human_rejected: 1,
          needs_evidence: 0,
        }),
      }),
    );
    expect(store.size).toBe(2);
  });
});
