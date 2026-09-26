'use strict';

// The search query is capped at SEARCH_QUERY_MAX_CHARS (queryLengthLimit.js, default 500): the query
// itself over the limit is rejected at the invoke route with 400 QUERY_TOO_LONG, and over-long history
// is truncated to the limit so the request still searches.
//
// Why: nothing bounded query length (express.json takes 10mb; the public MCP door 32 KB), and query
// parsing is not cheap per character. Measured 2026-09-26 on buildFindProductsMultiContext: the brand
// lexicon re-normalises the whole query once per alias (~0.34 ms per character), so 30k characters of
// "1 1 1 ..." held the event loop for 7.8 s, and the budget parser was quadratic on digit runs (50k
// digits: 8.6 s). At 500 characters the worst measured shape took ~170 ms. The longest query in 30
// days of prod logs was 65 characters.
//
// THE QUERY is what buildFindProductsMultiContext searches for: every explicit query field, and the
// latest user message when it becomes the query (the same looksLikeRealQuery rule, from policy.js, so
// the two cannot drift apart). Over the limit, it is rejected: a caller that sent it can shorten it.
//
// HISTORY is the user's recent queries and every other user turn. It is parsed too --
// understandShoppingQuery can promote a recent query or prior turn to the effective query on a
// continuation ("previous search") or refinement, and extractIntentRuleBased classifies every user
// message -- so it must be bounded, but it is TRUNCATED, not rejected: chat clients re-send their last
// messages, and one pasted ingredient list would otherwise make every later search in that
// conversation fail until it scrolled out.

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

function isSearchOperation(operation) {
  return SEARCH_OPERATIONS.has(String(operation || '').trim().toLowerCase());
}

function conversationMessagesOf(body) {
  const user = isPlainObject(body.user) ? body.user : {};
  const messages = body.messages || user.conversation_messages;
  return Array.isArray(messages) ? messages : [];
}

// The latest user message, when buildFindProductsMultiContext would search for it.
function latestUserMessageAsQuery(body) {
  const search = isPlainObject(body.search) ? body.search : {};
  const queryFromSearch = typeof search.query === 'string' ? search.query : '';
  const queryFromPayload = typeof body.query === 'string' ? body.query : '';
  if (looksLikeRealQuery(queryFromSearch) || looksLikeRealQuery(queryFromPayload)) return '';
  return extractLatestUserTextFromMessages(conversationMessagesOf(body));
}

// Returns { field, length, max_chars } when the query itself is over the limit, else null.
function findOverlongSearchQuery({ operation, payload, maxChars = resolveSearchQueryMaxChars() } = {}) {
  if (!isSearchOperation(operation)) return null;
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

  if (String(operation).trim().toLowerCase() === 'find_products_multi') {
    const latest = latestUserMessageAsQuery(body);
    if (latest.length > maxChars) {
      return { field: 'messages[].content', length: latest.length, max_chars: maxChars };
    }
  }
  return null;
}

function cut(text, maxChars) {
  return text.trim().length > maxChars ? text.trim().slice(0, maxChars) : text;
}

// Truncates over-long history in place (recent queries, user turns) and returns how many entries it
// cut. Run after findOverlongSearchQuery has passed, so the query itself is never truncated here.
function truncateSearchHistory({ operation, payload, maxChars = resolveSearchQueryMaxChars() } = {}) {
  if (!isSearchOperation(operation) || !isPlainObject(payload)) return 0;
  let truncated = 0;
  const user = isPlainObject(payload.user) ? payload.user : null;
  if (user) {
    for (const field of ['session_recent_queries', 'recent_queries']) {
      if (!Array.isArray(user[field])) continue;
      user[field] = user[field].map((entry) => {
        if (typeof entry !== 'string') return entry;
        const next = cut(entry, maxChars);
        if (next !== entry) truncated += 1;
        return next;
      });
    }
  }
  for (const message of conversationMessagesOf(payload)) {
    if (!isPlainObject(message) || String(message.role || '').toLowerCase() !== 'user') continue;
    if (typeof message.content !== 'string') continue;
    const next = cut(message.content, maxChars);
    if (next !== message.content) {
      message.content = next;
      truncated += 1;
    }
  }
  return truncated;
}

module.exports = {
  DEFAULT_MAX_CHARS,
  findOverlongSearchQuery,
  resolveSearchQueryMaxChars,
  truncateSearchHistory,
};
