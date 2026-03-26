function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = String(raw || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCreatorCatalogAutoSyncRuntime({
  env = process.env,
  logger,
  queryDb,
  axiosClient,
  parsePositiveInt,
  creatorConfigs = [],
  creatorCatalogCacheTtlSeconds,
  pivotaApiBase,
  adminApiKey,
} = {}) {
  const creatorCatalogAutoSyncEnabled = (() => {
    const raw = String(env.CREATOR_CATALOG_AUTO_SYNC_ENABLED || '').trim().toLowerCase();
    if (!raw) return String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
    return ['1', 'true', 'yes', 'on'].includes(raw);
  })();

  const creatorCatalogAutoSyncTimeoutMs = parsePositiveInt(
    env.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS,
    120000,
    { min: 1000, max: 10 * 60 * 1000 },
  );
  const creatorCatalogAutoSyncRetries = parsePositiveInt(
    env.CREATOR_CATALOG_AUTO_SYNC_RETRIES,
    1,
    { min: 0, max: 5 },
  );
  const creatorCatalogAutoSyncRetryBackoffMs = parsePositiveInt(
    env.CREATOR_CATALOG_AUTO_SYNC_RETRY_BACKOFF_MS,
    3000,
    { min: 100, max: 60 * 1000 },
  );
  const creatorCatalogAutoSyncNonRetryableCooldownSeconds = parsePositiveInt(
    env.CREATOR_CATALOG_AUTO_SYNC_NON_RETRYABLE_COOLDOWN_SECONDS,
    6 * 60 * 60,
    { min: 60, max: 7 * 24 * 60 * 60 },
  );
  const creatorCatalogAutoSyncInvalidMerchantCooldownSeconds = parsePositiveInt(
    env.CREATOR_CATALOG_AUTO_SYNC_INVALID_MERCHANT_COOLDOWN_SECONDS,
    24 * 60 * 60,
    { min: 5 * 60, max: 30 * 24 * 60 * 60 },
  );
  const creatorCatalogAutoSyncTimeoutMaxMs = parsePositiveInt(
    env.CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MAX_MS,
    Math.max(240000, creatorCatalogAutoSyncTimeoutMs * 4),
    { min: creatorCatalogAutoSyncTimeoutMs, max: 20 * 60 * 1000 },
  );

  const catalogSyncState = {
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    per_merchant: {},
    target_source: null,
    target_count: 0,
    target_eligible_count: 0,
    target_suppressed_count: 0,
    target_sample: [],
    target_suppressed_sample: [],
  };

  function getCreatorCatalogAutoSyncIntervalConfig() {
    const maxIntervalMinutes = Math.max(
      1,
      Math.min(360, Math.floor(creatorCatalogCacheTtlSeconds / 4 / 60)),
    );
    const configuredRaw = String(env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES || '').trim();
    const configuredMinutes = configuredRaw
      ? parsePositiveInt(configuredRaw, null, { min: 1, max: 24 * 60 })
      : null;
    if (configuredMinutes == null) {
      return {
        intervalMinutes: maxIntervalMinutes,
        maxIntervalMinutes,
        configuredMinutes: null,
        clamped: false,
      };
    }
    const intervalMinutes = Math.min(configuredMinutes, maxIntervalMinutes);
    return {
      intervalMinutes,
      maxIntervalMinutes,
      configuredMinutes,
      clamped: configuredMinutes > maxIntervalMinutes,
    };
  }

  function getCreatorCatalogAutoSyncLimitConfig() {
    const configuredRaw = String(env.CREATOR_CATALOG_AUTO_SYNC_LIMIT || '').trim();
    const configuredNumeric = Number(configuredRaw);
    const configuredLimit =
      Number.isFinite(configuredNumeric) && configuredNumeric > 0
        ? Math.floor(configuredNumeric)
        : null;
    const limitFallbackApplied = configuredLimit == null;
    const limitClampedToMax = configuredLimit != null && configuredLimit > 5000;
    const limitEffective = Math.min(limitFallbackApplied ? 200 : configuredLimit, 5000);
    return {
      limitConfigured: configuredLimit,
      limitEffective,
      limitFallbackApplied,
      limitRaisedToMin: false,
      limitClampedToMax,
    };
  }

  function getCreatorCatalogMerchantIds() {
    const all = [];
    for (const cfg of creatorConfigs || []) {
      if (!Array.isArray(cfg?.merchantIds)) continue;
      for (const merchantId of cfg.merchantIds) all.push(merchantId);
    }
    return uniqueStrings(all);
  }

  function getCatalogSyncMerchantIdsFromEnv() {
    const raw = String(
      env.CATALOG_SYNC_MERCHANT_IDS || env.CREATOR_CATALOG_MERCHANT_IDS || '',
    ).trim();
    if (!raw) return [];
    return uniqueStrings(raw.split(','));
  }

  async function discoverCatalogSyncMerchantIdsFromDb(limit = 5000) {
    if (!env.DATABASE_URL || typeof queryDb !== 'function') {
      return { merchantIds: [], source: 'db_not_configured' };
    }
    const normalizedLimit = Math.min(Math.max(1, Number(limit || 5000)), 5000);
    const allowRelaxedFallback =
      String(env.CATALOG_SYNC_DISCOVERY_RELAXED || '').trim().toLowerCase() === 'true';

    try {
      const shopifyStoresRes = await queryDb(
        `
          SELECT DISTINCT merchant_id
          FROM merchant_stores
          WHERE COALESCE(NULLIF(trim(merchant_id), ''), '') <> ''
            AND lower(COALESCE(platform, '')) = 'shopify'
            AND lower(COALESCE(status, '')) = 'active'
            AND COALESCE(NULLIF(trim(domain), ''), '') <> ''
            AND COALESCE(NULLIF(trim(api_key), ''), '') <> ''
          ORDER BY merchant_id ASC
          LIMIT $1
        `,
        [normalizedLimit],
      );
      const shopifyStoreMerchantIds = uniqueStrings(
        (shopifyStoresRes.rows || []).map((row) => row?.merchant_id),
      );
      if (shopifyStoreMerchantIds.length) {
        return { merchantIds: shopifyStoreMerchantIds, source: 'merchant_stores_shopify_active' };
      }
    } catch (err) {
      logger?.warn(
        { err: err?.message || String(err) },
        'Catalog sync merchant discovery via merchant_stores failed',
      );
    }

    if (!allowRelaxedFallback) {
      return { merchantIds: [], source: 'merchant_stores_empty' };
    }

    try {
      const onboardingRes = await queryDb(
        `
          SELECT DISTINCT merchant_id
          FROM merchant_onboarding
          WHERE COALESCE(NULLIF(trim(merchant_id), ''), '') <> ''
            AND lower(COALESCE(status, '')) = 'approved'
            AND COALESCE(psp_connected, false) = true
          ORDER BY merchant_id ASC
          LIMIT $1
        `,
        [normalizedLimit],
      );
      const onboardingMerchantIds = uniqueStrings(
        (onboardingRes.rows || []).map((row) => row?.merchant_id),
      );
      if (onboardingMerchantIds.length) {
        return { merchantIds: onboardingMerchantIds, source: 'merchant_onboarding_relaxed' };
      }
    } catch (err) {
      logger?.warn(
        { err: err?.message || String(err) },
        'Catalog sync merchant discovery via merchant_onboarding failed in relaxed mode',
      );
    }

    try {
      const cacheRes = await queryDb(
        `
          SELECT DISTINCT merchant_id
          FROM products_cache
          WHERE COALESCE(NULLIF(trim(merchant_id), ''), '') <> ''
            AND merchant_id <> 'external_seed'
          ORDER BY merchant_id ASC
          LIMIT $1
        `,
        [normalizedLimit],
      );
      const cacheMerchantIds = uniqueStrings(
        (cacheRes.rows || []).map((row) => row?.merchant_id),
      );
      if (cacheMerchantIds.length) {
        return { merchantIds: cacheMerchantIds, source: 'products_cache_relaxed' };
      }
    } catch (err) {
      logger?.warn(
        { err: err?.message || String(err) },
        'Catalog sync merchant discovery via products_cache failed in relaxed mode',
      );
    }

    return { merchantIds: [], source: 'db_empty_relaxed' };
  }

  async function resolveCatalogSyncMerchantIds() {
    const envMerchantIds = getCatalogSyncMerchantIdsFromEnv();
    if (envMerchantIds.length) {
      return { merchantIds: envMerchantIds, source: 'env' };
    }

    const discovered = await discoverCatalogSyncMerchantIdsFromDb();
    if (discovered.merchantIds.length) return discovered;

    const creatorMerchantIds = getCreatorCatalogMerchantIds();
    if (creatorMerchantIds.length) {
      return { merchantIds: creatorMerchantIds, source: 'creator_configs_fallback' };
    }

    return { merchantIds: [], source: discovered.source || 'none' };
  }

  function isCatalogSyncRetryableError(err) {
    const status = Number(err?.response?.status || 0);
    if (status === 429 || status >= 500) return true;

    const code = String(err?.code || '').trim().toUpperCase();
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
      return true;
    }

    const message = String(err?.message || '').trim().toLowerCase();
    return message.includes('timeout') || message.includes('timed out');
  }

  function isCatalogSyncNonRetryableError(err) {
    const status = Number(err?.response?.status || 0);
    if (status === 400 || status === 401 || status === 403 || status === 404) return true;

    const detailStatus = Number(
      err?.response?.data?.status ||
        err?.response?.data?.error?.status ||
        err?.response?.data?.detail?.status ||
        0,
    );
    if (detailStatus === 400 || detailStatus === 401 || detailStatus === 403 || detailStatus === 404) {
      return true;
    }

    const code = String(err?.code || '').trim().toUpperCase();
    if (code === 'ENOTFOUND') return true;

    const message = String(
      err?.response?.data?.detail?.message ||
        err?.response?.data?.detail ||
        err?.response?.data?.error?.message ||
        err?.message ||
        '',
    )
      .trim()
      .toLowerCase();
    if (!message) return false;
    if (message.includes('shopify api error: 404')) return true;
    if (message.includes('"errors":"not found"')) return true;
    if (message.includes("errors':'not found")) return true;
    if (message.includes('shopify') && message.includes('not found')) return true;
    return false;
  }

  function isCatalogSyncInvalidMerchantError(err) {
    const status = Number(err?.response?.status || 0);
    if (status === 400 || status === 401 || status === 403 || status === 404) return true;

    const detailStatus = Number(
      err?.response?.data?.status ||
        err?.response?.data?.error?.status ||
        err?.response?.data?.detail?.status ||
        0,
    );
    if (detailStatus === 400 || detailStatus === 401 || detailStatus === 403 || detailStatus === 404) {
      return true;
    }

    const message = String(
      err?.response?.data?.detail?.message ||
        err?.response?.data?.detail ||
        err?.response?.data?.error?.message ||
        err?.message ||
        '',
    )
      .trim()
      .toLowerCase();
    if (!message) return false;
    if (message.includes('shopify api error: 404')) return true;
    if (message.includes('"errors":"not found"')) return true;
    if (message.includes("errors':'not found")) return true;
    if (message.includes('shopify') && message.includes('not found')) return true;
    if (message.includes('invalid api key')) return true;
    if (message.includes('access denied')) return true;
    if (message.includes('unauthorized')) return true;
    if (message.includes('forbidden')) return true;
    return false;
  }

  function isCatalogSyncTimeoutError(err) {
    const code = String(err?.code || '').trim().toUpperCase();
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
      return true;
    }
    const message = String(err?.message || '').trim().toLowerCase();
    return message.includes('timeout') || message.includes('timed out');
  }

  function getCatalogSyncAttemptTimeoutMs({ merchantState, attempt }) {
    const timeoutStreak = Math.max(0, Number(merchantState?.timeout_streak || 0));
    const attemptIndex = Math.max(0, Number(attempt || 1) - 1);
    const growth = Math.min(timeoutStreak + attemptIndex, 3);
    const multiplier = Math.pow(2, growth);
    return Math.max(
      creatorCatalogAutoSyncTimeoutMs,
      Math.min(
        creatorCatalogAutoSyncTimeoutMaxMs,
        Math.floor(creatorCatalogAutoSyncTimeoutMs * multiplier),
      ),
    );
  }

  function getCatalogSyncSuppressionStatus(merchantId, nowMs = Date.now()) {
    const state = catalogSyncState.per_merchant[merchantId];
    const blockedUntilMs = Number(state?.blocked_until_ms || 0);
    if (!blockedUntilMs || blockedUntilMs <= nowMs) {
      return {
        suppressed: false,
        reason: null,
        blocked_until: null,
        invalid_merchant: false,
      };
    }
    return {
      suppressed: true,
      reason: state?.invalid_merchant ? 'invalid_merchant_cooldown' : 'non_retryable_cooldown',
      blocked_until: state?.blocked_until || new Date(blockedUntilMs).toISOString(),
      invalid_merchant: state?.invalid_merchant === true,
    };
  }

  function summarizeCatalogSyncMerchantState() {
    const rows = Object.entries(catalogSyncState.per_merchant || {}).map(([merchantId, state]) => ({
      merchant_id: merchantId,
      ok: state?.ok === true,
      skipped: state?.skipped === true,
      invalid_merchant: state?.invalid_merchant === true,
      status: Number.isFinite(Number(state?.status)) ? Number(state.status) : null,
      attempts: Number.isFinite(Number(state?.attempts)) ? Number(state.attempts) : null,
      timeout_streak: Number.isFinite(Number(state?.timeout_streak)) ? Number(state.timeout_streak) : 0,
      last_run_at: state?.last_run_at || null,
      blocked_until: state?.blocked_until || null,
      error: state?.error ? String(state.error) : null,
    }));
    rows.sort((a, b) => {
      const ta = Date.parse(String(a.last_run_at || '')) || 0;
      const tb = Date.parse(String(b.last_run_at || '')) || 0;
      return tb - ta;
    });
    return rows.slice(0, 20);
  }

  function buildCatalogSyncSnapshot(overrides = {}) {
    const intervalConfig = getCreatorCatalogAutoSyncIntervalConfig();
    const limitConfig = getCreatorCatalogAutoSyncLimitConfig();
    return {
      enabled: creatorCatalogAutoSyncEnabled,
      interval_minutes: intervalConfig.intervalMinutes,
      interval_minutes_max: intervalConfig.maxIntervalMinutes,
      cache_ttl_seconds: creatorCatalogCacheTtlSeconds,
      limit_configured: limitConfig.limitConfigured,
      limit_effective: limitConfig.limitEffective,
      limit_fallback_applied: limitConfig.limitFallbackApplied,
      limit_raised_to_min: limitConfig.limitRaisedToMin,
      limit_clamped_to_max: limitConfig.limitClampedToMax,
      request_timeout_ms: creatorCatalogAutoSyncTimeoutMs,
      request_timeout_max_ms: creatorCatalogAutoSyncTimeoutMaxMs,
      retry_attempts: creatorCatalogAutoSyncRetries,
      retry_backoff_ms: creatorCatalogAutoSyncRetryBackoffMs,
      non_retryable_cooldown_seconds: creatorCatalogAutoSyncNonRetryableCooldownSeconds,
      invalid_merchant_cooldown_seconds: creatorCatalogAutoSyncInvalidMerchantCooldownSeconds,
      target_source: catalogSyncState.target_source,
      target_count: catalogSyncState.target_count,
      target_eligible_count: catalogSyncState.target_eligible_count,
      target_suppressed_count: catalogSyncState.target_suppressed_count,
      target_sample: catalogSyncState.target_sample,
      target_suppressed_sample: catalogSyncState.target_suppressed_sample,
      last_run_at: catalogSyncState.last_run_at,
      last_success_at: catalogSyncState.last_success_at,
      last_error: catalogSyncState.last_error,
      per_merchant: summarizeCatalogSyncMerchantState(),
      ...overrides,
    };
  }

  async function runCreatorCatalogAutoSync() {
    if (!creatorCatalogAutoSyncEnabled) return;
    if (!pivotaApiBase) return;

    const effectiveAdminKey = env.CREATOR_CATALOG_SYNC_ADMIN_KEY || adminApiKey;
    if (!effectiveAdminKey) {
      logger?.warn('CREATOR_CATALOG_AUTO_SYNC_ENABLED is true but no admin key is configured');
      return;
    }

    const merchantTarget = await resolveCatalogSyncMerchantIds();
    const resolvedMerchantIds = merchantTarget.merchantIds;
    const nowMs = Date.now();
    const merchantIds = [];
    const suppressedMerchants = [];

    for (const merchantId of resolvedMerchantIds) {
      const suppression = getCatalogSyncSuppressionStatus(merchantId, nowMs);
      if (!suppression.suppressed) {
        merchantIds.push(merchantId);
        continue;
      }
      const existingState = catalogSyncState.per_merchant[merchantId];
      catalogSyncState.per_merchant[merchantId] = {
        ...(existingState && typeof existingState === 'object' ? existingState : {}),
        ok: false,
        skipped: true,
        last_run_at: new Date().toISOString(),
        status: Number.isFinite(Number(existingState?.status)) ? Number(existingState.status) : null,
        attempts: 0,
        duration_ms: 0,
        invalid_merchant: existingState?.invalid_merchant === true,
        error:
          existingState?.error ||
          'Skipped due to temporary cooldown after non-retryable sync error',
        blocked_until_ms: Number(existingState?.blocked_until_ms || 0) || null,
        blocked_until: suppression.blocked_until,
      };
      suppressedMerchants.push({
        merchant_id: merchantId,
        reason: suppression.reason,
        blocked_until: suppression.blocked_until,
        invalid_merchant: suppression.invalid_merchant,
      });
    }

    catalogSyncState.target_source = merchantTarget.source || null;
    catalogSyncState.target_count = resolvedMerchantIds.length;
    catalogSyncState.target_eligible_count = merchantIds.length;
    catalogSyncState.target_suppressed_count = suppressedMerchants.length;
    catalogSyncState.target_sample = resolvedMerchantIds.slice(0, 20);
    catalogSyncState.target_suppressed_sample = suppressedMerchants.slice(0, 20);

    if (!merchantIds.length) {
      logger?.warn(
        {
          target_source: merchantTarget.source || null,
          target_count: resolvedMerchantIds.length,
          suppressed_count: suppressedMerchants.length,
        },
        'CREATOR_CATALOG_AUTO_SYNC_ENABLED is true but no sync target merchants were resolved',
      );
      return;
    }

    const limit = getCreatorCatalogAutoSyncLimitConfig().limitEffective;
    const ttlSeconds = creatorCatalogCacheTtlSeconds;
    const maxAttempts = Math.max(1, Number(creatorCatalogAutoSyncRetries || 0) + 1);

    catalogSyncState.last_run_at = new Date().toISOString();
    catalogSyncState.last_error = null;

    for (const merchantId of merchantIds) {
      const existingState = catalogSyncState.per_merchant[merchantId];
      const url = `${pivotaApiBase}/agent/internal/shopify/products/sync/${encodeURIComponent(
        merchantId,
      )}?limit=${encodeURIComponent(String(limit))}&ttl_seconds=${encodeURIComponent(String(ttlSeconds))}`;
      const startedAtMs = Date.now();
      let attempt = 0;
      let res = null;
      let err = null;
      let timeoutUsedMs = creatorCatalogAutoSyncTimeoutMs;

      for (attempt = 1; attempt <= maxAttempts; attempt += 1) {
        timeoutUsedMs = getCatalogSyncAttemptTimeoutMs({
          merchantState: existingState,
          attempt,
        });
        try {
          res = await axiosClient.post(url, null, {
            headers: { 'X-ADMIN-KEY': effectiveAdminKey },
            timeout: timeoutUsedMs,
          });
          err = null;
          break;
        } catch (attemptErr) {
          err = attemptErr;
          const retryable = isCatalogSyncRetryableError(attemptErr);
          const nonRetryable = isCatalogSyncNonRetryableError(attemptErr);
          if (attempt < maxAttempts && retryable && !nonRetryable) {
            const delayMs = Math.min(
              creatorCatalogAutoSyncRetryBackoffMs * Math.pow(2, attempt - 1),
              30000,
            );
            logger?.warn(
              {
                merchantId,
                attempt,
                max_attempts: maxAttempts,
                retry_in_ms: delayMs,
                timeout_ms: timeoutUsedMs,
                status: attemptErr?.response?.status || null,
                code: attemptErr?.code || null,
                non_retryable: nonRetryable,
                error: attemptErr?.message || String(attemptErr),
              },
              'Creator catalog auto sync attempt failed; retrying',
            );
            await sleepMs(delayMs);
            continue;
          }
          break;
        }
      }

      if (!err && res) {
        catalogSyncState.per_merchant[merchantId] = {
          ok: true,
          skipped: false,
          last_run_at: new Date().toISOString(),
          attempts: attempt,
          duration_ms: Math.max(0, Date.now() - startedAtMs),
          summary: res.data && res.data.summary ? res.data.summary : res.data,
          status: Number.isFinite(Number(res.status)) ? Number(res.status) : 200,
          timeout_ms: timeoutUsedMs,
          timeout_streak: 0,
          invalid_merchant: false,
          error: null,
          blocked_until_ms: null,
          blocked_until: null,
        };
        catalogSyncState.last_success_at = new Date().toISOString();
        logger?.info(
          {
            merchantId,
            limit,
            ttl_seconds: ttlSeconds,
            attempts: attempt,
            duration_ms: Math.max(0, Date.now() - startedAtMs),
            timeout_ms: timeoutUsedMs,
          },
          'Creator catalog auto sync succeeded',
        );
        continue;
      }

      if (!err) continue;

      const status = err.response?.status;
      const data = err.response?.data;
      const message =
        (data && data.detail && typeof data.detail === 'object' && data.detail.message) ||
        (data && typeof data.detail === 'string' ? data.detail : null) ||
        err.message;
      const nonRetryable = isCatalogSyncNonRetryableError(err);
      const invalidMerchant = isCatalogSyncInvalidMerchantError(err);
      const timeoutError = isCatalogSyncTimeoutError(err);
      const previousTimeoutStreak = Math.max(0, Number(existingState?.timeout_streak || 0));
      const timeoutStreak = timeoutError ? Math.min(previousTimeoutStreak + 1, 10) : 0;
      const blockedUntilMs = nonRetryable
        ? Date.now() +
          (invalidMerchant
            ? creatorCatalogAutoSyncInvalidMerchantCooldownSeconds
            : creatorCatalogAutoSyncNonRetryableCooldownSeconds) *
            1000
        : null;
      catalogSyncState.per_merchant[merchantId] = {
        ok: false,
        skipped: false,
        last_run_at: new Date().toISOString(),
        attempts: attempt,
        duration_ms: Math.max(0, Date.now() - startedAtMs),
        status: status || null,
        timeout_ms: timeoutUsedMs,
        timeout_streak: timeoutStreak,
        invalid_merchant: invalidMerchant,
        error: message,
        blocked_until_ms: blockedUntilMs,
        blocked_until: blockedUntilMs ? new Date(blockedUntilMs).toISOString() : null,
      };
      catalogSyncState.last_error = `${merchantId}: ${message}`;
      logger?.warn(
        {
          merchantId,
          status,
          message,
          attempts: attempt,
          timeout_ms: timeoutUsedMs,
          max_attempts: maxAttempts,
          timeout_streak: timeoutStreak,
          non_retryable: nonRetryable,
          invalid_merchant: invalidMerchant,
          blocked_until: blockedUntilMs ? new Date(blockedUntilMs).toISOString() : null,
        },
        'Creator catalog auto sync failed',
      );
    }
  }

  return {
    creatorCatalogAutoSyncEnabled,
    creatorCatalogAutoSyncTimeoutMs,
    getCreatorCatalogAutoSyncIntervalConfig,
    getCreatorCatalogAutoSyncLimitConfig,
    getCreatorCatalogMerchantIds,
    resolveCatalogSyncMerchantIds,
    getCatalogSyncSuppressionStatus,
    buildCatalogSyncSnapshot,
    runCreatorCatalogAutoSync,
    isCatalogSyncRetryableError,
    isCatalogSyncTimeoutError,
    isCatalogSyncInvalidMerchantError,
    catalogSyncState,
  };
}

module.exports = {
  createCreatorCatalogAutoSyncRuntime,
};
