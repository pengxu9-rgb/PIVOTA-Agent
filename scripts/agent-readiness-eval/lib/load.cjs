'use strict';

// LOAD MODE — disabled by default (--load). An open-loop arrival schedule that ramps linearly from rpsStart to
// rpsEnd over rampSeconds, holds rpsEnd for holdSeconds, and spreads arrivals round-robin over one MCP
// session per caller identity (READINESS_EVAL_CALLER_KEYS), so per-caller rate limits are exercised the way
// several partners would hit them, not as one hot key.
//
// Open loop: an arrival that finds maxConcurrency requests already in flight is NOT queued — it is recorded
// as `client_saturated` and dropped. Queuing would hide server slowness behind client back-pressure
// (coordinated omission); dropping keeps the measured latency honest and makes saturation visible.
//
// Stops at the first of: schedule end, maxRequests sent, the kill switch (file / SIGINT / SIGTERM), or the
// error-rate breaker (unavailable share of the last breakerWindow completions >= breakerErrorRate). Every
// limit is checked against the compiled-in HARD_CAPS before the run starts (safety.checkLoad).

const crypto = require('node:crypto');
const { toolPayload, readSearch } = require('./responses.cjs');
const { UNAVAILABLE_OUTCOMES, latencySummary, round4 } = require('./stats.cjs');
const { mulberry32 } = require('./journeys.cjs');

const LOAD_TOOLS = Object.freeze(['search_catalog']);

function fingerprint(secret) {
  return secret ? crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 8) : 'anon';
}

/** The caller identities for a load run: one per configured key, else the single configured credential. */
function callerIdentities(config) {
  const keys = config.secrets.callerKeys || [];
  if (keys.length) {
    return keys.map((k, i) => ({ label: `caller_${i + 1}`, fp: fingerprint(k), auth: config.auth === 'bearer' ? 'bearer' : 'api_key', secret: k }));
  }
  const secret = config.auth === 'bearer' ? config.secrets.bearerToken : config.auth === 'api_key' ? config.secrets.apiKey : null;
  return [{ label: 'caller_1', fp: fingerprint(secret), auth: config.auth, secret }];
}

function targetRps(load, tSec) {
  const ramp = Math.max(0, load.rampSeconds);
  if (ramp === 0 || tSec >= ramp) return load.rpsEnd;
  return load.rpsStart + (load.rpsEnd - load.rpsStart) * (tSec / ramp);
}

/**
 * @param {{ config, makeClient: (identity) => McpClient, querySet, killSwitch, log?, now?: () => number, sleep?: (ms) => Promise }} deps
 */
