'use strict';

/**
 * Gemini API diagnostic script.
 *
 * Usage:
 *   GEMINI_API_KEY=<key> node scripts/diagnose-gemini.js
 *   node scripts/diagnose-gemini.js --key <key>
 *   node scripts/diagnose-gemini.js --prod-metrics https://pivota-agent-production.up.railway.app
 *
 * Tests:
 *   1. Validate API key(s) from env (GEMINI_API_KEY, GEMINI_API_KEY_1..10, feature keys)
 *   2. Measure actual Gemini latency over N calls
 *   3. Compare latency against configured timeout values
 *   4. Optionally check /metrics on a live deployment
 */

const LATENCY_ROUNDS = 5;
const TEST_PROMPT = 'Reply with exactly one word: "hello"';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { key: null, prodUrl: null, rounds: LATENCY_ROUNDS };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--key' || args[i] === '-k') && args[i + 1]) {
      opts.key = args[++i];
    } else if (args[i] === '--prod-metrics' && args[i + 1]) {
      opts.prodUrl = args[++i].replace(/\/+$/, '');
    } else if (args[i] === '--rounds' && args[i + 1]) {
      opts.rounds = Math.max(1, Math.min(20, Number(args[++i]) || LATENCY_ROUNDS));
    }
  }
  return opts;
}

function collectKeys(explicitKey) {
  const keys = new Map();

  if (explicitKey) keys.set('--key (CLI)', explicitKey);

  const envNames = [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'AURORA_SKIN_GEMINI_API_KEY',
    'AURORA_VISION_GEMINI_API_KEY',
    'AURORA_DIAG_GEMINI_API_KEY',
    'AURORA_RECO_GEMINI_API_KEY',
  ];
  for (const name of envNames) {
    const v = String(process.env[name] || '').trim();
    if (v) keys.set(name, v);
  }

  for (let i = 1; i <= 10; i++) {
    const v = String(process.env[`GEMINI_API_KEY_${i}`] || '').trim();
    if (v) keys.set(`GEMINI_API_KEY_${i}`, v);
  }

  return keys;
}

async function testKeyValidity(label, apiKey) {
  try {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const start = Date.now();
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: TEST_PROMPT,
      config: { maxOutputTokens: 16, temperature: 0 },
    });
    const latencyMs = Date.now() - start;
    const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text
      || resp?.text
      || JSON.stringify(resp).slice(0, 100);
    return { label, ok: true, latencyMs, text: String(text).trim().slice(0, 60) };
  } catch (err) {
    return {
      label,
      ok: false,
      error: err.message || String(err),
      status: err.status || err.statusCode || null,
    };
  }
}

async function measureLatency(apiKey, rounds) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const results = [];

  for (let i = 0; i < rounds; i++) {
    const start = Date.now();
    try {
      await ai.models.generateContent({
        model: MODEL,
        contents: `Round ${i + 1}: Reply with one word: "ok"`,
        config: { maxOutputTokens: 16, temperature: 0 },
      });
      results.push({ round: i + 1, ok: true, latencyMs: Date.now() - start });
    } catch (err) {
      results.push({
        round: i + 1,
        ok: false,
        latencyMs: Date.now() - start,
        error: (err.message || String(err)).slice(0, 120),
      });
    }
    if (i < rounds - 1) await new Promise((r) => setTimeout(r, 300));
  }

  const okResults = results.filter((r) => r.ok);
  const latencies = okResults.map((r) => r.latencyMs).sort((a, b) => a - b);
  const stats = latencies.length
    ? {
        min: latencies[0],
        max: latencies[latencies.length - 1],
        median: latencies[Math.floor(latencies.length / 2)],
        avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        p95: latencies[Math.floor(latencies.length * 0.95)] || latencies[latencies.length - 1],
      }
    : null;

  return { results, stats, successRate: `${okResults.length}/${results.length}` };
}

