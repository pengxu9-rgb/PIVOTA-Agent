'use strict';

/**
 * Centralized Gemini API gate: single semaphore + token bucket + circuit breaker
 * that ALL modules must pass through before calling generateContent.
 *
 * Supports API key pooling (round-robin) and per-call-path metrics.
 */

function parseEnvInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

class GeminiGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GeminiGateError';
    this.code = code;
  }
}

// --------------- Semaphore ---------------

function createSemaphore(max) {
  const limit = Math.max(1, Number(max) || 1);
  let inUse = 0;
  const queue = [];

  function release() {
    inUse = Math.max(0, inUse - 1);
    const next = queue.shift();
    if (next) next();
  }

  async function acquire() {
    if (inUse < limit) {
      inUse += 1;
      return release;
    }
    return new Promise((resolve) => {
      queue.push(() => {
        inUse += 1;
        resolve(release);
      });
    });
  }

  return {
    acquire,
    snapshot: () => ({ max: limit, inUse, queued: queue.length }),
  };
}

// --------------- Token Bucket ---------------

function createTokenBucket({ ratePerMin, now } = {}) {
  const rate = Math.max(0, Number(ratePerMin) || 0);
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  let tokens = null;
  let lastRefillAt = null;

  function refill() {
    if (rate <= 0) return;
    const t = nowFn();
    if (tokens == null || lastRefillAt == null) {
      tokens = rate;
      lastRefillAt = t;
      return;
    }
    const elapsedMs = Math.max(0, t - lastRefillAt);
    const refillTokens = (elapsedMs * rate) / 60_000;
    tokens = Math.min(rate, tokens + refillTokens);
    lastRefillAt = t;
  }

  function take() {
    if (rate <= 0) return false;
    refill();
    if (tokens == null) tokens = rate;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  function waitForToken(timeoutMs = 5000) {
    if (take()) return Promise.resolve(true);
    if (rate <= 0) return Promise.resolve(false);
    const msPerToken = 60_000 / rate;
    const waitMs = Math.min(msPerToken + 50, timeoutMs);
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(take());
      }, waitMs);
    });
  }

  return {
    take,
    waitForToken,
    snapshot: () => ({
      ratePerMin: rate,
      tokensApprox: tokens == null ? null : Math.floor(tokens * 100) / 100,
      lastRefillAt,
    }),
  };
}

// --------------- Circuit Breaker ---------------

function createCircuitBreaker({ failThreshold, cooldownMs, now } = {}) {
  const threshold = Math.max(1, Number(failThreshold) || 5);
  const cooldown = Math.max(1, Number(cooldownMs) || 60_000);
  const nowFn = typeof now === 'function' ? now : () => Date.now();

  let consecutiveFailures = 0;
  let openUntilMs = 0;
  let halfOpenProbeInFlight = false;

  function isOpen() {
    return nowFn() < openUntilMs;
  }

  function recordSuccess() {
    consecutiveFailures = 0;
    openUntilMs = 0;
    halfOpenProbeInFlight = false;
  }

  function recordFailure() {
    consecutiveFailures += 1;
    if (consecutiveFailures >= threshold) {
      openUntilMs = nowFn() + cooldown;
      halfOpenProbeInFlight = false;
    }
  }

  function beginProbeIfAllowed() {
    const t = nowFn();
    if (t < openUntilMs) return { allowed: false, reason: 'open' };
    if (halfOpenProbeInFlight) return { allowed: false, reason: 'half_open_busy' };
    if (openUntilMs > 0 && t >= openUntilMs) {
      halfOpenProbeInFlight = true;
      return { allowed: true, probe: true };
    }
    return { allowed: true, probe: false };
  }

  function endProbe() {
    halfOpenProbeInFlight = false;
  }

  return {
    beginProbeIfAllowed,
    endProbe,
    recordSuccess,
    recordFailure,
    snapshot: () => ({
      circuitOpen: isOpen(),
      openUntilMs: openUntilMs || null,
      consecutiveFailures,
      failThreshold: threshold,
      cooldownMs: cooldown,
      halfOpenProbeInFlight,
    }),
  };
}

