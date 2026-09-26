'use strict';

// Which text the invoke route rejects (the query) and which it truncates (history).
// The route wiring and the 400 body are pinned in tests/integration/invoke.search_query_length_cap.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_CHARS,
  findOverlongSearchQuery,
  resolveSearchQueryMaxChars,
  truncateSearchHistory,
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

test('the latest user message is the query when no real query field is sent, and is rejected', () => {
  const messages = [{ role: 'user', content: over }];
  assert.equal(check({ messages })?.field, 'messages[].content');
  assert.equal(check({ user: { conversation_messages: messages } })?.field, 'messages[].content');
  // A query that does not look real (policy.js looksLikeRealQuery) yields to the message there too.
  assert.equal(check({ search: { query: '?' }, messages })?.field, 'messages[].content');
  // find_products does not build a conversation context.
  assert.equal(check({ messages }, 'find_products'), null);
});

test('history is never rejected: a long earlier turn or recent query beside a real query passes', () => {
  assert.equal(check({ search: { query: 'moisturizer' }, messages: [{ role: 'user', content: over }] }), null);
  assert.equal(check({ messages: [{ role: 'user', content: over }, { role: 'user', content: 'serum' }] }), null);
  assert.equal(check({ search: { query: 'previous search' }, user: { session_recent_queries: [over] } }), null);
});

test('history over the limit is cut to it in place; the query and assistant turns are untouched', () => {
  const payload = {
    search: { query: 'previous search' },
    user: { session_recent_queries: ['serum', over], recent_queries: [over] },
    messages: [
      { role: 'user', content: over },
      { role: 'assistant', content: over },
      { role: 'user', content: 'moisturizer' },
    ],
  };
  assert.equal(truncateSearchHistory({ operation: 'find_products_multi', payload }), 3);
  assert.deepEqual(payload.user.session_recent_queries, ['serum', atCap]);
  assert.deepEqual(payload.user.recent_queries, [atCap]);
  assert.equal(payload.messages[0].content, atCap);
  assert.equal(payload.messages[1].content, over);
  assert.equal(payload.messages[2].content, 'moisturizer');
  assert.equal(payload.search.query, 'previous search');
  assert.equal(truncateSearchHistory({ operation: 'find_products_multi', payload }), 0);
  assert.equal(truncateSearchHistory({ operation: 'get_pdp_v2', payload: { messages: [{ role: 'user', content: over }] } }), 0);
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
  for (const payload of [null, undefined, 'x', [], { search: 'x' }, { search: { query: 7 } }, { messages: 'x' }, { messages: [null, 5] }, { user: { recent_queries: 'x' } }]) {
    assert.doesNotThrow(() => check(payload), JSON.stringify(payload));
    assert.doesNotThrow(() => truncateSearchHistory({ operation: 'find_products_multi', payload }), JSON.stringify(payload));
  }
});
