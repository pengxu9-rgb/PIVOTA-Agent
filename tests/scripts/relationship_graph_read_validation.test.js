const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MAX_BYTES, readBoundedJson, validateResponse } = require('../../scripts/validate-relationship-graph-read-contract.cjs');
const { correctedAnchorFixture } = require('../fixtures/relationship_graph_corrected_anchor.cjs');
const { relationshipEdgeToSimilarItem } = require('../../src/auroraBff/productRelationshipGraph');

function packet() {
  const fixture = correctedAnchorFixture();
  return {
    response: { subject: { type: 'product', id: fixture.anchor.product_id }, modules: [{ type: 'similar', data: {
      status: 'ready', items: [relationshipEdgeToSimilarItem(fixture.positive)], metadata: {
        relationship_graph_read_status: 'ready', relationship_graph_read_reason: null,
        relationship_graph_edge_count_semantics: 'returned_eligible_edges', relationship_graph_edge_count: 1,
      },
    } }] },
    expectation: { schema_version: 'relationship_graph_read_expectation.v1', read_status: 'ready',
      subject: { type: 'product', id: fixture.anchor.product_id },
      expected_edges: [{ edge_id: fixture.positive.id, relation_type: 'related_product', candidate_product_id: fixture.positive.candidate_snapshot.product_id, source_refs: fixture.positive.source_refs }],
      forbidden_edge_ids: [fixture.sameProduct.id, fixture.sameListing.id, fixture.shade.id],
      forbidden_product_ids: [fixture.sameProduct.candidate_snapshot.product_id, fixture.sameListing.candidate_snapshot.product_id, fixture.shade.candidate_snapshot.product_id],
    },
  };
}
it('passes the local positive/negative contract without claiming production verification', () => {
  const { response, expectation } = packet();
  expect(validateResponse(response, expectation)).toMatchObject({ contract_ok: true, errors: [], evidence_scope: 'recorded_response_only', production_rollout_verified: false, observed_graph_item_count: 1 });
});
it.each([
  ['missing edge ID', (data) => delete data.items[0].relationship_edge_id, 'expected_edge_missing'],
  ['wrong type', (data) => data.items[0].relationship_type = 'dupe', 'expected_relationship_type_mismatch'],
  ['missing source', (data) => data.items[0].evidence_refs = [], 'expected_source_ref_missing'],
  ['pending UI/API', (data) => data.status = 'deferred', 'similar_state_not_settled'],
  ['pending metadata behind success', (data) => { data.status = 'success'; data.metadata.similar_status = 'deferred'; }, 'similar_state_not_settled'],
  ['old ambiguous count', (data) => delete data.metadata.relationship_graph_read_status, 'graph_read_status_mismatch_or_missing'],
  ['invalid count', (data) => data.metadata.relationship_graph_edge_count = 0, 'invalid_returned_eligible_edge_count'],
])('fails %s instead of treating an empty or stale packet as positive', (_name, modify, error) => {
  const { response, expectation } = packet(); modify(response.modules[0].data);
  expect(validateResponse(response, expectation).errors).toContain(error);
});
it('rejects same-product/variant leakage and exact subject mismatches', () => {
  const { response, expectation } = packet();
  response.modules[0].data.items.push({ product_id: expectation.forbidden_product_ids[0] });
  response.subject.id = 'a_different_group_axis';
  expect(validateResponse(response, expectation).errors).toEqual(expect.arrayContaining(['negative_control_product_served', 'subject_id_mismatch']));
});
it('requires an explicitly sourced expected edge for positive controls', () => {
  const { response, expectation } = packet(); expectation.expected_edges[0].source_refs = [];
  expect(validateResponse(response, expectation).errors).toContain('positive_control_requires_bounded_expected_source_refs');
  expectation.expected_edges = [];
  expect(validateResponse(response, expectation).errors).toContain('positive_control_requires_expected_edge');
});
it.each([['empty', 'no_eligible_edges'], ['unavailable', 'schema_unavailable'], ['not_attempted', 'disabled']])('validates %s separately and never infers that labels are absent', (status, reason) => {
  const { response, expectation } = packet();
  expectation.read_status = status; expectation.expected_edges = [];
  Object.assign(response.modules[0].data, { status: 'empty', items: [] });
  Object.assign(response.modules[0].data.metadata, { relationship_graph_read_status: status, relationship_graph_read_reason: reason, relationship_graph_edge_count: 0 });
  expect(validateResponse(response, expectation)).toMatchObject({ contract_ok: true, production_rollout_verified: false });
});
it('caps file size before parsing and rejects non-regular inputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-read-validation-'));
  try {
    expect(() => readBoundedJson(dir)).toThrow('input_must_be_regular_json_file_at_most_2MiB');
    const file = path.join(dir, 'packet.json'); fs.writeFileSync(file, '{}');
    expect(readBoundedJson(file)).toEqual({});
    fs.truncateSync(file, MAX_BYTES + 1);
    expect(() => readBoundedJson(file)).toThrow('input_must_be_regular_json_file_at_most_2MiB');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
it('rejects oversized item lists rather than validating only their prefix', () => {
  const { response, expectation } = packet(); response.modules[0].data.items = Array.from({ length: 501 }, () => ({}));
  expect(validateResponse(response, expectation).errors).toContain('invalid_or_unbounded_items');
});

it('malformed expectations and source arrays fail closed without crashing', () => {
  const { response, expectation } = packet();
  expect(validateResponse(response, null).contract_ok).toBe(false);
  response.modules[0].data.items.push(null);
  expect(validateResponse(response, expectation).errors).toContain('invalid_item');
  expectation.expected_edges = [null];
  expect(validateResponse(response, expectation).errors).toContain('invalid_expected_edge');
  const another = packet(); another.response.modules[0].data.items[0].evidence_refs = 'not an array';
  expect(validateResponse(another.response, another.expectation).errors).toContain('expected_source_ref_missing');
});
