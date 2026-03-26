function createRecoCatalogSearchSupportRuntime(options = {}) {
  const {
    PRODUCT_INTEL_HTTP_URL_RE = /^https?:\/\//i,
    collectCandidateIngredientTokens = () => [],
    collectCandidateSkinTypeTags = () => [],
    extractCandidateSocialReference = () => ({ score: null, support_count: null, social_raw: null }),
    extractCatalogCandidatePrice = () => null,
    normalizeCanonicalProductRef = () => '',
    RECO_CATALOG_SEARCH_PREFER_CONFIGURED_BASE_URLS = false,
    RECO_CATALOG_SEARCH_SELF_PROXY_ENABLED = false,
    RECO_CATALOG_SEARCH_AURORA_SELF_PROXY_FIRST = false,
    RECO_CATALOG_SEARCH_BASE_URLS = '',
    PIVOTA_BACKEND_BASE_URL = '',
    RECO_CATALOG_SEARCH_SELF_PROXY_BASE_URL = '',
    RECO_PDP_LOCAL_INVOKE_BASE_URL = '',
    RECO_CATALOG_SEARCH_PATHS = '',
    RECO_CATALOG_BEAUTY_ROUTE_FIRST_ENABLED = false,
    RECO_CATALOG_BEAUTY_PATH_FALLBACK_ENABLED = false,
    RECO_CATALOG_SOURCE_EMPTY_FAIL_THRESHOLD = 2,
    RECO_CATALOG_SOURCE_EMPTY_COOLDOWN_MS = 60000,
    RECO_CATALOG_SOURCE_TRANSIENT_FAIL_THRESHOLD = 2,
    RECO_CATALOG_SOURCE_TRANSIENT_COOLDOWN_MS = 60000,
    RECO_CATALOG_FAIL_FAST_ENABLED = false,
    RECO_CATALOG_FAIL_FAST_COOLDOWN_MS = 60000,
    RECO_CATALOG_FAIL_FAST_THRESHOLD = 3,
    RECO_CATALOG_FAIL_FAST_PROBE_INTERVAL_MS = 30000,
  } = options

  const recoCatalogSearchSourceState = new Map()
  const recoCatalogFailFastState = {
    consecutive_failures: 0,
    open_until_ms: 0,
    last_reason: null,
    last_failed_at: 0,
    last_probe_started_at: 0,
  }

  function normalizeRecoCatalogProduct(raw) {
    const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

    const productId =
      (typeof base.product_id === 'string' && base.product_id) ||
      (typeof base.productId === 'string' && base.productId) ||
      (typeof base.id === 'string' && base.id) ||
      ''

    const merchantId =
      (typeof base.merchant_id === 'string' && base.merchant_id) ||
      (typeof base.merchantId === 'string' && base.merchantId) ||
      (base.merchant && typeof base.merchant === 'object' && !Array.isArray(base.merchant) && typeof base.merchant.merchant_id === 'string'
        ? base.merchant.merchant_id
        : '') ||
      ''

    const brand =
      (typeof base.brand === 'string' && base.brand) ||
      (typeof base.brand_name === 'string' && base.brand_name) ||
      (typeof base.brandName === 'string' && base.brandName) ||
      ''

    const name =
      (typeof base.name === 'string' && base.name) ||
      (typeof base.title === 'string' && base.title) ||
      ''

    const displayName =
      (typeof base.display_name === 'string' && base.display_name) ||
      (typeof base.displayName === 'string' && base.displayName) ||
      name ||
      ''

    const skuId =
      (typeof base.sku_id === 'string' && base.sku_id) ||
      (typeof base.skuId === 'string' && base.skuId) ||
      ''

    const productGroupId =
      (typeof base.product_group_id === 'string' && base.product_group_id) ||
      (typeof base.productGroupId === 'string' && base.productGroupId) ||
      (base.subject &&
      typeof base.subject === 'object' &&
      !Array.isArray(base.subject) &&
      typeof base.subject.product_group_id === 'string'
        ? base.subject.product_group_id
        : '') ||
      ''

    const imageUrl =
      (typeof base.image_url === 'string' && base.image_url) ||
      (typeof base.imageUrl === 'string' && base.imageUrl) ||
      (typeof base.thumbnail_url === 'string' && base.thumbnail_url) ||
      (typeof base.thumbnailUrl === 'string' && base.thumbnailUrl) ||
      ''

    const category =
      (typeof base.category === 'string' && base.category) ||
      (typeof base.product_type === 'string' && base.product_type) ||
      (typeof base.productType === 'string' && base.productType) ||
      (base.subject &&
      typeof base.subject === 'object' &&
      !Array.isArray(base.subject) &&
      typeof base.subject.category === 'string'
        ? base.subject.category
        : '') ||
      ''

    const sourceToken =
      (typeof base.source === 'string' && base.source) ||
      (base.source && typeof base.source === 'object' && !Array.isArray(base.source) && typeof base.source.type === 'string'
        ? base.source.type
        : '') ||
      (typeof base.source_type === 'string' && base.source_type) ||
      (typeof base.sourceType === 'string' && base.sourceType) ||
      ''

    const retrievalSourceRaw =
      (typeof base.retrieval_source === 'string' && base.retrieval_source) ||
      (typeof base.retrievalSource === 'string' && base.retrievalSource) ||
      ''
    const retrievalReasonRaw =
      (typeof base.retrieval_reason === 'string' && base.retrieval_reason) ||
      (typeof base.retrievalReason === 'string' && base.retrievalReason) ||
      ''
    const normalizedRetrievalSource = (() => {
      const token = String(retrievalSourceRaw || '').trim().toLowerCase()
      if (token === 'catalog' || token === 'external_seed' || token === 'llm_fallback') return token
      const sourceLower = String(sourceToken || '').trim().toLowerCase()
      if (sourceLower.includes('external')) return 'external_seed'
      if (sourceLower.includes('llm')) return 'llm_fallback'
      return sourceLower ? 'catalog' : ''
    })()

    const directUrlRaw =
      (typeof base.canonical_pdp_url === 'string' && base.canonical_pdp_url) ||
      (typeof base.canonicalPdpUrl === 'string' && base.canonicalPdpUrl) ||
      (typeof base.pdp_url === 'string' && base.pdp_url) ||
      (typeof base.pdpUrl === 'string' && base.pdpUrl) ||
      (typeof base.product_url === 'string' && base.product_url) ||
      (typeof base.productUrl === 'string' && base.productUrl) ||
      (typeof base.url === 'string' && base.url) ||
      (typeof base.link === 'string' && base.link) ||
      ''
    const directUrl = PRODUCT_INTEL_HTTP_URL_RE.test(String(directUrlRaw || '').trim())
      ? String(directUrlRaw).trim()
      : ''
    const purchasePathRaw =
      (typeof base.purchase_path === 'string' && base.purchase_path) ||
      (typeof base.purchasePath === 'string' && base.purchasePath) ||
      ''
    const purchasePath = PRODUCT_INTEL_HTTP_URL_RE.test(String(purchasePathRaw || '').trim())
      ? String(purchasePathRaw).trim()
      : ''
    const openContract =
      base.open_contract && typeof base.open_contract === 'object' && !Array.isArray(base.open_contract)
        ? base.open_contract
        : null
    const pdpOpen = base.pdp_open && typeof base.pdp_open === 'object' && !Array.isArray(base.pdp_open) ? base.pdp_open : null

    const ingredientTokens = collectCandidateIngredientTokens(base)
    const skinTypeTags = collectCandidateSkinTypeTags(base)
    const socialRef = extractCandidateSocialReference(base)
    const price = extractCatalogCandidatePrice(base)

    const out = {
      product_id: String(productId || '').trim(),
      merchant_id: String(merchantId || '').trim() || null,
      ...(String(productGroupId || '').trim() ? { product_group_id: String(productGroupId).trim() } : {}),
      ...(String(skuId || '').trim() ? { sku_id: String(skuId).trim() } : {}),
      ...(String(brand || '').trim() ? { brand: String(brand).trim() } : {}),
      ...(String(name || '').trim() ? { name: String(name).trim() } : {}),
      ...(String(displayName || '').trim() ? { display_name: String(displayName).trim() } : {}),
      ...(String(imageUrl || '').trim() ? { image_url: String(imageUrl).trim() } : {}),
      ...(String(category || '').trim() ? { category: String(category).trim() } : {}),
      ...(String(sourceToken || '').trim() ? { source: String(sourceToken).trim() } : {}),
      ...(normalizedRetrievalSource ? { retrieval_source: normalizedRetrievalSource } : {}),
      ...(String(retrievalReasonRaw || '').trim() ? { retrieval_reason: String(retrievalReasonRaw).trim() } : {}),
      ...(directUrl ? { url: directUrl, pdp_url: directUrl } : {}),
      ...(purchasePath ? { purchase_path: purchasePath } : {}),
      ...(openContract ? { open_contract: openContract } : {}),
      ...(pdpOpen ? { pdp_open: pdpOpen } : {}),
      ...(price ? { price } : {}),
      ...(ingredientTokens.length ? { ingredient_tokens: ingredientTokens } : {}),
      ...(skinTypeTags.length ? { skin_type_tags: skinTypeTags } : {}),
      ...(socialRef.score != null ? { social_ref_score: Number(socialRef.score.toFixed(3)) } : {}),
      ...(socialRef.support_count != null ? { social_ref_support_count: Math.trunc(socialRef.support_count) } : {}),
      ...(socialRef.social_raw ? { social_raw: socialRef.social_raw } : {}),
    }

    const canonicalProductRef = normalizeCanonicalProductRef(
      {
        product_id: out.product_id,
        merchant_id: out.merchant_id,
      },
      { requireMerchant: true, allowOpaqueProductId: false },
    )
    if (canonicalProductRef) out.canonical_product_ref = canonicalProductRef

    return out.product_id ? out : null
  }

  function normalizeBaseUrlForRecoCatalogSearch(value) {
    const raw = String(value || '').trim()
    if (!raw) return ''
    return raw.replace(/\/+$/, '')
  }

  function buildRecoCatalogSearchBaseUrlCandidates({
    includeLocalFallback = false,
    preferConfigured = RECO_CATALOG_SEARCH_PREFER_CONFIGURED_BASE_URLS,
    includeSelfProxy = RECO_CATALOG_SEARCH_SELF_PROXY_ENABLED,
    preferSelfProxyFirst = RECO_CATALOG_SEARCH_AURORA_SELF_PROXY_FIRST,
  } = {}) {
    const out = []
    const seen = new Set()
    const add = (value) => {
      const normalized = normalizeBaseUrlForRecoCatalogSearch(value)
      if (!normalized || seen.has(normalized)) return
      seen.add(normalized)
      out.push(normalized)
    }
    const addConfigured = () => {
      if (!RECO_CATALOG_SEARCH_BASE_URLS) return
      const tokens = RECO_CATALOG_SEARCH_BASE_URLS
        .split(/[\s,;|]+/)
        .map((token) => token.trim())
        .filter(Boolean)
      for (const token of tokens) add(token)
    }
    const addSelfProxy = () => {
      if (includeSelfProxy) add(RECO_CATALOG_SEARCH_SELF_PROXY_BASE_URL)
    }
    if (preferSelfProxyFirst) {
      addSelfProxy()
      if (preferConfigured) {
        addConfigured()
        add(PIVOTA_BACKEND_BASE_URL)
      } else {
        add(PIVOTA_BACKEND_BASE_URL)
        addConfigured()
      }
    } else if (preferConfigured) {
      addConfigured()
      addSelfProxy()
      add(PIVOTA_BACKEND_BASE_URL)
    } else {
      add(PIVOTA_BACKEND_BASE_URL)
      addConfigured()
      addSelfProxy()
    }
    if (includeLocalFallback) add(RECO_PDP_LOCAL_INVOKE_BASE_URL)
    return out
  }

  function normalizeRecoCatalogSearchPath(value) {
    const raw = String(value || '').trim()
    if (!raw) return ''
    let path = raw
    if (/^https?:\/\//i.test(path)) {
      try {
        const parsed = new URL(path)
        path = parsed.pathname || ''
      } catch (_err) {
        return ''
      }
    }
    if (!path) return ''
    path = path.startsWith('/') ? path : `/${path}`
    path = path.replace(/\/{2,}/g, '/')
    path = path.split('?')[0].split('#')[0]
    if (!path || path === '/') return ''
    return path.replace(/\/+$/, '') || ''
  }

  function buildRecoCatalogSearchPathCandidates() {
    const out = []
    const seen = new Set()
    const genericPath = '/agent/v1/products/search'
    const beautyPath = '/agent/v1/beauty/products/search'
    const add = (value) => {
      const normalized = normalizeRecoCatalogSearchPath(value)
      if (!normalized || seen.has(normalized)) return
      seen.add(normalized)
      out.push(normalized)
    }
    if (RECO_CATALOG_SEARCH_PATHS) {
      const tokens = RECO_CATALOG_SEARCH_PATHS
        .split(/[\s,;|]+/)
        .map((token) => token.trim())
        .filter(Boolean)
      for (const token of tokens) add(token)
    } else if (RECO_CATALOG_BEAUTY_ROUTE_FIRST_ENABLED) {
      add(beautyPath)
    }
    add(genericPath)
    if (RECO_CATALOG_BEAUTY_PATH_FALLBACK_ENABLED) add(beautyPath)

    if (RECO_CATALOG_BEAUTY_ROUTE_FIRST_ENABLED) {
      return [
        ...(out.includes(beautyPath) ? [beautyPath] : []),
        ...out.filter((item) => item !== beautyPath),
      ]
    }
    return [
      ...(out.includes(genericPath) ? [genericPath] : []),
      ...out.filter((item) => item !== genericPath),
    ]
  }

  function getRecoCatalogSearchSourceState(baseUrl) {
    const key = normalizeBaseUrlForRecoCatalogSearch(baseUrl)
    if (!key) return null
    let state = recoCatalogSearchSourceState.get(key)
    if (!state) {
      state = {
        base_url: key,
        consecutive_empty: 0,
        consecutive_failures: 0,
        deprioritized_until_ms: 0,
        last_reason: null,
        last_success_at: 0,
        last_updated_at: 0,
      }
      recoCatalogSearchSourceState.set(key, state)
    }
    return state
  }

  function markRecoCatalogSearchSourceSuccess(baseUrl, nowMs = Date.now()) {
    const state = getRecoCatalogSearchSourceState(baseUrl)
    if (!state) return
    state.consecutive_empty = 0
    state.consecutive_failures = 0
    state.deprioritized_until_ms = 0
    state.last_reason = null
    state.last_success_at = nowMs
    state.last_updated_at = nowMs
  }

  function markRecoCatalogSearchSourceFailure(baseUrl, reason, nowMs = Date.now()) {
    const state = getRecoCatalogSearchSourceState(baseUrl)
    if (!state) return
    const normalizedReason = String(reason || '').trim() || 'unknown'
    const isEmpty = normalizedReason === 'empty' || normalizedReason === 'not_found'
    const isTransient =
      normalizedReason === 'upstream_timeout' ||
      normalizedReason === 'upstream_error' ||
      normalizedReason === 'rate_limited'
    if (isEmpty) {
      state.consecutive_empty = Number(state.consecutive_empty || 0) + 1
      state.consecutive_failures = 0
      if (state.consecutive_empty >= RECO_CATALOG_SOURCE_EMPTY_FAIL_THRESHOLD) {
        state.deprioritized_until_ms = nowMs + RECO_CATALOG_SOURCE_EMPTY_COOLDOWN_MS
      }
    } else {
      state.consecutive_failures = Number(state.consecutive_failures || 0) + 1
      state.consecutive_empty = 0
      if (
        isTransient &&
        state.consecutive_failures >= RECO_CATALOG_SOURCE_TRANSIENT_FAIL_THRESHOLD
      ) {
        state.deprioritized_until_ms = nowMs + RECO_CATALOG_SOURCE_TRANSIENT_COOLDOWN_MS
      }
    }
    state.last_reason = normalizedReason
    state.last_updated_at = nowMs
  }

  function getRecoCatalogSearchSourceHealthSnapshot(nowMs = Date.now()) {
    const out = []
    for (const [baseUrl, raw] of recoCatalogSearchSourceState.entries()) {
      const state = raw && typeof raw === 'object' ? raw : {}
      const deprioritizedUntilMs = Number(state.deprioritized_until_ms || 0)
      out.push({
        base_url: baseUrl,
        consecutive_empty: Number(state.consecutive_empty || 0),
        consecutive_failures: Number(state.consecutive_failures || 0),
        deprioritized: deprioritizedUntilMs > nowMs,
        deprioritized_until_ms: deprioritizedUntilMs,
        last_reason: state.last_reason || null,
        last_success_at: Number(state.last_success_at || 0),
        last_updated_at: Number(state.last_updated_at || 0),
      })
    }
    out.sort((a, b) => String(a.base_url || '').localeCompare(String(b.base_url || '')))
    return out
  }

  function rankRecoCatalogSearchBaseUrls(baseUrls, nowMs = Date.now()) {
    const normalized = Array.isArray(baseUrls)
      ? baseUrls.map((item) => normalizeBaseUrlForRecoCatalogSearch(item)).filter(Boolean)
      : []
    if (!normalized.length) return []
    return normalized
      .map((baseUrl, idx) => {
        const state = getRecoCatalogSearchSourceState(baseUrl) || {}
        const deprioritizedUntilMs = Number(state.deprioritized_until_ms || 0)
        const deprioritized = deprioritizedUntilMs > nowMs
        const lastSuccessAt = Number(state.last_success_at || 0)
        return {
          base_url: baseUrl,
          idx,
          deprioritized,
          last_success_at: lastSuccessAt,
        }
      })
      .sort((a, b) => {
        if (a.deprioritized !== b.deprioritized) return a.deprioritized ? 1 : -1
        if (a.last_success_at !== b.last_success_at) return b.last_success_at - a.last_success_at
        return a.idx - b.idx
      })
      .map((item) => item.base_url)
  }

  function getRecoCatalogFailFastSnapshot(nowMs = Date.now()) {
    const openUntilMs = Number(recoCatalogFailFastState.open_until_ms || 0)
    const open = RECO_CATALOG_FAIL_FAST_ENABLED && nowMs < openUntilMs
    const lastProbeStartedAt = Number(recoCatalogFailFastState.last_probe_started_at || 0)
    const probeElapsedMs = Math.max(0, nowMs - lastProbeStartedAt)
    const nextProbeInMs = open ? Math.max(0, RECO_CATALOG_FAIL_FAST_PROBE_INTERVAL_MS - probeElapsedMs) : 0
    const canProbeWhileOpen = open && nextProbeInMs <= 0
    return {
      enabled: RECO_CATALOG_FAIL_FAST_ENABLED,
      open,
      open_until_ms: open ? openUntilMs : 0,
      consecutive_failures: Number(recoCatalogFailFastState.consecutive_failures || 0),
      last_reason: recoCatalogFailFastState.last_reason || null,
      cooldown_ms: RECO_CATALOG_FAIL_FAST_COOLDOWN_MS,
      threshold: RECO_CATALOG_FAIL_FAST_THRESHOLD,
      probe_interval_ms: RECO_CATALOG_FAIL_FAST_PROBE_INTERVAL_MS,
      last_probe_started_at: lastProbeStartedAt || 0,
      can_probe_while_open: canProbeWhileOpen,
      next_probe_in_ms: nextProbeInMs,
    }
  }

  function markRecoCatalogFailFastSuccess() {
    recoCatalogFailFastState.consecutive_failures = 0
    recoCatalogFailFastState.open_until_ms = 0
    recoCatalogFailFastState.last_reason = null
    recoCatalogFailFastState.last_failed_at = 0
    recoCatalogFailFastState.last_probe_started_at = 0
  }

  function markRecoCatalogFailFastFailure(reason, nowMs = Date.now()) {
    if (!RECO_CATALOG_FAIL_FAST_ENABLED) return
    recoCatalogFailFastState.consecutive_failures = Number(recoCatalogFailFastState.consecutive_failures || 0) + 1
    recoCatalogFailFastState.last_reason = reason || 'unknown'
    recoCatalogFailFastState.last_failed_at = nowMs
    if (recoCatalogFailFastState.consecutive_failures >= RECO_CATALOG_FAIL_FAST_THRESHOLD) {
      recoCatalogFailFastState.open_until_ms = nowMs + RECO_CATALOG_FAIL_FAST_COOLDOWN_MS
      recoCatalogFailFastState.last_probe_started_at = nowMs
    }
  }

  function beginRecoCatalogFailFastProbe(nowMs = Date.now()) {
    if (!RECO_CATALOG_FAIL_FAST_ENABLED) return false
    const snapshot = getRecoCatalogFailFastSnapshot(nowMs)
    if (!snapshot.open || !snapshot.can_probe_while_open) return false
    recoCatalogFailFastState.last_probe_started_at = nowMs
    return true
  }

  return {
    normalizeRecoCatalogProduct,
    normalizeBaseUrlForRecoCatalogSearch,
    buildRecoCatalogSearchBaseUrlCandidates,
    normalizeRecoCatalogSearchPath,
    buildRecoCatalogSearchPathCandidates,
    getRecoCatalogSearchSourceState,
    markRecoCatalogSearchSourceSuccess,
    markRecoCatalogSearchSourceFailure,
    getRecoCatalogSearchSourceHealthSnapshot,
    rankRecoCatalogSearchBaseUrls,
    getRecoCatalogFailFastSnapshot,
    markRecoCatalogFailFastSuccess,
    markRecoCatalogFailFastFailure,
    beginRecoCatalogFailFastProbe,
  }
}

module.exports = {
  createRecoCatalogSearchSupportRuntime,
}
