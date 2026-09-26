'use strict';

// A search query longer than SEARCH_QUERY_MAX_CHARS is rejected at the invoke route with 400
// QUERY_TOO_LONG, before any search code reads it.
//
// Why: nothing bounded query length (express.json takes 10mb; the public MCP door 32 KB), and
// query parsing is not cheap per character. Measured 2026-09-26 on buildFindProductsMultiContext:
// the brand lexicon re-normalises the whole query once per alias (~0.34 ms per character), so
// 30k characters of "1 1 1 ..." held the event loop for 7.8 s, and the budget parser was
// quadratic on digit runs (50k digits: 8.6 s). At 500 characters the worst measured shape took
// ~170 ms. The longest query in 30 days of prod logs was 65 characters.
//
// Which text counts is the text the search would use: every explicit query field, and the
// latest user message whenever it becomes the query -- the same rule buildFindProductsMultiContext
// applies (looksLikeRealQuery, from policy.js, so the two cannot drift apart).

const { extractLatestUserTextFromMessages, looksLikeRealQuery } = require('./policy');
const { DEFAULT_MAX_CHARS, resolveSearchQueryMaxChars } = require('./queryLengthLimit');

const SEARCH_OPERATIONS = new Set(['find_products_multi', 'find_products']);

function stringsOf(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Returns { field, length, max_chars } for the first query text over the cap, else null.
function findOverlongSearchQuery({ operation, payload, maxChars = resolveSearchQueryMaxChars() } = {}) {
  if (!SEARCH_OPERATIONS.has(String(operation || '').trim().toLowerCase())) return null;
  const body = isPlainObject(payload) ? payload : {};
  const search = isPlainObject(body.search) ? body.search : {};

  const fields = [
    ['search.query', search.query],
    ['search.q', search.q],
    ['search.keyword', search.keyword],
    ['search.text', search.text],
    ['query', body.query],
  ];
  for (const [field, value] of fields) {
    for (const text of stringsOf(value)) {
      const length = text.trim().length;
      if (length > maxChars) return { field, length, max_chars: maxChars };
    }
  }

  const queryFromSearch = typeof search.query === 'string' ? search.query : '';
  const queryFromPayload = typeof body.query === 'string' ? body.query : '';
  if (!looksLikeRealQuery(queryFromSearch) && !looksLikeRealQuery(queryFromPayload)) {
    const user = isPlainObject(body.user) ? body.user : {};
    const messages = body.messages || user.conversation_messages || [];
    const latest = extractLatestUserTextFromMessages(messages);
    if (latest.length > maxChars) {
      return { field: 'messages[].content', length: latest.length, max_chars: maxChars };
    }
  }
  return null;
}

module.exports = {
  DEFAULT_MAX_CHARS,
  findOverlongSearchQuery,
  resolveSearchQueryMaxChars,
};