async function checkProdMetrics(baseUrl) {
  try {
    const resp = await fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
    const text = await resp.text();

    const circuitMatch = text.match(/gemini_circuit_open_rate\s+([\d.]+)/);
    const lines = text.split('\n').filter(
      (l) => l.includes('gemini') || l.includes('circuit') || l.includes('vision'),
    );
    return { ok: true, circuitOpenRate: circuitMatch ? circuitMatch[1] : 'not found', relevantLines: lines.slice(0, 20) };
  } catch (err) {
    return { ok: false, error: (err.message || String(err)).slice(0, 200) };
  }
}

async function checkProdHealthz(baseUrl) {
  try {
    const resp = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(8000) });
    const body = await resp.json().catch(() => resp.text());
    return { ok: resp.ok, status: resp.status, body };
  } catch (err) {
    return { ok: false, error: (err.message || String(err)).slice(0, 200) };
  }
}

function toSafeTimeout(value, fallback, min, max) {
  const n = Number(value);
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

function resolveConfiguredTimeouts() {
  return {
    'callGeminiJsonObject default': toSafeTimeout(
      process.env.AURORA_CALL_GEMINI_JSON_OBJECT_TIMEOUT_MS,
      10000,
      1000,
      120000,
    ),
    AURORA_INGREDIENT_SYNC_REPORT_TIMEOUT_MS: toSafeTimeout(
      process.env.AURORA_INGREDIENT_SYNC_REPORT_TIMEOUT_MS,
      8000,
      1500,
      15000,
    ),
    AURORA_ANALYSIS_STORY_LLM_TIMEOUT_MS: toSafeTimeout(
      process.env.AURORA_ANALYSIS_STORY_LLM_TIMEOUT_MS,
      10000,
      1200,
      12000,
    ),
    AURORA_PRODUCT_RELEVANCE_DUAL_LLM_TIMEOUT_MS: toSafeTimeout(
      process.env.AURORA_PRODUCT_RELEVANCE_DUAL_LLM_TIMEOUT_MS,
      8000,
      800,
      10000,
    ),
    AURORA_INGREDIENT_GOAL_ENRICH_TIMEOUT_MS: toSafeTimeout(
      process.env.AURORA_INGREDIENT_GOAL_ENRICH_TIMEOUT_MS,
      6000,
      1000,
      12000,
    ),
    'AURORA_BFF_RECO_PRELABEL (default)': toSafeTimeout(
      process.env.AURORA_BFF_RECO_PRELABEL_TIMEOUT_MS,
      5000,
      500,
      20000,
    ),
    AURORA_SKIN_VISION_TIMEOUT_MS: toSafeTimeout(
      process.env.AURORA_SKIN_VISION_TIMEOUT_MS,
      12000,
      2000,
      30000,
    ),
  };
}

function analyzeTimeoutFit(latencyStats, configuredTimeouts) {
  if (!latencyStats) return [];
  const analysis = [];
  for (const [name, timeoutMs] of Object.entries(configuredTimeouts || {})) {
    const wouldTimeout = latencyStats.p95 > timeoutMs;
    const medianWouldTimeout = latencyStats.median > timeoutMs;
    analysis.push({
      name,
      timeoutMs,
      p95_latency: latencyStats.p95,
      median_latency: latencyStats.median,
      p95_would_timeout: wouldTimeout,
      median_would_timeout: medianWouldTimeout,
      verdict: medianWouldTimeout
        ? 'CRITICAL: even median exceeds timeout'
        : wouldTimeout
          ? 'WARNING: p95 exceeds timeout'
          : 'OK',
    });
  }
  return analysis;
}

async function main() {
  const opts = parseArgs();
  const configuredTimeouts = resolveConfiguredTimeouts();
  console.log('=== Gemini API Diagnostic ===\n');
  console.log(`Model: ${MODEL}`);
  console.log(`Latency rounds: ${opts.rounds}\n`);
  console.log('--- Effective timeout configuration ---\n');
  for (const [name, timeoutMs] of Object.entries(configuredTimeouts)) {
    console.log(`  ${name}: ${timeoutMs}ms`);
  }

  // 1. Collect and validate keys
  const keys = collectKeys(opts.key);
  if (keys.size === 0) {
    console.error('ERROR: No Gemini API keys found. Set GEMINI_API_KEY or use --key <key>.');
    process.exit(1);
  }

  console.log(`--- Key validation (${keys.size} key(s) found) ---\n`);
  let firstValidKey = null;
  for (const [label, key] of keys) {
    const masked = key.slice(0, 6) + '...' + key.slice(-4);
    const result = await testKeyValidity(label, key);
    if (result.ok) {
      console.log(`  [PASS] ${label} (${masked}): ${result.latencyMs}ms, response: "${result.text}"`);
      if (!firstValidKey) firstValidKey = key;
    } else {
      console.log(`  [FAIL] ${label} (${masked}): ${result.error} (status: ${result.status})`);
    }
  }

  // 2. Measure latency
  if (firstValidKey) {
    console.log(`\n--- Latency measurement (${opts.rounds} rounds) ---\n`);
    const { results, stats, successRate } = await measureLatency(firstValidKey, opts.rounds);
    for (const r of results) {
      const status = r.ok ? 'OK' : `FAIL: ${r.error}`;
      console.log(`  Round ${r.round}: ${r.latencyMs}ms [${status}]`);
    }
    console.log(`\n  Success rate: ${successRate}`);
    if (stats) {
      console.log(`  Latency stats: min=${stats.min}ms, median=${stats.median}ms, avg=${stats.avg}ms, p95=${stats.p95}ms, max=${stats.max}ms`);
    }

    // 3. Timeout fitness analysis
    console.log('\n--- Timeout fitness analysis ---\n');
    const analysis = analyzeTimeoutFit(stats, configuredTimeouts);
    for (const a of analysis) {
      const icon = a.verdict.startsWith('CRITICAL') ? 'XX' : a.verdict.startsWith('WARNING') ? '!!' : 'OK';
      console.log(`  [${icon}] ${a.name}: timeout=${a.timeoutMs}ms vs p95=${a.p95_latency}ms -- ${a.verdict}`);
    }

    const criticalCount = analysis.filter((a) => a.verdict.startsWith('CRITICAL')).length;
    const warningCount = analysis.filter((a) => a.verdict.startsWith('WARNING')).length;
    if (criticalCount || warningCount) {
      console.log(`\n  SUMMARY: ${criticalCount} CRITICAL, ${warningCount} WARNING timeouts are too aggressive for measured latency.`);
      console.log('  -> These timeouts will frequently fire before Gemini responds, triggering circuit breakers.');
    } else {
      console.log('\n  SUMMARY: All configured timeouts appear adequate for current Gemini latency.');
    }
  } else {
    console.log('\n  Skipping latency measurement (no valid key).');
  }

  // 4. Production metrics
  if (opts.prodUrl) {
    console.log(`\n--- Production metrics (${opts.prodUrl}) ---\n`);

    const healthz = await checkProdHealthz(opts.prodUrl);
    console.log(`  /healthz: status=${healthz.status}, ok=${healthz.ok}`);
    if (healthz.body && typeof healthz.body === 'object') {
      console.log(`    aurora_routes_ready: ${healthz.body.aurora_routes_ready}`);
      console.log(`    required_routes_ok: ${healthz.body.required_routes_ok}`);
    }

    const metrics = await checkProdMetrics(opts.prodUrl);
    if (metrics.ok) {
      console.log(`  /metrics: gemini_circuit_open_rate = ${metrics.circuitOpenRate}`);
      if (metrics.relevantLines?.length) {
        console.log('  Relevant metric lines:');
        for (const line of metrics.relevantLines) {
          console.log(`    ${line}`);
        }
      }
    } else {
      console.log(`  /metrics: FAILED - ${metrics.error}`);
    }
  }

  console.log('\n=== Diagnostic complete ===');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
