'use strict';
const { createHash } = require('node:crypto');
const MODE = 'consumer_answer_test';
const CONTRACT = 'consumer_query_v1';
const REQUIRED_CONTRACT = 'consumer_query_openai_web_required_v2';
const REQUIRED_PROFILE = 'openai_web_required_v2';
const REQUIRED_EXECUTION = Object.freeze({model:'chat-latest',tool:'web_search_preview',tool_choice:'required',max_output_tokens:900});
const SYSTEM = 'Answer the shopping question using live web search when useful. Give a helpful answer in ordinary prose with sources. Do not produce audit scores or diagnostic JSON.';
const hash = (s) => createHash('sha256').update(s).digest('hex');
function assertEnabled(input) {
  if (input.scan_mode !== MODE) return;
  const profile = input.context?.consumer_execution_profile;
  if (profile != null && profile !== REQUIRED_PROFILE) throw new Error('Unsupported consumer execution profile');
  if (profile === REQUIRED_PROFILE && ((input.provider && input.provider !== 'chatgpt') || (input.model && input.model !== REQUIRED_EXECUTION.model))) {
    throw new Error('Consumer execution profile does not match provider/model');
  }
  if (process.env.PIVOTA_CONSUMER_ANSWER_ENABLED !== 'true' || !Array.isArray(input.context?.queries) || !input.context.queries.length || input.context.queries.some(q => typeof q !== 'string' || !q.trim())) {
    throw new Error('consumer answer capture requires enabled gate and explicit nonempty queries');
  }
}
function requiresWeb(input) { return input?.scan_mode === MODE && input?.context?.consumer_execution_profile === REQUIRED_PROFILE; }
function prompt() { return { system: SYSTEM, userPerQuery: (query) => query }; }
function evidence({ query, rawText, provider, model, finishReason, chunks = [], retrievedSources = [], executionProfile = null, webSearchRequests = 0 }) {
  const failed = rawText.startsWith('__error__:');
  const transportComplete = !failed && rawText.trim().length > 0 && (
    (provider === 'chatgpt' && finishReason === 'completed') ||
    (provider === 'claude' && finishReason === 'end_turn') ||
    (provider === 'gemini' && finishReason === 'STOP')
  );
  // Provider completion does not establish a grounded shopping answer.
  const hasCitedSource = chunks.some(c => {
    try { const url = new URL(c.uri); return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname); }
    catch { return false; }
  });
  const required = executionProfile === REQUIRED_PROFILE;
  const complete = transportComplete && hasCitedSource && (!required || webSearchRequests > 0);
  const contract = required ? REQUIRED_CONTRACT : CONTRACT;
  const execution = required ? REQUIRED_EXECUTION : null;
  return {
    query, raw: rawText, parsed: null,
    evidence_kind: 'consumer_answer', prompt_contract: contract,
    answer: {
      text: failed ? null : rawText, sha256: failed ? null : hash(rawText),
      complete, transport_complete: transportComplete, qualification: 'cited_consumer_answer_v2',
      unknown_reason: transportComplete && !hasCitedSource ? 'answer_sources_missing' : null, finish_reason: finishReason || null,
      status: failed ? 'provider_failed' : complete ? 'complete' : 'incomplete',
      provider, model: model || null, captured_at: new Date().toISOString(),
      ...(execution ? {execution,web_search_requests:webSearchRequests} : {}),
      prompt_sha256: hash(JSON.stringify(execution ? [SYSTEM, query, execution] : [SYSTEM, query])),
    },
    grounding_chunks: chunks.map((c) => c.uri).filter(Boolean),
    grounding_sources: chunks.map((c) => ({ uri: c.uri, title: c.title })),
    retrieved_sources: retrievedSources.map((c) => ({ uri: c.uri, title: c.title })),
  };
}
module.exports = { MODE, CONTRACT, SYSTEM, assertEnabled, prompt, evidence, requiresWeb, REQUIRED_CONTRACT, REQUIRED_PROFILE, REQUIRED_EXECUTION };
