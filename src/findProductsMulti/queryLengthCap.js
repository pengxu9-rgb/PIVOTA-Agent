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
// Which text counts is every text the search parses as a query: the explicit query fields, the
// user's recent queries, and (find_products_multi) every user message. Recent queries and prior user
// turns are not only history -- understandShoppingQuery re-parses them and can promote one to the
// effective query on a continuation ("previous search") or refinement, and extractIntentRuleBased
// classifies every user message -- so a short query beside a 30k-character history entry would
// otherwise walk straight past the cap.

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

  const user = isPlainObject(body.user) ? body.user : {};
  for (const field of ['session_recent_queries', 'recent_queries']) {
    for (const text of stringsOf(user[field])) {
      const length = text.trim().length;
      if (length > maxChars) return { field: `user.${field}[]`, length, max_chars: maxChars };
    }
  }

  // Only the multi operation builds a conversation context from messages.
  if (String(operation).trim().toLowerCase() !== 'find_products_multi') return null;
  const messages = body.messages || user.conversation_messages;
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!isPlainObject(message) || String(message.role || '').toLowerCase() !== 'user') continue;
    if (typeof message.content !== 'string') continue;
    const length = message.content.trim().length;
    if (length > maxChars) return { field: 'messages[].content', length, max_chars: maxChars };
  }
  return null;
}

module.exports = {
  DEFAULT_MAX_CHARS,
  findOverlongSearchQuery,
  resolveSearchQueryMaxChars,
};
