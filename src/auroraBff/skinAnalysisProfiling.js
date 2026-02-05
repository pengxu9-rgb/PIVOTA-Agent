const DEFAULT_STAGES = Object.freeze([
  'decode',
  'face',
  'skin_roi',
  'quality',
  'detector',
  'postprocess',
  'llm',
  'render',
]);

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(ns) {
  if (typeof ns === 'number') return ns / 1e6;
  if (typeof ns === 'bigint') return Number(ns) / 1e6;
  return 0;
}

function safeStr(value, maxLen = 160) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  const trimmed = s.trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}…`;
}

function isSafeScalar(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.length <= 200;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return false;
}

function sanitizeMeta(meta) {
  const obj = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
  if (!obj) return null;
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const key = safeStr(rawKey, 64);
    if (!key) continue;
    if (/(image|photo|buffer|base64|prompt|message|content|landmark|points|pixels|data)/i.test(key)) continue;
    if (!isSafeScalar(rawValue)) continue;
    if (typeof rawValue === 'string') out[key] = safeStr(rawValue, 200);
    else out[key] = rawValue;
  }
  return Object.keys(out).length ? out : null;
}

function safeErrorCode(err) {
  if (!err) return 'error';
  const code = err.code || err.name || err.message;
  return safeStr(code, 120) || 'error';
}

function extractUsage(result) {
  const r = result && typeof result === 'object' ? result : null;
  const usage = r && r.usage && typeof r.usage === 'object' ? r.usage : null;
  if (!usage) return null;
  const promptTokens = Number.isFinite(usage.prompt_tokens)
    ? usage.prompt_tokens
    : Number.isFinite(usage.promptTokens)
      ? usage.promptTokens
      : null;
  const completionTokens = Number.isFinite(usage.completion_tokens)
    ? usage.completion_tokens
    : Number.isFinite(usage.completionTokens)
      ? usage.completionTokens
      : null;
  const totalTokens = Number.isFinite(usage.total_tokens)
    ? usage.total_tokens
    : Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : promptTokens != null && completionTokens != null
        ? promptTokens + completionTokens
        : null;

  if (promptTokens == null && completionTokens == null && totalTokens == null) return null;
  return {
    ...(promptTokens != null ? { prompt_tokens: Math.max(0, Math.trunc(promptTokens)) } : {}),
    ...(completionTokens != null ? { completion_tokens: Math.max(0, Math.trunc(completionTokens)) } : {}),
    ...(totalTokens != null ? { total_tokens: Math.max(0, Math.trunc(totalTokens)) } : {}),
  };
}

function initStageState(name) {
  return {
    name,
    status: 'skipped', // ok | skipped | error
    reason: 'not_run',
    ms: 0,
    spans: 0,
    meta: null,
    _activeStartNs: null,
  };
}

function createStageProfiler({ stages } = {}) {
  const stageNames = Array.isArray(stages) && stages.length ? stages : DEFAULT_STAGES;
  const t0 = nowNs();
  const stageMap = new Map();
  for (const name of stageNames) stageMap.set(name, initStageState(String(name)));

  const llmCalls = [];

  function ensure(name) {
    const key = String(name);
    if (!stageMap.has(key)) stageMap.set(key, initStageState(key));
    return stageMap.get(key);
  }

  function mergeMeta(stage, meta) {
    const clean = sanitizeMeta(meta);
    if (!clean) return;
    stage.meta = { ...(stage.meta || {}), ...clean };
  }

  function start(name, meta) {
    const stage = ensure(name);
    stage.status = 'ok';
    stage.reason = null;
    stage._activeStartNs = nowNs();
    mergeMeta(stage, meta);
  }

  function end(name, meta) {
    const stage = ensure(name);
    if (stage._activeStartNs != null) {
      stage.ms += nsToMs(nowNs() - stage._activeStartNs);
      stage.spans += 1;
      stage._activeStartNs = null;
    }
    if (stage.status !== 'error') stage.status = 'ok';
    stage.reason = null;
    mergeMeta(stage, meta);
  }

  function skip(name, reason, meta) {
    const stage = ensure(name);
    stage._activeStartNs = null;
    stage.status = 'skipped';
    stage.reason = safeStr(reason, 160) || 'skipped';
    mergeMeta(stage, meta);
  }

  function fail(name, err, meta) {
    const stage = ensure(name);
    if (stage._activeStartNs != null) {
      stage.ms += nsToMs(nowNs() - stage._activeStartNs);
      stage.spans += 1;
      stage._activeStartNs = null;
    }
    stage.status = 'error';
    stage.reason = safeErrorCode(err);
    mergeMeta(stage, meta);
  }

  async function time(name, fn, meta) {
    start(name, meta);
    try {
      const result = await fn();
      end(name);
      return result;
    } catch (err) {
      fail(name, err);
      throw err;
    }
  }

  function timeSync(name, fn, meta) {
    start(name, meta);
    try {
      const result = fn();
      end(name);
      return result;
    } catch (err) {
      fail(name, err);
      throw err;
    }
  }

  async function timeLlmCall({ provider, model, kind } = {}, fn) {
    const call = {
      provider: safeStr(provider, 40) || 'unknown',
      model: safeStr(model, 80) || null,
      kind: safeStr(kind, 40) || null,
      ok: false,
      reason: null,
      ms: 0,
      usage: null,
    };
    const c0 = nowNs();
    try {
      const result = await time('llm', fn, { provider: call.provider, model: call.model, kind: call.kind });
      call.ok = true;
      call.ms = nsToMs(nowNs() - c0);
      call.usage = extractUsage(result);
      llmCalls.push(call);
      return result;
    } catch (err) {
      call.ok = false;
      call.reason = safeErrorCode(err);
      call.ms = nsToMs(nowNs() - c0);
      llmCalls.push(call);
      throw err;
    } finally {
      if (llmCalls.length > 20) llmCalls.splice(0, llmCalls.length - 20);
    }
  }

  function report({ finalize = true } = {}) {
    if (finalize) {
      for (const stage of stageMap.values()) {
        if (stage._activeStartNs != null) {
          stage.ms += nsToMs(nowNs() - stage._activeStartNs);
          stage.spans += 1;
          stage._activeStartNs = null;
          stage.status = 'error';
          stage.reason = stage.reason || 'unfinished';
        }
      }
    }
    const totalMs = nsToMs(nowNs() - t0);
    const stagesOut = [];
    for (const stage of stageMap.values()) {
      stagesOut.push({
        name: stage.name,
        status: stage.status,
        ...(stage.reason ? { reason: stage.reason } : {}),
        ms: Math.round(stage.ms * 1000) / 1000,
        spans: stage.spans,
        ...(stage.meta ? { meta: stage.meta } : {}),
      });
    }
    stagesOut.sort((a, b) => stageNames.indexOf(a.name) - stageNames.indexOf(b.name));

    const llmSummary = {
      calls: llmCalls.length,
      ok: llmCalls.filter((c) => c.ok).length,
      failed: llmCalls.filter((c) => !c.ok).length,
    };
    const tokenTotals = llmCalls.reduce(
      (acc, c) => {
        const u = c && c.usage && typeof c.usage === 'object' ? c.usage : null;
        if (!u) return acc;
        if (Number.isFinite(u.prompt_tokens)) acc.prompt_tokens += u.prompt_tokens;
        if (Number.isFinite(u.completion_tokens)) acc.completion_tokens += u.completion_tokens;
        if (Number.isFinite(u.total_tokens)) acc.total_tokens += u.total_tokens;
        return acc;
      },
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    );
    if (tokenTotals.total_tokens || tokenTotals.prompt_tokens || tokenTotals.completion_tokens) {
      llmSummary.tokens = tokenTotals;
    }

    return {
      stages: stagesOut,
      total_ms: Math.round(totalMs * 1000) / 1000,
      llm_calls: llmCalls.slice(),
      llm_summary: llmSummary,
    };
  }

  return {
    start,
    end,
    skip,
    fail,
    time,
    timeSync,
    timeLlmCall,
    report,
  };
}

module.exports = {
  DEFAULT_STAGES,
  createStageProfiler,
};
