'use strict';
const { createHash } = require('node:crypto');
const MODE = 'consumer_answer_test';
const CONTRACT = 'consumer_query_v1';
const SYSTEM = 'Answer the shopping question using live web search when useful. Give a helpful answer in ordinary prose with sources. Do not produce audit scores or diagnostic JSON.';
const hash = (s) => createHash('sha256').update(s).digest('hex');
function assertEnabled(input) {
  if (input.scan_mode !== MODE) return;
  if (process.env.PIVOTA_CONSUMER_ANSWER_ENABLED !== 'true' || !Array.isArray(input.context?.queries) || !input.context.queries.length || input.context.queries.some(q => typeof q !== 'string' || !q.trim())) {
    throw new Error('consumer answer capture requires enabled gate and explicit nonempty queries');
  }
}
function prompt() { return { system: SYSTEM, userPerQuery: (query) => query }; }
function evidence({ query, rawText, provider, model, finishReason, chunks = [], retrievedSources = [] }) {
  const failed = rawText.startsWith('__error__:');
  const complete = !failed && rawText.trim().length > 0 && (
    (provider === 'chatgpt' && finishReason === 'completed') ||
    (provider === 'claude' && finishReason === 'end_turn') ||
    (provider === 'gemini' && finishReason === 'STOP')
  );
  return {
    query, raw: rawText, parsed: null,
    evidence_kind: 'consumer_answer', prompt_contract: CONTRACT,
    answer: {
      text: failed ? null : rawText, sha256: failed ? null : hash(rawText),
      complete, finish_reason: finishReason || null,
      status: failed ? 'provider_failed' : complete ? 'complete' : 'incomplete',
      provider, model: model || null, captured_at: new Date().toISOString(),
      prompt_sha256: hash(JSON.stringify([SYSTEM, query])),
    },
    grounding_chunks: chunks.map((c) => c.uri).filter(Boolean),
    grounding_sources: chunks.map((c) => ({ uri: c.uri, title: c.title })),
    retrieved_sources: retrievedSources.map((c) => ({ uri: c.uri, title: c.title })),
  };
}
module.exports = { MODE, CONTRACT, SYSTEM, assertEnabled, prompt, evidence };
