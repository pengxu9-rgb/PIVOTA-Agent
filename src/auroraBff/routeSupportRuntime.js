function cloneRequiredRouteContracts(requiredRouteContracts = []) {
  return (Array.isArray(requiredRouteContracts) ? requiredRouteContracts : []).map((item) => ({ ...item }));
}

function createRequiredRouteContractsHealth(requiredRouteContracts = [], { checked = false, ok = false, scope = 'travel_plans', missingRoutes = null } = {}) {
  const requiredRoutes = cloneRequiredRouteContracts(requiredRouteContracts);
  return Object.freeze({
    checked: Boolean(checked),
    ok: Boolean(ok),
    scope,
    required_routes: requiredRoutes,
    missing_routes: Array.isArray(missingRoutes) ? missingRoutes : requiredRoutes,
  });
}

function createAuroraRouteSupportRuntime({
  normalizeProductIntelKbKey,
  sanitizeSuggestionForPublic,
  normalizeBlockToken,
  getAuroraKbFailMode,
  getAuroraKbV0,
  requiredRouteContracts = [],
  assertRequiredRouteContracts,
  requiredRouteScope = 'travel_plans',
} = {}) {
  let requiredRouteContractsHealth = createRequiredRouteContractsHealth(requiredRouteContracts, {
    scope: requiredRouteScope,
  });

  function buildPrelabelKbKey(anchorProductId, lang = 'EN') {
    void lang;
    const anchor = String(anchorProductId || '').trim();
    if (!anchor) return '';
    return normalizeProductIntelKbKey(`product:${anchor}`);
  }

  function buildLegacyPrelabelKbKey(anchorProductId, lang = 'EN') {
    const anchor = String(anchorProductId || '').trim();
    if (!anchor) return '';
    const langCode = String(lang || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
    return normalizeProductIntelKbKey(`product:${anchor}|lang:${langCode}`);
  }

  function buildPrelabelKbReadCandidates(anchorProductId, lang = 'EN') {
    const out = [];
    const push = (rawKey) => {
      const key = String(rawKey || '').trim();
      if (!key) return;
      if (out.includes(key)) return;
      out.push(key);
    };
    push(buildPrelabelKbKey(anchorProductId, lang));
    push(buildLegacyPrelabelKbKey(anchorProductId, lang));
    push(buildLegacyPrelabelKbKey(anchorProductId, 'EN'));
    push(buildLegacyPrelabelKbKey(anchorProductId, 'CN'));
    return out;
  }

  function mapSuggestionForResponse(row) {
    const item = sanitizeSuggestionForPublic(row);
    if (!item) return null;
    return {
      ...item,
      anchor_product_id: String(row?.anchor_product_id || '').trim(),
      block: normalizeBlockToken(row?.block),
      candidate_product_id: String(row?.candidate_product_id || '').trim(),
    };
  }

  function preflightAuroraKbV0ForStartup({ logger } = {}) {
    const failMode = getAuroraKbFailMode();
    try {
      const kb = getAuroraKbV0({ forceReload: true });
      if (kb && kb.ok === false && failMode === 'closed') {
        const reason = String(kb.reason || 'kb_preflight_failed').trim();
        throw new Error(`AURORA_KB_FAIL_MODE=closed blocked startup: ${reason}`);
      }
      if (kb && kb.ok === false && failMode === 'open') {
        logger?.warn?.(
          {
            fail_mode: failMode,
            reason: kb.reason || 'loader_unavailable',
            diagnostics: kb.diagnostics || null,
          },
          'aurora bff: kb v0 preflight failed; running with legacy fallback (open mode)',
        );
      }
    } catch (error) {
      if (failMode === 'closed') {
        throw error;
      }
      logger?.warn?.(
        {
          fail_mode: failMode,
          err: error && error.message ? error.message : String(error),
        },
        'aurora bff: kb v0 preflight threw; running with legacy fallback (open mode)',
      );
    }
  }

  function getRequiredRouteContractsHealth() {
    return requiredRouteContractsHealth;
  }

  function checkRequiredRouteContracts(app, { logger } = {}) {
    try {
      requiredRouteContractsHealth = Object.freeze({
        checked: true,
        ...assertRequiredRouteContracts(app, requiredRouteContracts, {
          scope: requiredRouteScope,
        }),
      });
      return requiredRouteContractsHealth;
    } catch (err) {
      requiredRouteContractsHealth = createRequiredRouteContractsHealth(requiredRouteContracts, {
        checked: true,
        ok: false,
        scope: requiredRouteScope,
        missingRoutes: Array.isArray(err && err.missing_routes) ? err.missing_routes : [],
      });
      logger?.error?.(
        {
          err: err && err.message ? err.message : String(err),
          code: err && err.code ? err.code : null,
          missing_routes: requiredRouteContractsHealth.missing_routes,
        },
        'aurora bff: required route contracts check failed',
      );
      throw err;
    }
  }

  return {
    buildPrelabelKbKey,
    buildPrelabelKbReadCandidates,
    mapSuggestionForResponse,
    preflightAuroraKbV0ForStartup,
    getRequiredRouteContractsHealth,
    checkRequiredRouteContracts,
  };
}

module.exports = {
  createAuroraRouteSupportRuntime,
};