async function runLoad({ config, makeClient, querySet, killSwitch, log = () => {}, now = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const load = config.load;
  const bad = load.tools.filter((t) => !LOAD_TOOLS.includes(t));
  if (bad.length) throw new Error(`load mode supports only ${LOAD_TOOLS.join(', ')} (got ${bad.join(', ')})`);
  const identities = callerIdentities(config);
  const sessions = [];
  for (const id of identities) {
    const client = makeClient(id);
    const init = await client.initialize();
    sessions.push({ id, client, init_outcome: init.outcome });
  }
  const live = sessions.filter((s) => s.init_outcome === 'ok');
  const result = {
    started_at: new Date().toISOString(),
    settings: { ...load, callers: identities.map((i) => ({ label: i.label, fp: i.fp })) },
    sessions: sessions.map((s) => ({ caller: s.id.label, fp: s.id.fp, init_outcome: s.init_outcome })),
    stopped_by: null,
    calls: [],
  };
  if (!live.length) {
    result.stopped_by = 'no caller session initialized';
    result.finished_at = new Date().toISOString();
    return result;
  }
  const queries = querySet.queries.filter((q) => !(q.expect && q.expect.negative));
  const rng = mulberry32(config.seed + 7);
  const t0 = now();
  const durationSec = load.rampSeconds + load.holdSeconds;
  const recent = [];
  let inFlight = 0;
  let sent = 0;
  let rr = 0;
  const pending = new Set();

  const fire = (tSec) => {
    const s = live[rr++ % live.length];
    const q = queries[Math.floor(rng() * queries.length)];
    const tool = load.tools[Math.floor(rng() * load.tools.length)];
    inFlight += 1;
    sent += 1;
    const p = (async () => {
      const rec = await s.client.callTool(tool, { query: q.text, ...(q.market ? { market: q.market } : {}), page_size: config.pageSize });
      const payload = rec.outcome === 'ok' ? toolPayload(rec) : null;
      const search = payload && !payload.isError ? readSearch(payload) : null;
      const row = {
        phase: 'load',
        caller: s.id.label,
        tool,
        query_id: q.id,
        class: q.class,
        lang: q.lang,
        market: q.market,
        t_offset_s: Math.round(tSec * 100) / 100,
        target_rps: Math.round(targetRps(load, tSec) * 100) / 100,
        outcome: rec.outcome,
        http_status: rec.http_status,
        latency_ms: rec.latency_ms,
        ttfb_ms: rec.ttfb_ms,
        tool_error: Boolean(payload && payload.isError),
        tool_error_code: payload && payload.isError ? payload.errorCode : null,
        result_count: search ? search.products.length : null,
        failed_with_hits: search ? search.failed_with_hits : false,
      };
      result.calls.push(row);
      recent.push(UNAVAILABLE_OUTCOMES.has(rec.outcome));
      if (recent.length > load.breakerWindow) recent.shift();
      if (recent.length >= Math.min(load.breakerWindow, 10)) {
        const errRate = recent.filter(Boolean).length / recent.length;
        if (errRate >= load.breakerErrorRate) killSwitch.trip(`breaker: unavailable rate ${round4(errRate)} over last ${recent.length} calls`);
      }
    })().finally(() => {
      inFlight -= 1;
      pending.delete(p);
    });
    pending.add(p);
  };

  let tSec = 0;
  while (true) {
    const reason = killSwitch.check();
    if (reason) {
      result.stopped_by = reason;
      break;
    }
    tSec = (now() - t0) / 1000;
    if (tSec >= durationSec) {
      result.stopped_by = 'schedule complete';
      break;
    }
    if (sent >= load.maxRequests) {
      result.stopped_by = `max requests (${load.maxRequests})`;
      break;
    }
    if (inFlight >= load.maxConcurrency) {
      result.calls.push({ phase: 'load', outcome: 'client_saturated', t_offset_s: Math.round(tSec * 100) / 100, target_rps: Math.round(targetRps(load, tSec) * 100) / 100 });
    } else {
      fire(tSec);
    }
    await sleep(1000 / Math.max(0.01, targetRps(load, tSec)));
  }
  // Drain what is in flight (each call is bounded by the client timeout).
  await Promise.allSettled([...pending]);
  result.finished_at = new Date().toISOString();
  result.elapsed_s = Math.round(((now() - t0) / 1000) * 100) / 100;
  log(`load: sent ${sent}, stopped by ${result.stopped_by}`);
  return result;
}

/** Summaries for the scorecard: per caller and per 10-second window. */
function summarizeLoad(result, bucketSeconds = 10) {
  if (!result) return null;
  const sentCalls = result.calls.filter((c) => c.outcome !== 'client_saturated');
  const perCaller = {};
  for (const c of sentCalls) {
    const k = c.caller;
    perCaller[k] = perCaller[k] || { calls: 0, ok: 0, rate_limited: 0, unavailable: 0, tool_error: 0, latencies: [] };
    const pc = perCaller[k];
    pc.calls += 1;
    if (c.outcome === 'ok') pc.ok += 1;
    if (c.outcome === 'rate_limited') pc.rate_limited += 1;
    if (UNAVAILABLE_OUTCOMES.has(c.outcome)) pc.unavailable += 1;
    if (c.tool_error) pc.tool_error += 1;
    if (typeof c.latency_ms === 'number') pc.latencies.push(c.latency_ms);
  }
  for (const pc of Object.values(perCaller)) {
    pc.latency = latencySummary(pc.latencies);
    delete pc.latencies;
  }
  const buckets = {};
  for (const c of result.calls) {
    const b = Math.floor((c.t_offset_s || 0) / bucketSeconds) * bucketSeconds;
    buckets[b] = buckets[b] || { t: b, sent: 0, saturated: 0, unavailable: 0, rate_limited: 0, target_rps: c.target_rps, latencies: [] };
    const bk = buckets[b];
    if (c.outcome === 'client_saturated') bk.saturated += 1;
    else {
      bk.sent += 1;
      if (UNAVAILABLE_OUTCOMES.has(c.outcome)) bk.unavailable += 1;
      if (c.outcome === 'rate_limited') bk.rate_limited += 1;
      if (typeof c.latency_ms === 'number') bk.latencies.push(c.latency_ms);
    }
  }
  const timeline = Object.values(buckets)
    .sort((a, b) => a.t - b.t)
    .map((bk) => {
      const lat = latencySummary(bk.latencies);
      return { t: bk.t, target_rps: bk.target_rps, achieved_rps: round4(bk.sent / bucketSeconds), sent: bk.sent, saturated: bk.saturated, unavailable: bk.unavailable, rate_limited: bk.rate_limited, p50: lat.p50, p95: lat.p95 };
    });
  return {
    stopped_by: result.stopped_by,
    elapsed_s: result.elapsed_s,
    sent: sentCalls.length,
    saturated: result.calls.length - sentCalls.length,
    latency: latencySummary(sentCalls.map((c) => c.latency_ms)),
    per_caller: perCaller,
    timeline,
  };
}

module.exports = { runLoad, summarizeLoad, callerIdentities, targetRps, fingerprint, LOAD_TOOLS };
