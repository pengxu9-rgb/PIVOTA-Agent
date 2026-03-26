const { createHash } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const INVOKE_EXTERNAL_API_KEY_PATTERN = /^ak_(live_)?[0-9a-f]{64}$/;

function parseBearerToken(rawHeader) {
  const raw = String(rawHeader || '').trim();
  if (!raw) return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match && match[1] ? String(match[1]).trim() : null;
}

function fingerprintSecret(rawSecret, createHashFn = createHash) {
  const secret = String(rawSecret || '').trim();
  if (!secret) return null;
  return createHashFn('sha256').update(secret).digest('hex').slice(0, 16);
}

function hashSecretForCache(rawSecret, createHashFn = createHash) {
  const secret = String(rawSecret || '').trim();
  if (!secret) return null;
  return createHashFn('sha256').update(secret).digest('hex');
}

function createExternalInvokeAuthRuntime({
  axiosClient,
  logger,
  pivotaApiKey = '',
  agentAuthIntrospectUrl = '',
  agentAuthIntrospectInternalKey = '',
  agentAuthIntrospectTimeoutMs = 2500,
  agentAuthCachePositiveTtlMs = 60_000,
  agentAuthCacheNegativeTtlMs = 15_000,
  agentAuthCacheMaxEntries = 20_000,
  nodeEnv = process.env.NODE_ENV || '',
  createHashFn = createHash,
  createInvokeAuthContext = () => new AsyncLocalStorage(),
} = {}) {
  const invokeAuthCache = new Map();
  const invokeAuthContext = createInvokeAuthContext();

  function extractInvokeAuthToken(req) {
    const xAgent = String(
      req?.header?.('X-Agent-API-Key') ||
        req?.header?.('x-agent-api-key') ||
        '',
    ).trim();
    if (xAgent) return xAgent;
    const bearer = parseBearerToken(
      req?.header?.('Authorization') || req?.header?.('authorization') || '',
    );
    return bearer || null;
  }

  function getInvokeAuthSource(req) {
    const fromHeader = String(
      req?.header?.('X-Agent-API-Key') || req?.header?.('x-agent-api-key') || '',
    ).trim();
    return fromHeader ? 'x-agent-api-key' : 'authorization_bearer';
  }

  function pruneInvokeAuthCache(nowMs = Date.now()) {
    for (const [cacheKey, entry] of invokeAuthCache.entries()) {
      if (!entry || typeof entry !== 'object') {
        invokeAuthCache.delete(cacheKey);
        continue;
      }
      if (Number(entry.expires_at_ms || 0) <= nowMs) {
        invokeAuthCache.delete(cacheKey);
      }
    }
    while (invokeAuthCache.size > agentAuthCacheMaxEntries) {
      const oldest = invokeAuthCache.keys().next();
      if (!oldest || oldest.done) break;
      invokeAuthCache.delete(oldest.value);
    }
  }

  function getCachedInvokeAuthResult(apiKey) {
    const cacheKey = hashSecretForCache(apiKey, createHashFn);
    if (!cacheKey) return null;
    const nowMs = Date.now();
    const entry = invokeAuthCache.get(cacheKey);
    if (!entry || typeof entry !== 'object') return null;
    if (Number(entry.expires_at_ms || 0) <= nowMs) {
      invokeAuthCache.delete(cacheKey);
      return null;
    }
    invokeAuthCache.delete(cacheKey);
    invokeAuthCache.set(cacheKey, entry);
    return { ...entry.result, cache_hit: true };
  }

  function putCachedInvokeAuthResult(apiKey, result) {
    const cacheKey = hashSecretForCache(apiKey, createHashFn);
    if (!cacheKey || !result || typeof result !== 'object') return;
    const valid = result.valid === true;
    const ttlMs = valid ? agentAuthCachePositiveTtlMs : agentAuthCacheNegativeTtlMs;
    invokeAuthCache.set(cacheKey, {
      expires_at_ms: Date.now() + ttlMs,
      result: {
        valid,
        agent_id: result.agent_id || null,
        is_active: result.is_active === false ? false : true,
        auth_source: result.auth_source || null,
      },
    });
    pruneInvokeAuthCache();
  }

  async function introspectInvokeApiKey(apiKey) {
    const cached = getCachedInvokeAuthResult(apiKey);
    if (cached) return cached;

    if (!agentAuthIntrospectUrl || !agentAuthIntrospectInternalKey) {
      const err = new Error('agent auth introspect is not configured');
      err.code = 'AUTH_INTROSPECT_NOT_CONFIGURED';
      throw err;
    }

    let response;
    try {
      response = await axiosClient.post(
        agentAuthIntrospectUrl,
        { api_key: apiKey },
        {
          timeout: agentAuthIntrospectTimeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': agentAuthIntrospectInternalKey,
          },
          validateStatus: () => true,
        },
      );
    } catch (err) {
      const e = new Error(err?.message || 'introspect request failed');
      e.code = 'AUTH_INTROSPECT_UNAVAILABLE';
      throw e;
    }

    if (response.status >= 500) {
      const err = new Error(`introspect upstream status=${response.status}`);
      err.code = 'AUTH_INTROSPECT_UNAVAILABLE';
      throw err;
    }

    if (response.status < 200 || response.status >= 300) {
      const err = new Error(`introspect rejected status=${response.status}`);
      err.code = 'AUTH_INTROSPECT_REJECTED';
      throw err;
    }

    const data = response?.data && typeof response.data === 'object' ? response.data : {};
    const result = {
      valid: data.valid === true,
      agent_id: String(data.agent_id || '').trim() || null,
      is_active: data.is_active === false ? false : true,
      auth_source: String(data.auth_source || '').trim() || null,
      cache_hit: false,
    };
    putCachedInvokeAuthResult(apiKey, result);
    return result;
  }

  async function requireExternalInvokeAuth(req, res, next) {
    const checkoutToken = String(
      req?.header?.('X-Checkout-Token') || req?.header?.('x-checkout-token') || '',
    ).trim();
    if (checkoutToken) {
      req.invokeAuth = {
        key_fingerprint: null,
        auth_source: 'x-checkout-token',
        auth_mode: 'checkout_token',
        agent_id: null,
        raw_token: null,
        cache_hit: false,
      };
      return next();
    }

    const testBypassEnabled =
      nodeEnv === 'test' &&
      (!agentAuthIntrospectUrl || !agentAuthIntrospectInternalKey);
    if (testBypassEnabled) {
      req.invokeAuth = {
        key_fingerprint: null,
        auth_source: 'test_bypass',
        auth_mode: 'test_bypass',
        agent_id: null,
        raw_token: null,
        cache_hit: false,
      };
      return next();
    }

    const provided = extractInvokeAuthToken(req);
    const keyFingerprint = fingerprintSecret(provided, createHashFn);
    if (!provided) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Missing or invalid API key',
      });
    }

    if (!INVOKE_EXTERNAL_API_KEY_PATTERN.test(provided)) {
      logger.warn(
        {
          path: req?.path || null,
          key_fingerprint: keyFingerprint,
        },
        'invoke auth rejected: invalid api key format',
      );
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Missing or invalid API key',
      });
    }

    let introspection;
    try {
      introspection = await introspectInvokeApiKey(provided);
    } catch (err) {
      logger.error(
        {
          path: req?.path || null,
          key_fingerprint: keyFingerprint,
          code: err?.code || null,
          err: err?.message || String(err),
        },
        'invoke auth introspection unavailable',
      );
      return res.status(503).json({
        error: 'AUTH_INTROSPECT_UNAVAILABLE',
        message: 'Authentication service unavailable',
      });
    }

    if (!introspection || introspection.valid !== true) {
      logger.warn(
        {
          path: req?.path || null,
          key_fingerprint: keyFingerprint,
        },
        'invoke auth rejected: key not found',
      );
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Missing or invalid API key',
      });
    }

    if (introspection.is_active === false) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Agent is deactivated',
      });
    }

    req.invokeAuth = {
      key_fingerprint: keyFingerprint,
      auth_source: getInvokeAuthSource(req),
      auth_mode: 'api_key',
      agent_id: introspection.agent_id || null,
      raw_token: provided,
      cache_hit: introspection.cache_hit === true,
      introspect_auth_source: introspection.auth_source || null,
    };
    return next();
  }

  function getInvokeAuthContext() {
    return invokeAuthContext.getStore() || null;
  }

  function getInvokeAuthApiKey() {
    const store = getInvokeAuthContext();
    const key = String(store?.api_key || '').trim();
    return key || null;
  }

  function buildInvokeUpstreamAuthHeaders({
    checkoutToken,
    allowInternalFallback = true,
  } = {}) {
    const normalizedCheckoutToken = String(checkoutToken || '').trim();
    if (normalizedCheckoutToken) {
      return { 'X-Checkout-Token': normalizedCheckoutToken };
    }

    const callerApiKey = getInvokeAuthApiKey();
    if (callerApiKey) {
      return {
        'X-API-Key': callerApiKey,
        Authorization: `Bearer ${callerApiKey}`,
      };
    }

    if (allowInternalFallback && pivotaApiKey) {
      return {
        'X-API-Key': pivotaApiKey,
        Authorization: `Bearer ${pivotaApiKey}`,
      };
    }
    return {};
  }

  return {
    invokeAuthContext,
    extractInvokeAuthToken,
    getInvokeAuthSource,
    getInvokeAuthContext,
    getInvokeAuthApiKey,
    introspectInvokeApiKey,
    requireExternalInvokeAuth,
    buildInvokeUpstreamAuthHeaders,
  };
}

module.exports = {
  INVOKE_EXTERNAL_API_KEY_PATTERN,
  parseBearerToken,
  fingerprintSecret,
  hashSecretForCache,
  createExternalInvokeAuthRuntime,
};
