'use strict';

// The per-request recorder behind the `mcp tools/call complete` line (src/observability/mcpToolCallOutcome.js):
// how an answer becomes outcome / is_error / error_code, which observed fields survive, and the tier. The routes
// are pinned end to end by tests/mcp_tool_call_outcome_log.node.test.cjs; this file covers the branches a route
// test reaches only with a fault injected (the adapter throwing, the heartbeat committing).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMcpToolCallRecorder,
  mcpCallerTier,
  jsonRpcErrorCode,
} = require('../src/observability/mcpToolCallOutcome');

const okOut = (result) => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result } });

test('an adapter answer with a result is ok; with isError it is a tool error carrying the observed code', () => {
  const ok = createMcpToolCallRecorder();
  ok.recordRpcResponse(okOut({ content: [] }));
  assert.deepEqual(ok.fields(200), { outcome: 'ok', is_error: false, error_code: null, degraded: false });

  const bad = createMcpToolCallRecorder();
  bad.observe({ error_code: 'NO_MERCHANT_OFFER' });
  bad.recordRpcResponse(okOut({ isError: true, content: [] }));
  assert.deepEqual(bad.fields(200), {
    outcome: 'tool_error', is_error: true, error_code: 'NO_MERCHANT_OFFER', degraded: false,
  });

  const uncoded = createMcpToolCallRecorder();
  uncoded.recordRpcResponse(okOut({ isError: true, content: [] }));
  assert.equal(uncoded.fields(200).error_code, 'UNEXPECTED_ERROR');
});

test('a JSON-RPC error is named, not numbered', () => {
  const r = createMcpToolCallRecorder();
  r.recordRpcResponse({ status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'x' } } });
  assert.deepEqual(r.fields(200), {
    outcome: 'rpc_error', is_error: true, error_code: 'JSONRPC_INVALID_PARAMS', degraded: false,
  });
  assert.equal(jsonRpcErrorCode(-32001), 'JSONRPC_AUTHENTICATION_FAILED');
  assert.equal(jsonRpcErrorCode(-32000), 'JSONRPC_M32000');
  assert.equal(jsonRpcErrorCode('weird'), 'JSONRPC_UNKNOWN');
});

test('an adapter that threw is an internal error even on a committed 200 wire', () => {
  const r = createMcpToolCallRecorder();
  r.observe({ heartbeat_committed: true });
  r.recordInternalError();
  assert.deepEqual(r.fields(200), {
    outcome: 'internal_error', is_error: true, error_code: 'INTERNAL_ERROR', degraded: false, heartbeat_committed: true,
  });
});

test('with no answer recorded, the status decides: 4xx refused, 5xx internal, 2xx unknown', () => {
  assert.deepEqual(createMcpToolCallRecorder().fields(429), {
    outcome: 'refused', is_error: true, error_code: 'HTTP_429', degraded: false,
  });
  assert.deepEqual(createMcpToolCallRecorder().fields(503), {
    outcome: 'internal_error', is_error: true, error_code: 'HTTP_503', degraded: false,
  });
  assert.deepEqual(createMcpToolCallRecorder().fields(200), {
    outcome: 'unknown', is_error: true, error_code: null, degraded: false,
  });
});

test('a door-written tool error (the kill-switch refusal) is logged with its code', () => {
  const r = createMcpToolCallRecorder();
  r.recordToolError('OPERATION_NOT_ALLOWED');
  assert.equal(r.fields(200).outcome, 'tool_error');
  assert.equal(r.fields(200).error_code, 'OPERATION_NOT_ALLOWED');
});

test('observed fields are allowlisted and validated; degraded is the OR of its flags', () => {
  const r = createMcpToolCallRecorder();
  r.observe({
    result_count: 4, cache_hit: 'stale', lane: 'lane_a', lane_source: 'src_b', upstream_status: 'failed',
    upstream_degraded: true, fallback_used: true,
    query: 'never logged', raw_token: 'never logged', arguments: { a: 1 },
  });
  r.recordRpcResponse(okOut({ content: [] }));
  const fields = r.fields(200);
  assert.deepEqual(fields, {
    outcome: 'ok', is_error: false, error_code: null,
    result_count: 4, cache_hit: 'stale', lane: 'lane_a', lane_source: 'src_b', upstream_status: 'failed',
    degraded: true, upstream_degraded: true, fallback_used: true,
  });

  const bad = createMcpToolCallRecorder();
  bad.observe({
    result_count: -1, cache_hit: 'maybe', lane: 'has spaces', error_code: 'lower', upstream_timeout: 'yes',
  });
  bad.recordRpcResponse(okOut({}));
  assert.deepEqual(bad.fields(200), { outcome: 'ok', is_error: false, error_code: null, degraded: false });
});

test('later observations of the same field win (the surface reports cache state, then the adapter the count)', () => {
  const r = createMcpToolCallRecorder();
  r.observe({ cache_hit: false });
  r.observe({ result_count: 0 });
  r.observe({ result_count: 2 });
  r.recordRpcResponse(okOut({}));
  assert.equal(r.fields(200).result_count, 2);
  assert.equal(r.fields(200).cache_hit, false);
});

test('a throwing input never escapes the recorder', () => {
  const r = createMcpToolCallRecorder();
  const hostile = {};
  Object.defineProperty(hostile, 'result_count', { enumerable: true, get() { throw new Error('getter'); } });
  r.observe(hostile);
  r.observe(null);
  r.recordRpcResponse(null);
  r.recordRpcResponse({ body: 'not an object' });
  assert.equal(r.fields(200).outcome, 'unknown');
});

test('tier: public door, configured service key, any other resolved caller, nobody', () => {
  assert.equal(mcpCallerTier({ invokeAuth: { auth_mode: 'api_key' } }, 'public_mcp'), 'public');
  assert.equal(
    mcpCallerTier({ invokeAuth: { auth_mode: 'api_key', introspect_auth_source: 'configured_service_key' } }, 'mcp'),
    'first_party',
  );
  assert.equal(mcpCallerTier({ invokeAuth: { auth_mode: 'api_key', introspect_auth_source: 'api_keys' } }, 'mcp'), 'authenticated');
  assert.equal(mcpCallerTier({ invokeAuth: { auth_mode: 'mcp_oauth' } }, 'ucp_mcp'), 'authenticated');
  assert.equal(mcpCallerTier({}, 'mcp'), 'unauthenticated');
  assert.equal(mcpCallerTier(undefined, 'mcp'), 'unauthenticated');
});