// --------------- Metrics Tracker ---------------

function createMetricsTracker() {
  const windowMs = 60_000;
  const events = [];

  function compact(now) {
    const cutoff = now - windowMs;
    while (events.length && events[0].ts < cutoff) events.shift();
  }

  function record({ route, status, latencyMs }) {
    const now = Date.now();
    compact(now);
    events.push({ ts: now, route: route || 'unknown', status, latencyMs: latencyMs || 0 });
  }

  function snapshot() {
    const now = Date.now();
    compact(now);
    const total = events.length;
    let rateLimited = 0;
    let timedOut = 0;
    let succeeded = 0;
    let totalLatency = 0;
    const byRoute = {};

    for (const e of events) {
      totalLatency += e.latencyMs;
      if (e.status === 'rate_limited') rateLimited += 1;
      else if (e.status === 'timeout') timedOut += 1;
      else if (e.status === 'success') succeeded += 1;

      if (!byRoute[e.route]) byRoute[e.route] = { total: 0, rate_limited: 0, timeout: 0, success: 0 };
      byRoute[e.route].total += 1;
      if (e.status === 'rate_limited') byRoute[e.route].rate_limited += 1;
      else if (e.status === 'timeout') byRoute[e.route].timeout += 1;
      else if (e.status === 'success') byRoute[e.route].success += 1;
    }

    return {
      window_ms: windowMs,
      rpm: total,
      rate_limited: rateLimited,
      timed_out: timedOut,
      succeeded,
      avg_latency_ms: total ? Math.round(totalLatency / total) : 0,
      by_route: byRoute,
    };
  }

  return { record, snapshot };
}

// --------------- API Key Pool ---------------

function createKeyPool() {
  const keys = [];
  let index = 0;
  let lastEnvFingerprint = null;

  function buildEnvFingerprint() {
    const parts = [];
    for (let i = 1; i <= 10; i += 1) {
      parts.push(String(process.env[`GEMINI_API_KEY_${i}`] || '').trim());
    }
    parts.push(String(process.env.AURORA_SKIN_GEMINI_API_KEY || '').trim());
    parts.push(String(process.env.GEMINI_API_KEY || '').trim());
    parts.push(String(process.env.GOOGLE_API_KEY || '').trim());
    return parts.join('||');
  }

  function loadKeys() {
    const nextFingerprint = buildEnvFingerprint();
    if (lastEnvFingerprint === nextFingerprint && keys.length) return;
    lastEnvFingerprint = nextFingerprint;
    keys.length = 0;
    index = 0;

    const pooled = [];
    for (let i = 1; i <= 10; i += 1) {
      const k = String(process.env[`GEMINI_API_KEY_${i}`] || '').trim();
      if (k) pooled.push(k);
    }
    const primary =
      String(process.env.AURORA_SKIN_GEMINI_API_KEY || '').trim() ||
      String(process.env.GEMINI_API_KEY || '').trim() ||
      String(process.env.GOOGLE_API_KEY || '').trim();
    if (pooled.length) {
      if (primary && !pooled.includes(primary)) pooled.unshift(primary);
      keys.push(...pooled);
    } else if (primary) {
      keys.push(primary);
    }
  }

  function next() {
    loadKeys();
    if (!keys.length) return null;
    const key = keys[index % keys.length];
    index = (index + 1) % keys.length;
    return key;
  }

  function count() {
    loadKeys();
    return keys.length;
  }

  return { next, count };
}

// --------------- Global Gate Singleton ---------------

let _gate = null;

