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
    timeoutMs: Math.max(500, Number(process.env.CELESTIAL_COMMERCE_PROMPT_TIMEOUT_MS || 15000) || 15000),
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
      args.timeoutMs = Math.max(500, Number(next) || 15000);
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

  const minAssistantMessageLength = Number(rules.min_assistant_message_length || 0) || 0;
  if (minAssistantMessageLength > 0) {
    const assistantMessage = String(body?.assistantMessage || '').trim();
    if (assistantMessage.length < minAssistantMessageLength) {
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
    const headers = { 'Content-Type': 'application/json' };
    if (testCase.requires_auth && args.authToken) {
      headers.Authorization = /^Bearer\s+/i.test(args.authToken) ? args.authToken : `Bearer ${args.authToken}`;
    }
    if (testCase.requires_auth && args.agentApiKey) {
      headers['X-Agent-API-Key'] = args.agentApiKey;
    }

    let response;
    try {
      response = await requestJson(
        `${String(args.baseUrl || '').replace(/\/+$/, '')}${String(args.endpoint || '')}`,
        testCase.request,
        headers,
        args.timeoutMs,
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
        verdict: 'fail',
        reasons: [`request_failed:${error?.message || String(error)}`],
      });
      continue;
    }

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
