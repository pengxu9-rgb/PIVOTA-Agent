'use strict';

// Which query text the invoke route measures before rejecting with QUERY_TOO_LONG.
// The route wiring and the 400 body are pinned in tests/integration/invoke.search_query_length_cap.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_CHARS,
  findOverlongSearchQuery,
  resolveSearchQueryMaxChars,
} = require('../src/findProductsMulti/queryLengthCap');

const over = 'a'.repeat(DEFAULT_MAX_CHARS + 1);
const atCap = 'a'.repeat(DEFAULT_MAX_CHARS);
const check = (payload, operation = 'find_products_multi') => findOverlongSearchQuery({ operation, payload });

test('the default cap is 500 and a query of exactly 500 passes', () => {
  assert.equal(DEFAULT_MAX_CHARS, 500);
  assert.equal(check({ search: { query: atCap } }), null);
  assert.deepEqual(check({ search: { query: over } }), { field: 'search.query', length: 501, max_chars: 500 });
});

test('every explicit query field is measured, including array values from a GET query string', () => {
  for (const field of ['q', 'keyword', 'text']) {
    assert.equal(check({ search: { query: 'serum', [field]: over } })?.field, `search.${field}`);
  }
  assert.equal(check({ query: over })?.field, 'query');
  assert.equal(check({ search: { query: ['serum', over] } })?.field, 'search.query');
});

test('whitespace padding does not count', () => {
  assert.equal(check({ search: { query: `  ${atCap}  ` } }), null);
});

test('every user message is measured, since each one is parsed as a query', () => {
  const messages = [{ role: 'user', content: over }];
  assert.equal(check({ messages })?.field, 'messages[].content');
  assert.equal(check({ user: { conversation_messages: messages } })?.field, 'messages[].content');
  // Not only the latest turn, and not only when it becomes the query: understandShoppingQuery re-parses
  // prior user turns for refinements, and extractIntentRuleBased classifies every user message.
  assert.equal(check({ search: { query: 'moisturizer' }, messages })?.field, 'messages[].content');
  assert.equal(
    check({ messages: [{ role: 'user', content: over }, { role: 'user', content: 'serum' }] })?.field,
    'messages[].content',
  );
});

test('assistant turns are not measured; nothing parses them as a query', () => {
  assert.equal(check({ search: { query: 'serum' }, messages: [{ role: 'assistant', content: over }] }), null);
});

test('recent queries are measured: a continuation ("previous search") promotes one to the query', () => {
  assert.equal(
    check({ search: { query: 'previous search' }, user: { session_recent_queries: ['serum', over] } })?.field,
    'user.session_recent_queries[]',
  );
  assert.equal(check({ search: { query: 'serum' }, user: { recent_queries: [over] } })?.field, 'user.recent_queries[]');
  assert.equal(check({ search: { query: 'serum' }, user: { recent_queries: [atCap, 'toner'] } }), null);
});

test('find_products does not build a conversation context, so its messages are not measured', () => {
  assert.equal(check({ messages: [{ role: 'user', content: over }] }, 'find_products'), null);
  assert.equal(check({ user: { recent_queries: [over] } }, 'find_products')?.field, 'user.recent_queries[]');
});

test('other operations are never checked', () => {
  assert.equal(check({ search: { query: over } }, 'get_pdp_v2'), null);
  assert.equal(check({ search: { query: over } }, 'find_products')?.field, 'search.query');
});

test('the cap can be raised by env, never below 50', () => {
  assert.equal(resolveSearchQueryMaxChars({ SEARCH_QUERY_MAX_CHARS: '2000' }), 2000);
  assert.equal(resolveSearchQueryMaxChars({ SEARCH_QUERY_MAX_CHARS: '10' }), 500);
  assert.equal(resolveSearchQueryMaxChars({ SEARCH_QUERY_MAX_CHARS: 'x' }), 500);
  assert.equal(resolveSearchQueryMaxChars({}), 500);
  assert.equal(findOverlongSearchQuery({ operation: 'find_products_multi', payload: { search: { query: over } }, maxChars: 2000 }), null);
});

test('malformed payloads never throw', () => {
  for (const payload of [null, undefined, 'x', [], { search: 'x' }, { search: { query: 7 } }, { messages: 'x' }, { messages: [null, 5] }]) {
    assert.doesNotThrow(() => check(payload), JSON.stringify(payload));
  }
});
