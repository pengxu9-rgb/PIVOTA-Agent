#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const repoRoot = path.resolve(__dirname, '..');
  const args = {
    baseUrl:
      process.env.CELESTIAL_COMMERCE_PROMPT_BASE_URL ||
      process.env.BASE_URL ||
      'https://agent.pivota.cc',
    endpoint: process.env.CELESTIAL_COMMERCE_PROMPT_ENDPOINT || '/ui/chat',
    casesPath:
      process.env.CELESTIAL_COMMERCE_PROMPT_CASES ||
      path.join(__dirname, 'fixtures', 'celestial_commerce_core_prompt_live_smoke.json'),
    outDir:
      process.env.CELESTIAL_COMMERCE_PROMPT_OUT_DIR ||
      path.join(repoRoot, 'reports', 'celestial-commerce-core-prompt-live-smoke'),
    authToken: process.env.AUTH_TOKEN || process.env.CELESTIAL_COMMERCE_PROMPT_AUTH_TOKEN || '',
    agentApiKey:
      process.env.AGENT_API_KEY || process.env.CELESTIAL_COMMERCE_PROMPT_AGENT_API_KEY || '',
    timeoutMs: Math.max(500, Number(process.env.CELESTIAL_COMMERCE_PROMPT_TIMEOUT_MS || 25000) || 25000),
    retries: Math.max(0, Number(process.env.CELESTIAL_COMMERCE_PROMPT_RETRIES || 1) || 0),
    retryBackoffMs: Math.max(
      0,
      Number(process.env.CELESTIAL_COMMERCE_PROMPT_RETRY_BACKOFF_MS || 500) || 500,
    ),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--base-url' && next) args.baseUrl = String(next);
    if (token === '--endpoint' && next) args.endpoint = String(next);
    if (token === '--cases' && next) args.casesPath = path.resolve(String(next));
    if (token === '--out-dir' && next) args.outDir = path.resolve(String(next));
    if (token === '--auth-token' && next) args.authToken = String(next);
    if (token === '--agent-api-key' && next) args.agentApiKey = String(next);
    if (token === '--timeout-ms' && next) {
      args.timeoutMs = Math.max(500, Number(next) || 25000);
    }
    if (token === '--retries' && next) {
      args.retries = Math.max(0, Number(next) || 0);
    }
    if (token === '--retry-backoff-ms' && next) {
      args.retryBackoffMs = Math.max(0, Number(next) || 500);
    }
  }

  return args;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '_');
}

function getPath(obj, rawPath) {
  const pathText = String(rawPath || '').trim();
  if (!pathText) return undefined;
  return pathText
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => {
      if (acc == null) return undefined;
      if (Array.isArray(acc)) {
        const index = Number(key);
        return Number.isInteger(index) ? acc[index] : undefined;
      }
      if (typeof acc === 'object') return acc[key];
      return undefined;
    }, obj);
}

function valuesEqual(left, right) {
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right);
  if (typeof left === 'boolean' || typeof right === 'boolean') return Boolean(left) === Boolean(right);
  return String(left) === String(right);
}

function extractAssistantMessage(body) {
  const direct = String(body?.assistantMessage || '').trim();
  if (direct) return direct;

  const assistantMessage =
    body?.assistant_message && typeof body.assistant_message === 'object'
      ? String(body.assistant_message.content || '').trim()
      : '';
  if (assistantMessage) return assistantMessage;

  const assistantText = String(body?.assistant_text || '').trim();
  if (assistantText) return assistantText;

  const cards = Array.isArray(body?.cards) ? body.cards : [];
  for (const card of cards) {
    if (!card || typeof card !== 'object') continue;
    if (String(card.card_type || '').trim().toLowerCase() !== 'text_response') continue;
    const sections = Array.isArray(card.sections) ? card.sections : [];
    for (const section of sections) {
      const text = String(
        section?.text ||
          section?.text_zh ||
          section?.text_en ||
          section?.content ||
          '',
      ).trim();
      if (text) return text;
    }
  }

  return '';
}