function createGeminiGlobalGate({
  concurrencyMax,
  ratePerMin,
  circuitFailThreshold,
  circuitCooldownMs,
  timeoutStreakThreshold,
  timeoutMinSamples,
  timeoutRatioThresholdPct,
  timeoutWindowMs,
} = {}) {
  const semaphore = createSemaphore(concurrencyMax || 6);
  const bucket = createTokenBucket({ ratePerMin: ratePerMin || 300 });
  const circuit = createCircuitBreaker({
    failThreshold: circuitFailThreshold || 8,
    cooldownMs: circuitCooldownMs || 45_000,
  });
  const metrics = createMetricsTracker();
  const keyPool = createKeyPool();
  const timeoutPolicy = {
    streakThreshold: Math.max(1, Number(timeoutStreakThreshold) || 3),
    minSamples: Math.max(1, Number(timeoutMinSamples) || 8),
    ratioThresholdPct: Math.max(1, Math.min(100, Number(timeoutRatioThresholdPct) || 60)),
    windowMs: Math.max(1000, Number(timeoutWindowMs) || 60_000),
  };
  const timeoutSamples = [];
  let timeoutStreak = 0;

  function is429OrRateLimit(err) {
    if (!err) return false;
    const msg = String(err.message || '').toLowerCase();
    const status = Number(err.status || err.statusCode || 0);
    return (
      status === 429 ||
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('resource exhausted') ||
      msg.includes('quota')
    );
  }

  function isTimeout(err) {
    if (!err) return false;
    const msg = String(err.message || '').toLowerCase();
    const code = String(err.code || '').toLowerCase();
    const name = String(err.name || '').toLowerCase();
    return (
      name === 'aborterror' ||
      code.includes('timeout') ||
      code.includes('abort') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('deadline') ||
      msg.includes('aborted')
    );
  }

  function isTransientOverload(err) {
    if (!err) return false;
    const status = Number(err.status || err.statusCode || 0);
    const msg = String(err.message || '').toLowerCase();
    return status === 503 || msg.includes('503') || msg.includes('unavailable') || msg.includes('high demand');
  }

  function compactTimeoutSamples(now = Date.now()) {
    const cutoff = now - timeoutPolicy.windowMs;
    while (timeoutSamples.length && timeoutSamples[0].ts < cutoff) timeoutSamples.shift();
  }

  function recordTimeoutSample(timedOut) {
    const now = Date.now();
    compactTimeoutSamples(now);
    timeoutSamples.push({ ts: now, timeout: timedOut === true });
    if (timedOut === true) timeoutStreak += 1;
    else timeoutStreak = 0;
  }

  function getTimeoutWindowStats() {
    compactTimeoutSamples(Date.now());
    const samples = timeoutSamples.length;
    let timeoutCount = 0;
    for (const row of timeoutSamples) {
      if (row && row.timeout === true) timeoutCount += 1;
    }
    const timeoutRatioPct = samples > 0 ? (timeoutCount / samples) * 100 : 0;
    const roundedRatioPct = Math.round(timeoutRatioPct * 100) / 100;
    const byStreak = timeoutStreak >= timeoutPolicy.streakThreshold;
    const byRatio = samples >= timeoutPolicy.minSamples && roundedRatioPct >= timeoutPolicy.ratioThresholdPct;
    return {
      samples,
      timeoutCount,
      timeoutRatioPct: roundedRatioPct,
      timeoutStreak,
      wouldTrigger: byStreak || byRatio,
      triggerReason: byStreak ? 'streak' : byRatio ? 'ratio' : null,
    };
  }

  async function withGate(route, fn, { bypassCircuit = false } = {}) {
    const startedAt = Date.now();
    let probe = null;
    if (!bypassCircuit) {
      probe = circuit.beginProbeIfAllowed();
      if (!probe.allowed) {
        metrics.record({ route, status: 'circuit_open', latencyMs: 0 });
        throw new GeminiGateError('CIRCUIT_OPEN', `Gemini global circuit open (reason=${probe.reason})`);
      }
    }

    const gotToken = bucket.take();
    if (!gotToken) {
      const waited = await bucket.waitForToken(3000);
      if (!waited) {
        if (probe && probe.probe) circuit.endProbe();
        metrics.record({ route, status: 'rate_limited', latencyMs: Date.now() - startedAt });
        throw new GeminiGateError('GLOBAL_RATE_LIMITED', 'Gemini global rate limit exceeded');
      }
    }

    const release = await semaphore.acquire();
    try {
      const result = await fn();
      recordTimeoutSample(false);
      if (!bypassCircuit) circuit.recordSuccess();
      metrics.record({ route, status: 'success', latencyMs: Date.now() - startedAt });
      return result;
    } catch (err) {
      if (is429OrRateLimit(err)) {
        recordTimeoutSample(false);
        if (!bypassCircuit) circuit.recordFailure();
        metrics.record({ route, status: 'rate_limited', latencyMs: Date.now() - startedAt });
      } else if (isTimeout(err)) {
        recordTimeoutSample(true);
        const timeoutStats = getTimeoutWindowStats();
        if (!bypassCircuit && timeoutStats.wouldTrigger) {
          circuit.recordFailure();
        }
        metrics.record({ route, status: 'timeout', latencyMs: Date.now() - startedAt });
      } else if (isTransientOverload(err)) {
        recordTimeoutSample(false);
        metrics.record({ route, status: 'overloaded', latencyMs: Date.now() - startedAt });
      } else {
        recordTimeoutSample(false);
        if (!bypassCircuit) circuit.recordFailure();
        metrics.record({ route, status: 'error', latencyMs: Date.now() - startedAt });
      }
      throw err;
    } finally {
      if (probe && probe.probe) circuit.endProbe();
      release();
    }
  }

  function getApiKey() {
    return keyPool.next();
  }

  function snapshot() {
    const timeoutStats = getTimeoutWindowStats();
    return {
      gate: {
        concurrencyMax: semaphore.snapshot().max,
        ratePerMin: bucket.snapshot().ratePerMin,
        circuitOpen: circuit.snapshot().circuitOpen,
        keyCount: keyPool.count(),
      },
      metrics: metrics.snapshot(),
      _debug: {
        semaphore: semaphore.snapshot(),
        bucket: bucket.snapshot(),
        circuit: circuit.snapshot(),
        timeout_policy: {
          window_ms: timeoutPolicy.windowMs,
          streak_threshold: timeoutPolicy.streakThreshold,
          min_samples: timeoutPolicy.minSamples,
          ratio_threshold_pct: timeoutPolicy.ratioThresholdPct,
        },
        timeout_tracker: timeoutStats,
      },
    };
  }

  return { withGate, getApiKey, snapshot, metrics };
}

