#!/usr/bin/env node
'use strict';

// Offline and read-only: no HTTP, database client, migration, worker, or writes.
// A recorded response can establish its own contract, never production rollout.
const fs = require('node:fs');
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 500;
const RELATIONS = new Set(['dupe', 'competitive_alternative', 'niche_specialist', 'related_product']);
const READ_STATUSES = new Set(['ready', 'empty', 'unavailable', 'not_attempted']);
const READ_REASONS = new Set(['no_eligible_edges', 'no_database', 'schema_unavailable', 'no_anchor_refs', 'disabled', 'read_failed']);

function readBoundedJson(filename) {
  const fd = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('input_must_be_regular_json_file_at_most_2MiB');
    // Bound the read too, so a file growing after fstat cannot allocate unbounded memory.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const n = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (!n) break;
      total += n;
    }
    if (total > MAX_BYTES) throw new Error('input_must_be_regular_json_file_at_most_2MiB');
    return JSON.parse(buffer.subarray(0, total).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function validateResponse(response, expectation = {}) {
  if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)) expectation = {};
  const errors = [];
  const fail = (condition, code) => { if (!condition) errors.push(code); };
  fail(expectation.schema_version === 'relationship_graph_read_expectation.v1', 'invalid_expectation_schema');
  fail(READ_STATUSES.has(expectation.read_status), 'expected_read_status_required');
  const payload = response?.data?.modules ? response.data : response;
  const modules = Array.isArray(payload?.modules) ? payload.modules : [];
  fail(modules.length > 0 && modules.length <= 100, 'invalid_or_unbounded_modules');
  const similarModules = modules.slice(0, 100).filter((module) => module?.type === 'similar');
  fail(similarModules.length === 1, 'exactly_one_similar_module_required');
  const similar = similarModules[0]?.data || {};
  const metadata = similar.metadata || {};
  const items = Array.isArray(similar.items) ? similar.items.slice(0, MAX_ITEMS) : [];
  fail(Array.isArray(similar.items) && similar.items.length <= MAX_ITEMS, 'invalid_or_unbounded_items');
  fail(items.every((item) => item && typeof item === 'object' && !Array.isArray(item)), 'invalid_item');
  const graphItems = items.filter((item) => item?.source === 'relationship_graph' || item?.recommendation_source === 'relationship_graph' || item?.relationship_edge_id);
  const settledStatuses = ['ready', 'empty', 'unavailable', 'underfilled', 'success'];
  fail(settledStatuses.includes(similar.status || metadata.similar_status) &&
    (!metadata.similar_status || settledStatuses.includes(metadata.similar_status)), 'similar_state_not_settled');
  fail(metadata.relationship_graph_read_status === expectation.read_status, 'graph_read_status_mismatch_or_missing');
  fail(metadata.relationship_graph_edge_count_semantics === 'returned_eligible_edges', 'edge_count_semantics_missing_or_invalid');
  const reason = metadata.relationship_graph_read_reason;
  fail(reason === null || READ_REASONS.has(reason), 'invalid_or_missing_read_reason');
  if (expectation.read_status === 'ready') fail(reason === null, 'ready_reason_must_be_null');
  if (expectation.read_status === 'empty') fail(reason === 'no_eligible_edges', 'empty_reason_mismatch');
  if (expectation.read_status === 'unavailable') fail(['no_database', 'schema_unavailable', 'read_failed'].includes(reason), 'unavailable_reason_mismatch');
  if (expectation.read_status === 'not_attempted') fail(['disabled', 'no_anchor_refs'].includes(reason), 'not_attempted_reason_mismatch');
  const count = metadata.relationship_graph_edge_count;
  fail(Number.isInteger(count) && count >= 0 && count >= graphItems.length, 'invalid_returned_eligible_edge_count');
  if (expectation.read_status === 'ready') fail(count > 0, 'ready_requires_returned_eligible_edges');
  if (['empty', 'unavailable', 'not_attempted'].includes(expectation.read_status)) fail(count === 0 && graphItems.length === 0, 'non_ready_read_must_not_emit_graph_edges');
  if (Object.hasOwn(expectation, 'subject')) {
    fail(expectation.subject && typeof expectation.subject === 'object', 'invalid_expected_subject');
    for (const field of ['type', 'id']) {
      if (Object.hasOwn(expectation.subject || {}, field)) fail(payload?.subject?.[field] === expectation.subject[field], `subject_${field}_mismatch`);
    }
  }
  const expected = Array.isArray(expectation.expected_edges) ? expectation.expected_edges : [];
  fail(expected.length <= MAX_ITEMS, 'too_many_expected_edges');
  if (expectation.read_status === 'ready') fail(expected.length > 0, 'positive_control_requires_expected_edge');
  const seen = new Set();
  for (const item of graphItems) {
    fail(typeof item.relationship_edge_id === 'string' && item.relationship_edge_id.length > 0, 'graph_edge_id_missing');
    fail(RELATIONS.has(item.relationship_type), 'invalid_relationship_type');
    fail(!seen.has(item.relationship_edge_id), 'duplicate_graph_edge_id');
    seen.add(item.relationship_edge_id);
  }
  for (const edge of expected.slice(0, MAX_ITEMS)) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) { errors.push('invalid_expected_edge'); continue; }
    fail(typeof edge?.edge_id === 'string' && edge.edge_id.length > 0 && RELATIONS.has(edge?.relation_type) && typeof edge?.candidate_product_id === 'string' && edge.candidate_product_id.length > 0, 'invalid_expected_edge');
    const item = graphItems.find((candidate) => candidate.relationship_edge_id === edge.edge_id);
    fail(Boolean(item), 'expected_edge_missing');
    if (!item) continue;
    fail(item.relationship_type === edge.relation_type, 'expected_relationship_type_mismatch');
    fail(item.product_id === edge.candidate_product_id, 'expected_candidate_listing_mismatch');
    fail(Array.isArray(item.evidence_refs) && item.evidence_refs.length > 0, 'positive_edge_source_refs_missing');
    const expectedSources = Array.isArray(edge.source_refs) ? edge.source_refs : [];
    fail(expectedSources.length > 0 && expectedSources.length <= 16, 'positive_control_requires_bounded_expected_source_refs');
    for (const source of expectedSources.slice(0, 16)) {
      const keys = Object.keys(source || {});
      fail(keys.length > 0 && keys.every((key) => ['type', 'name', 'url'].includes(key)), 'invalid_expected_source_ref');
      fail(Array.isArray(item.evidence_refs) && item.evidence_refs.some((ref) => ref && keys.every((key) => ref[key] === source[key])), 'expected_source_ref_missing');
    }
  }
  for (const field of ['forbidden_edge_ids', 'forbidden_product_ids']) {
    const blocked = expectation[field] || [];
    fail(Array.isArray(blocked) && blocked.length <= MAX_ITEMS, 'invalid_or_unbounded_negative_controls');
    if (!Array.isArray(blocked)) continue;
    const values = new Set(blocked.slice(0, MAX_ITEMS));
    fail(!items.some((item) => values.has(field === 'forbidden_edge_ids' ? item?.relationship_edge_id : item?.product_id)), field === 'forbidden_edge_ids' ? 'negative_control_edge_served' : 'negative_control_product_served');
  }
  return {
    schema_version: 'relationship_graph_read_validation.v1',
    contract_ok: errors.length === 0,
    errors: [...new Set(errors)],
    evidence_scope: 'recorded_response_only',
    production_rollout_verified: false,
    graph_read_status: metadata.relationship_graph_read_status || 'unknown',
    returned_eligible_edge_count: Number.isInteger(count) ? count : null,
    observed_graph_item_count: graphItems.length,
    limits: { max_input_bytes_each: MAX_BYTES, max_modules: 100, max_items: MAX_ITEMS },
    not_established: ['worker_execution', 'graph_data_refresh', 'migrations_061_062_063', 'reviewed_publication', 'current_cache_or_source_freshness', 'independent_relevance_quality', 'browser_ui_settlement'],
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write('Usage: node scripts/validate-relationship-graph-read-contract.cjs --response captured-pdp.json --expectation reviewed-expectation.json\nRead-only local JSON validation; no network, database queries, or writes. Inputs at most 2 MiB each.\n');
    return null;
  }
  if (argv.length !== 4 || argv[0] !== '--response' || argv[2] !== '--expectation') throw new Error('require_response_and_expectation_files; use --help');
  const report = validateResponse(readBoundedJson(argv[1]), readBoundedJson(argv[3]));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.contract_ok) process.exitCode = 1;
  return report;
}
if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.code === 'ENOENT' ? 'input_file_not_found' : error instanceof SyntaxError ? 'invalid_input_json' : error.message}\n`);
    process.exitCode = 2;
  }
}
module.exports = { MAX_BYTES, readBoundedJson, validateResponse, main };