function evaluateRules(body, rules = {}) {
  const reasons = [];
  const mustHavePaths = Array.isArray(rules.must_have_paths) ? rules.must_have_paths : [];
  for (const rawPath of mustHavePaths) {
    const value = getPath(body, rawPath);
    const missing = value == null || (typeof value === 'string' && !String(value).trim());
    if (missing) reasons.push(`missing_path:${rawPath}`);
  }

  const mustEqualPaths =
    rules.must_equal_paths && typeof rules.must_equal_paths === 'object' ? rules.must_equal_paths : {};
  for (const [rawPath, expected] of Object.entries(mustEqualPaths)) {
    const actual = getPath(body, rawPath);
    if (!valuesEqual(actual, expected)) {
      reasons.push(
        `path_mismatch:${rawPath}:expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
      );
    }
  }

  const requiredCardTypes = Array.isArray(rules.required_card_types) ? rules.required_card_types : [];
  if (requiredCardTypes.length > 0) {
    const presentCardTypes = new Set(
      (Array.isArray(body?.cards) ? body.cards : [])
        .map((card) => String(card?.type || card?.card_type || '').trim().toLowerCase())
        .filter(Boolean),
    );
    for (const rawType of requiredCardTypes) {
      const cardType = String(rawType || '').trim().toLowerCase();
      if (cardType && !presentCardTypes.has(cardType)) {
        reasons.push(`missing_card_type:${cardType}`);
      }
    }
  }

  const hasAllowNullAssistantMessageRule =
    Object.prototype.hasOwnProperty.call(rules || {}, 'allow_null_assistant_message');
  const allowNullAssistantMessage = rules.allow_null_assistant_message === true;
  const hasAssistantMessageField =
    Object.prototype.hasOwnProperty.call(body || {}, 'assistant_message');
  const assistantMessageIsNull = hasAssistantMessageField && body?.assistant_message === null;
  if (assistantMessageIsNull && hasAllowNullAssistantMessageRule && !allowNullAssistantMessage) {
    reasons.push('assistant_message_null_not_allowed');
  }

  const minAssistantMessageLength = Number(rules.min_assistant_message_length || 0) || 0;
  if (minAssistantMessageLength > 0) {
    const assistantMessage = extractAssistantMessage(body);
    if (!(allowNullAssistantMessage && assistantMessageIsNull) && assistantMessage.length < minAssistantMessageLength) {
      reasons.push(
        `assistant_message_too_short:expected>=${minAssistantMessageLength} actual=${assistantMessage.length}`,
      );
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}

function readCases(casesPath) {
  const payload = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const list = Array.isArray(payload) ? payload : Array.isArray(payload.prompt_cases) ? payload.prompt_cases : [];
  return list.map((item) => ({
    id: String(item.id || '').trim(),
    title: String(item.title || item.id || '').trim(),
    family: String(item.family || '').trim() || 'prompt',
    requires_auth: item.requires_auth === true,
    request:
      item.request && typeof item.request === 'object' && !Array.isArray(item.request) ? item.request : {},
    correctness:
      item.correctness && typeof item.correctness === 'object' && !Array.isArray(item.correctness)
        ? item.correctness
        : {},
    observability:
      item.observability && typeof item.observability === 'object' && !Array.isArray(item.observability)
        ? item.observability
        : {},
  })).filter((item) => item.id);
}

function normalizeHeaderMap(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [String(key || '').trim(), String(value || '').trim()])
      .filter(([key, value]) => key && value),
  );
}

function hasHeader(headers, name) {
  const expected = String(name || '').trim().toLowerCase();
  return Object.keys(headers || {}).some((key) => String(key || '').trim().toLowerCase() === expected);
}

function inferPromptSmokeLanguage(payload) {
  const texts = [];
  if (typeof payload?.message === 'string') texts.push(payload.message);
  if (typeof payload?.text === 'string') texts.push(payload.text);
  if (Array.isArray(payload?.messages)) {
    for (const item of payload.messages) {
      if (typeof item?.content === 'string') texts.push(item.content);
    }
  }
  const combined = texts.join(' ');
  return /[\u3400-\u9fff]/u.test(combined) ? 'CN' : 'EN';
}

function normalizePromptMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((item) => ({
      role: String(item?.role || '').trim() || 'user',
      content: String(item?.content || '').trim(),
    }))
    .filter((item) => item.content);
}

function normalizeRequestPayload(endpoint, payload) {
  const next =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
  if (String(endpoint || '').trim() !== '/v1/chat') return next;

  const messages = normalizePromptMessages(next.messages);
  let message = String(next.message || next.text || '').trim();
  if (!message && messages.length > 0) {
    const lastUserMessage = [...messages]
      .reverse()
      .find((item) => String(item.role || '').trim().toLowerCase() === 'user');
    if (lastUserMessage) {
      message = String(lastUserMessage.content || '').trim();
      const lastMessage = messages[messages.length - 1];
      if (
        lastMessage &&
        String(lastMessage.role || '').trim().toLowerCase() === 'user' &&
        String(lastMessage.content || '').trim() === message
      ) {
        next.messages = messages.slice(0, -1);
      } else {
        next.messages = messages;
      }
    }
  } else if (messages.length > 0) {
    next.messages = messages;
  }

  if (message) next.message = message;
  else delete next.message;

  if (!Array.isArray(next.messages) || next.messages.length === 0) {
    delete next.messages;
  }

  return next;
}

async function requestJson(url, payload, headers, timeoutMs) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch (_error) {
    body = { _raw: text };
  }
  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    responseHeaders[String(key || '').toLowerCase()] = String(value || '').trim();
  });
  return {
    status: response.status,
    headers: responseHeaders,
    body,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryResponse(response) {
  const status = Number(response?.status || 0) || 0;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function requestJsonWithRetries(url, payload, headers, options = {}) {
  const timeoutMs = Math.max(500, Number(options.timeoutMs || 25000) || 25000);
  const retries = Math.max(0, Number(options.retries || 0) || 0);
  const retryBackoffMs = Math.max(0, Number(options.retryBackoffMs || 500) || 500);
  let lastError = null;
  let lastResponse = null;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const response = await requestJson(url, payload, headers, timeoutMs);
      lastResponse = response;
      if (attempt <= retries && shouldRetryResponse(response)) {
        if (retryBackoffMs > 0) await sleep(retryBackoffMs * attempt);
        continue;
      }
      return {
        response,
        attemptsUsed: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt > retries) throw error;
      if (retryBackoffMs > 0) await sleep(retryBackoffMs * attempt);
    }
  }

  if (lastResponse) {
    return {
      response: lastResponse,
      attemptsUsed: retries + 1,
    };
  }
  throw lastError || new Error('request_failed');
}

function renderMarkdown(report) {
  const lines = ['# Celestial Commerce Core Prompt Live Smoke', ''];
  lines.push(`- Generated at: ${report.generated_at}`);
  lines.push(`- Base URL: ${report.base_url}`);
  lines.push(`- Endpoint: ${report.endpoint}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total cases: ${report.summary.case_count}`);
  lines.push(`- Pass count: ${report.summary.pass_count}`);
  lines.push(`- Fail count: ${report.summary.fail_count}`);
  lines.push('');
  lines.push('## Cases');
  lines.push('');
  for (const result of report.results) {
    lines.push(`### ${result.id}`);
    lines.push(`- Family: ${result.family}`);
    lines.push(`- Status: ${result.status}`);
    lines.push(`- Prompt intent: ${result.prompt_intent || 'missing'}`);
    lines.push(`- Conversation progress: ${result.conversation_progress || 'missing'}`);
    lines.push(`- Early decision: ${result.early_decision || 'missing'}`);
    lines.push(`- Verdict: ${result.verdict}`);
    if (result.reasons.length > 0) {
      lines.push(`- Reasons: ${result.reasons.join(', ')}`);
    }
    if (Number(result.attempts_used || 1) > 1) {
      lines.push(`- Attempts: ${result.attempts_used}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = readCases(args.casesPath);
  const runDir = path.join(args.outDir, timestamp());
  fs.mkdirSync(runDir, { recursive: true });
  const results = [];

  for (const testCase of cases) {
    const rawRequestPayload =
      testCase.request && typeof testCase.request === 'object' && !Array.isArray(testCase.request)
        ? { ...testCase.request }
        : {};
    const requestHeaders = normalizeHeaderMap(rawRequestPayload.headers);
    delete rawRequestPayload.headers;
    const requestPayload = normalizeRequestPayload(args.endpoint, rawRequestPayload);

    const headers = { 'Content-Type': 'application/json', ...requestHeaders };
    if (String(args.endpoint || '').trim() === '/v1/chat') {
      if (!hasHeader(headers, 'X-Aurora-UID')) {
        headers['X-Aurora-UID'] = `commerce_prompt_smoke_${testCase.id}`;
      }
      if (!hasHeader(headers, 'X-Trace-ID')) {
        headers['X-Trace-ID'] = `trace_${testCase.id}`;
      }
      if (!hasHeader(headers, 'X-Brief-ID')) {
        headers['X-Brief-ID'] = `brief_${testCase.id}`;
      }
      if (!hasHeader(headers, 'X-Lang')) {
        headers['X-Lang'] = inferPromptSmokeLanguage(requestPayload);
      }
    }
    if (testCase.requires_auth && args.authToken) {
      headers.Authorization = /^Bearer\s+/i.test(args.authToken) ? args.authToken : `Bearer ${args.authToken}`;
    }
    if (testCase.requires_auth && args.agentApiKey) {
      headers['X-Agent-API-Key'] = args.agentApiKey;
    }

    let requestOutcome;
    try {
      requestOutcome = await requestJsonWithRetries(
        `${String(args.baseUrl || '').replace(/\/+$/, '')}${String(args.endpoint || '')}`,
        requestPayload,
        headers,
        {
          timeoutMs: args.timeoutMs,
          retries: args.retries,
          retryBackoffMs: args.retryBackoffMs,
        },
      );
    } catch (error) {
      results.push({
        id: testCase.id,
        title: testCase.title,
        family: testCase.family,
        status: 0,
        prompt_intent: null,
        conversation_progress: null,
        early_decision: null,
        decision_owner: null,
        attempts_used: args.retries + 1,
        verdict: 'fail',
        reasons: [`request_failed:${error?.message || String(error)}`],
      });
      continue;
    }

    const response = requestOutcome.response;

    const correctness = evaluateRules(response.body, testCase.correctness);
    const observability = evaluateRules(response.body, testCase.observability);
    const reasons = [];
    if (Number(response.status) !== Number(testCase.correctness.expect_http_status || 200)) {
      reasons.push(
        `http_status_mismatch:expected=${Number(testCase.correctness.expect_http_status || 200)} actual=${response.status}`,
      );
    }
    reasons.push(...correctness.reasons, ...observability.reasons);
    const meta = response.body?.meta && typeof response.body.meta === 'object' ? response.body.meta : {};

    results.push({
      id: testCase.id,
      title: testCase.title,
      family: testCase.family,
      status: response.status,
      prompt_intent: String(meta.prompt_intent || '').trim() || null,
      conversation_progress: String(meta.conversation_progress || '').trim() || null,
      early_decision: String(meta.early_decision || '').trim() || null,
      decision_owner: String(meta.decision_owner || '').trim() || null,
      attempts_used: Number(requestOutcome.attemptsUsed || 1) || 1,
      verdict: reasons.length === 0 ? 'pass' : 'fail',
      reasons,
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    base_url: args.baseUrl,
    endpoint: args.endpoint,
    summary: {
      case_count: results.length,
      pass_count: results.filter((item) => item.verdict === 'pass').length,
      fail_count: results.filter((item) => item.verdict === 'fail').length,
    },
    results,
  };

  const jsonPath = path.join(runDir, 'summary.json');
  const markdownPath = path.join(runDir, 'README.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderMarkdown(report));

  process.stdout.write(
    `${JSON.stringify({
      ok: report.summary.fail_count === 0,
      json_path: jsonPath,
      markdown_path: markdownPath,
      pass_count: report.summary.pass_count,
      fail_count: report.summary.fail_count,
    })}\n`,
  );

  if (report.summary.fail_count > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