function getGeminiGlobalGate() {
  if (_gate) return _gate;
  _gate = createGeminiGlobalGate({
    concurrencyMax: Math.max(1, parseEnvInt(process.env.GEMINI_GLOBAL_CONCURRENCY_MAX, 6)),
    ratePerMin: Math.max(1, parseEnvInt(process.env.GEMINI_GLOBAL_RATE_PER_MIN, 300)),
    circuitFailThreshold: Math.max(1, parseEnvInt(process.env.GEMINI_GLOBAL_CIRCUIT_FAIL_THRESHOLD, 8)),
    circuitCooldownMs: Math.max(1, parseEnvInt(process.env.GEMINI_GLOBAL_CIRCUIT_COOLDOWN_MS, 45_000)),
    timeoutStreakThreshold: Math.max(1, parseEnvInt(process.env.GEMINI_GLOBAL_CIRCUIT_TIMEOUT_STREAK_THRESHOLD, 3)),
    timeoutMinSamples: Math.max(1, parseEnvInt(process.env.GEMINI_GLOBAL_CIRCUIT_TIMEOUT_MIN_SAMPLES, 8)),
    timeoutRatioThresholdPct: Math.max(
      1,
      Math.min(100, parseEnvInt(process.env.GEMINI_GLOBAL_CIRCUIT_TIMEOUT_RATIO_THRESHOLD_PCT, 60)),
    ),
    timeoutWindowMs: Math.max(1000, parseEnvInt(process.env.GEMINI_GLOBAL_CIRCUIT_TIMEOUT_WINDOW_MS, 60_000)),
  });
  return _gate;
}

function resetGlobalGateForTest() {
  _gate = null;
}

module.exports = {
  GeminiGateError,
  createGeminiGlobalGate,
  getGeminiGlobalGate,
  resetGlobalGateForTest,
};
