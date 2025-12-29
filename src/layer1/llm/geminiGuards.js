function parseEnvInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

class GeminiGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GeminiGuardError";
    this.code = code;
  }
}

function createSemaphore(max) {
  const limit = Math.max(1, Number(max) || 1);
  let inUse = 0;
  const queue = [];

  function releaseOne() {
    inUse = Math.max(0, inUse - 1);
    const next = queue.shift();
    if (next) next();
  }

  async function acquire() {
    if (inUse < limit) {
      inUse += 1;
      return releaseOne;
    }
    return new Promise((resolve) => {
      queue.push(() => {
        inUse += 1;
        resolve(releaseOne);
      });
    });
  }

  return {
    acquire,
    snapshot: () => ({ max: limit, inUse, queued: queue.length }),
  };
}

function createTokenBucket({ ratePerMin, now }) {
  const rate = Math.max(0, Number(ratePerMin) || 0);
  const nowFn = typeof now === "function" ? now : () => Date.now();
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

  return {
    take,
    snapshot: () => ({
      ratePerMin: rate,
      tokensApprox: tokens == null ? null : Math.floor(tokens * 100) / 100,
      lastRefillAt,
    }),
  };
}

function createCircuitBreaker({ failThreshold, cooldownMs, now }) {
  const threshold = Math.max(1, Number(failThreshold) || 1);
  const cooldown = Math.max(1, Number(cooldownMs) || 1);
  const nowFn = typeof now === "function" ? now : () => Date.now();

  let consecutiveFailures = 0;
  let openUntilMs = 0;
  let halfOpenProbeInFlight = false;

  function isOpen() {
    const t = nowFn();
    return t < openUntilMs;
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
    if (t < openUntilMs) return { allowed: false, reason: "open" };
    if (halfOpenProbeInFlight) return { allowed: false, reason: "half_open_busy" };
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

function createGeminiGuards({
  concurrencyMax = 2,
  ratePerMin = 60,
  circuitFailThreshold = 5,
  circuitCooldownMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const semaphore = createSemaphore(concurrencyMax);
  const bucket = createTokenBucket({ ratePerMin, now });
  const circuit = createCircuitBreaker({ failThreshold: circuitFailThreshold, cooldownMs: circuitCooldownMs, now });

  async function withGuards(kind, fn) {
    const probe = circuit.beginProbeIfAllowed();
    if (!probe.allowed) {
      throw new GeminiGuardError("CIRCUIT_OPEN", `Gemini circuit open (reason=${probe.reason})`);
    }

    if (!bucket.take()) {
      if (probe.probe) circuit.endProbe();
      throw new GeminiGuardError("RATE_LIMITED", "Gemini rate limit exceeded");
    }

    const release = await semaphore.acquire();
    try {
      const out = await fn();
      circuit.recordSuccess();
      return out;
    } catch (err) {
      circuit.recordFailure();
      throw err;
    } finally {
      if (probe.probe) circuit.endProbe();
      release();
    }
  }

  return {
    withGuards,
    snapshot: () => ({
      limiter: {
        concurrencyMax: semaphore.snapshot().max,
        ratePerMin: bucket.snapshot().ratePerMin,
        circuitOpen: circuit.snapshot().circuitOpen,
      },
      _debug: {
        semaphore: semaphore.snapshot(),
        bucket: bucket.snapshot(),
        circuit: circuit.snapshot(),
      },
    }),
  };
}

let _singleton = null;

function getGeminiGuards() {
  if (_singleton) return _singleton;
  _singleton = createGeminiGuards({
    concurrencyMax: Math.max(1, parseEnvInt(process.env.GEMINI_CONCURRENCY_MAX, 2)),
    ratePerMin: Math.max(0, parseEnvInt(process.env.GEMINI_RATE_PER_MIN, 60)),
    circuitFailThreshold: Math.max(1, parseEnvInt(process.env.GEMINI_CIRCUIT_FAIL_THRESHOLD, 5)),
    circuitCooldownMs: Math.max(1, parseEnvInt(process.env.GEMINI_CIRCUIT_COOLDOWN_MS, 60_000)),
  });
  return _singleton;
}

module.exports = {
  GeminiGuardError,
  createGeminiGuards,
  getGeminiGuards,
};

