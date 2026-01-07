const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { z } = require('zod');

const { loadRolesLatest, buildRoleNormalizer } = require('../layer2/dicts/roles');
const { applyNormalization, buildRoleCandidatesFromDict, suggestRoleIdsForHint } = require('../layer2/kb/roleHintIntegrity');
const { canonicalizeUrl, hostnameMatchesAllowlist, stableOfferIdFromCanonicalUrl, validateHttpUrlOrThrow } = require('../layer3/external/urlUtils');
const { resolveExternalOffer } = require('../layer3/external/externalOfferResolver');

function stableHashShort(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex').slice(0, 12);
}

function readLinesFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  return text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('#'))
    .map((l) => l.toLowerCase());
}

function allowedDomainsForMarket(market) {
  const env =
    market === 'US'
      ? process.env.EXTERNAL_OFFER_ALLOWED_DOMAINS_US
      : process.env.EXTERNAL_OFFER_ALLOWED_DOMAINS_JP;
  const fromEnv = String(env || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (fromEnv.length) return fromEnv;

  // Fallback to repo allowlist files (keeps local/dev behavior sane when env vars are absent).
  const dataDir = path.join(__dirname, '..', 'layer3', 'data');
  const file =
    market === 'US'
      ? path.join(dataDir, 'external_allowlist_US.txt')
      : path.join(dataDir, 'external_allowlist_JP.txt');
  return readLinesFile(file);
}

function tryReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadExternalLinksPoolFromDisk(market) {
  const dataDir = path.join(__dirname, '..', 'layer3', 'data');
  const poolPath = path.join(dataDir, `externalLinks_${market}.json`);
  const legacyPath = path.join(dataDir, market === 'JP' ? 'externalLinks_jp.json' : 'externalLinks_us.json');

  const poolRaw = tryReadJson(poolPath);
  if (poolRaw) return { raw: poolRaw, path: poolPath, sha: stableHashShort(fs.readFileSync(poolPath, 'utf8')) };

  const legacyRaw = tryReadJson(legacyPath);
  if (legacyRaw) return { raw: legacyRaw, path: legacyPath, sha: stableHashShort(fs.readFileSync(legacyPath, 'utf8')) };

  return { raw: {}, path: null, sha: null };
}

function coerceByRoleEntries(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  // New pool format: { byRole: { [ROLE:...]: [{ url, priority, domain, ... }] } }
  const byRole = raw.byRole;
  if (byRole && typeof byRole === 'object' && !Array.isArray(byRole)) {
    const out = {};
    for (const roleId of Object.keys(byRole).sort()) {
      const entries = byRole[roleId];
      if (!Array.isArray(entries)) continue;
      const list = [];
      for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        const url = String(e.url || '').trim();
        if (!url) continue;
        const priority = Number.isFinite(e.priority) ? Number(e.priority) : 0;
        const domain = String(e.domain || '').trim().toLowerCase() || (() => {
          try {
            return new URL(url).hostname.toLowerCase();
          } catch {
            return '';
          }
        })();
        list.push({ url, priority, domain, source: 'pool' });
      }
      out[roleId] = list;
    }
    return out;
  }

  // Legacy format: { [ROLE:...]: string[] }
  const out = {};
  for (const roleId of Object.keys(raw).sort()) {
    const urls = raw[roleId];
    if (!Array.isArray(urls)) continue;
    const list = [];
    for (const u of urls) {
      const url = String(u || '').trim();
      if (!url) continue;
      let domain = '';
      try {
        domain = new URL(url).hostname.toLowerCase();
      } catch {
        domain = '';
      }
      list.push({ url, priority: 0, domain, source: 'legacy' });
    }
    out[roleId] = list;
  }
  return out;
}

function uniqueStringsPreserveOrder(items) {
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const s = String(it || '').trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= list.length) return;
      results[i] = await mapper(list[i], i);
    }
  }
  const n = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function normalizeRoleHints({ roleHints, maxSuggestions = 3 }) {
  const rolesDict = loadRolesLatest();
  const roleNormalizer = buildRoleNormalizer(rolesDict);
  const { rules, candidates } = buildRoleCandidatesFromDict(rolesDict);

  const normalizedRoles = [];
  const resolvedRoleIds = [];

  for (const hintRaw of Array.isArray(roleHints) ? roleHints : []) {
    const inputHint = String(hintRaw || '').trim();
    if (!inputHint) continue;

    const detail = roleNormalizer.normalizeRoleHintDetailed
      ? roleNormalizer.normalizeRoleHintDetailed(inputHint)
      : null;
    const mapped = detail?.roleId || roleNormalizer.normalizeRoleHint(inputHint);

    if (mapped) {
      const normalizedRoleId = `ROLE:${mapped}`;
      resolvedRoleIds.push(normalizedRoleId);
      normalizedRoles.push({
        inputHint,
        normalizedRoleId,
        confidence: detail?.matched === 'synonym' ? 0.9 : 1.0,
        reason: detail ? `matched_${detail.matched}` : 'matched',
        matchedValue: detail?.matchedValue,
      });
      continue;
    }

    const normalizedHint = applyNormalization(inputHint, rules);
    const suggestions = suggestRoleIdsForHint({ normalizedHint, candidates, max: maxSuggestions }).map((id) => `ROLE:${id}`);
    normalizedRoles.push({
      inputHint,
      normalizedRoleId: null,
      confidence: 0,
      reason: 'no_match',
      suggestions,
    });
  }

  return {
    rolesDict,
    normalizedRoles,
    roleIds: uniqueStringsPreserveOrder(resolvedRoleIds),
  };
}

function assembleFeed(params) {
  const {
    market,
    locale,
    roleIds,
    poolByRole,
    maxOffersPerRole,
    maxTotalOffers,
    domainCapPerRole,
    domainCapGlobal,
    dedupeMode,
    allowedDomains,
    includeFilterReasons,
  } = params;

  const filtered = [];
  const selectedCanonicalUrls = new Set();
  const globalDomainCounts = new Map();

  let totalSelected = 0;
  const items = [];

  for (const roleId of roleIds) {
    const entries = Array.isArray(poolByRole[roleId]) ? poolByRole[roleId] : [];
    const urlsOut = [];
    const perRoleDomainCounts = new Map();

    for (const entry of entries) {
      if (urlsOut.length >= maxOffersPerRole) break;
      if (totalSelected >= maxTotalOffers) break;

      const rawUrl = String(entry?.url || '').trim();
      if (!rawUrl) continue;

      let parsed;
      try {
        parsed = validateHttpUrlOrThrow(rawUrl);
      } catch (err) {
        if (includeFilterReasons) filtered.push({ roleId, url: rawUrl, reason: 'URL_INVALID' });
        continue;
      }

      const domain = parsed.hostname.toLowerCase();
      if (allowedDomains?.length && !hostnameMatchesAllowlist(domain, allowedDomains)) {
        if (includeFilterReasons) filtered.push({ roleId, url: rawUrl, reason: 'DOMAIN_NOT_ALLOWED', domain });
        continue;
      }

      const canonicalUrl = canonicalizeUrl(parsed);
      const canonicalDomain = new URL(canonicalUrl).hostname.toLowerCase();

      const offerKey = stableOfferIdFromCanonicalUrl(canonicalUrl);

      const dedupeKey = canonicalUrl;
      if (dedupeMode === 'global' && selectedCanonicalUrls.has(dedupeKey)) {
        if (includeFilterReasons) filtered.push({ roleId, url: canonicalUrl, reason: 'DUPLICATE_GLOBAL', offerKey });
        continue;
      }

      const roleDomainCount = perRoleDomainCounts.get(canonicalDomain) || 0;
      if (roleDomainCount >= domainCapPerRole) {
        if (includeFilterReasons) filtered.push({ roleId, url: canonicalUrl, reason: 'DOMAIN_CAP_ROLE', domain: canonicalDomain });
        continue;
      }

      const globalCount = globalDomainCounts.get(canonicalDomain) || 0;
      if (globalCount >= domainCapGlobal) {
        if (includeFilterReasons) filtered.push({ roleId, url: canonicalUrl, reason: 'DOMAIN_CAP_GLOBAL', domain: canonicalDomain });
        continue;
      }

      perRoleDomainCounts.set(canonicalDomain, roleDomainCount + 1);
      globalDomainCounts.set(canonicalDomain, globalCount + 1);
      if (dedupeMode === 'global') selectedCanonicalUrls.add(dedupeKey);

      urlsOut.push({
        url: canonicalUrl,
        domain: canonicalDomain,
        source: entry.source || 'unknown',
        priority: Number.isFinite(entry.priority) ? entry.priority : 0,
        offerKey,
        ...(locale ? { locale } : {}),
        market,
      });

      totalSelected += 1;
    }

    const truncated = urlsOut.length < Math.min(entries.length, maxOffersPerRole) && entries.length > urlsOut.length;
    items.push({ roleId, urls: urlsOut, truncated });
    if (totalSelected >= maxTotalOffers) break;
  }

  return { feedItems: items, ...(includeFilterReasons ? { filtered } : {}) };
}

// NOTE: Use z.enum for string unions to avoid z.union([..., undefined]) footguns
// that can throw "Cannot read properties of undefined (reading '_zod')" at runtime.
const MarketSchema = z.enum(['US', 'JP']);

const FeedRequestSchema = z
  .object({
    requestId: z.string().min(1).optional(),
    market: MarketSchema,
    locale: z.string().min(1).optional(),
    roleIds: z.array(z.string().min(1)).optional(),
    roleHints: z.array(z.string().min(1)).optional(),
    maxOffersPerRole: z.number().int().min(1).max(10).optional(),
    maxTotalOffers: z.number().int().min(1).max(100).optional(),
    diversity: z
      .object({
        domainCapPerRole: z.number().int().min(1).max(50).optional(),
        domainCapGlobal: z.number().int().min(1).max(200).optional(),
        dedupe: z.enum(['global', 'perRole']).optional(),
      })
      .optional(),
    // NOTE: With zod@4.1.x, `z.record(valueSchema)` can throw
    // "Cannot read properties of undefined (reading '_zod')" at runtime.
    // Always provide both key+value schema args.
    context: z.record(z.string(), z.unknown()).optional(),
    debug: z
      .object({
        includeMapping: z.boolean().optional(),
        includeFilterReasons: z.boolean().optional(),
      })
      .optional(),
    resolve: z.enum(['none', 'inline', 'deferred']).optional(),
  })
  .strict()
  .refine((v) => (Array.isArray(v.roleIds) && v.roleIds.length) || (Array.isArray(v.roleHints) && v.roleHints.length), {
    message: 'Provide roleIds and/or roleHints',
  });

const NormalizeRequestSchema = z
  .object({
    market: MarketSchema.optional(),
    roleHints: z.array(z.string().min(1)).min(1),
    maxSuggestions: z.number().int().min(0).max(10).optional(),
  })
  .strict();

function mountRecommendationRoutes(app) {
  function requireInternalKey(req, res) {
    const expected = String(process.env.RECOMMENDATIONS_INTERNAL_KEY || '').trim();
    const env = String(process.env.NODE_ENV || process.env.APP_ENV || '').toLowerCase();
    const isProd = env === 'production' || env === 'prod';
    if (!expected) {
      if (isProd) return res.status(500).json({ error: 'CONFIG_MISSING', message: 'Missing RECOMMENDATIONS_INTERNAL_KEY' });
      return true; // dev default
    }
    const provided = String(req.header('X-Internal-Key') || '').trim();
    if (provided && provided === expected) return true;
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or invalid X-Internal-Key' });
  }

  app.post('/v1/recommendations/roles/normalize', async (req, res) => {
    if (!requireInternalKey(req, res)) return;
    let body;
    try {
      body = NormalizeRequestSchema.parse(req.body);
    } catch (err) {
      return res.status(400).json({ error: 'BAD_REQUEST', details: String(err) });
    }

    try {
      const out = normalizeRoleHints({ roleHints: body.roleHints, maxSuggestions: body.maxSuggestions ?? 3 });
      return res.json({
        normalizedRoles: out.normalizedRoles,
        meta: {
          roleTaxonomyVersion: out.rolesDict.schemaVersion,
          roleTaxonomySha: stableHashShort(JSON.stringify(out.rolesDict)),
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      return res.status(500).json({ error: 'NORMALIZE_FAILED', message: String(err?.message || err) });
    }
  });

  app.post('/v1/recommendations/feed', async (req, res) => {
    if (!requireInternalKey(req, res)) return;
    let body;
    try {
      body = FeedRequestSchema.parse(req.body);
    } catch (err) {
      return res.status(400).json({ error: 'BAD_REQUEST', details: String(err) });
    }

    const requestId =
      String(body.requestId || '') ||
      (body.context && typeof body.context.requestId === 'string' && body.context.requestId.trim()) ||
      (crypto.randomUUID ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(16).slice(2)}`);

    const rolesDict = loadRolesLatest();
    const roleTaxonomySha = stableHashShort(JSON.stringify(rolesDict));

    const includeMapping = body.debug?.includeMapping !== false;
    const includeFilterReasons = body.debug?.includeFilterReasons === true;

    const normalized = body.roleHints?.length ? normalizeRoleHints({ roleHints: body.roleHints, maxSuggestions: 3 }) : null;
    const resolvedFromHints = normalized ? normalized.roleIds : [];

    const explicitRoleIds = uniqueStringsPreserveOrder(body.roleIds || [])
      .map((s) => s.trim())
      .filter(Boolean);

    const combinedRoleIds = uniqueStringsPreserveOrder([...explicitRoleIds, ...resolvedFromHints]).filter((id) => id.startsWith('ROLE:'));

    const { raw: poolRaw, path: poolPath, sha: poolSha } = loadExternalLinksPoolFromDisk(body.market);
    const poolByRole = coerceByRoleEntries(poolRaw);

    const allowedDomains = allowedDomainsForMarket(body.market);
    const maxOffersPerRole = body.maxOffersPerRole ?? 2;
    const maxTotalOffers = body.maxTotalOffers ?? 20;
    const domainCapPerRole = body.diversity?.domainCapPerRole ?? 2;
    const domainCapGlobal = body.diversity?.domainCapGlobal ?? 50;
    const dedupeMode = body.diversity?.dedupe ?? 'global';
    const resolveMode = body.resolve ?? 'deferred';

    const feedBase = assembleFeed({
      market: body.market,
      locale: body.locale,
      roleIds: combinedRoleIds,
      poolByRole,
      maxOffersPerRole,
      maxTotalOffers,
      domainCapPerRole,
      domainCapGlobal,
      dedupeMode,
      allowedDomains,
      includeFilterReasons,
    });

    if (resolveMode === 'inline') {
      const itemsWithOffers = [];
      for (const item of feedBase.feedItems) {
        const results = await mapWithConcurrency(item.urls, 3, async (u) => {
          try {
            const offer = await resolveExternalOffer({ url: u.url, market: body.market, locale: body.locale });
            return { ok: true, offer };
          } catch (err) {
            return { ok: false, error: String(err?.code || 'RESOLVE_FAILED'), url: u.url, offerKey: u.offerKey };
          }
        });
        const offers = [];
        const failures = [];
        for (const r of results) {
          if (r.ok) offers.push(r.offer);
          else failures.push({ offerKey: r.offerKey, url: r.url, reason: r.error });
        }
        itemsWithOffers.push({ roleId: item.roleId, offers, failures, truncated: item.truncated });
      }
      return res.json({
        ...(includeMapping && normalized ? { normalizedRoles: normalized.normalizedRoles } : {}),
        feedItems: itemsWithOffers,
        meta: {
          requestId,
          generatedAt: new Date().toISOString(),
          ttlSeconds: 3600,
          configVersion: poolSha,
          roleTaxonomyVersion: rolesDict.schemaVersion,
          roleTaxonomySha,
          ...(poolPath ? { poolPath } : {}),
        },
        ...(includeFilterReasons && feedBase.filtered ? { filtered: feedBase.filtered } : {}),
      });
    }

    return res.json({
      ...(includeMapping && normalized ? { normalizedRoles: normalized.normalizedRoles } : {}),
      feedItems: feedBase.feedItems,
      meta: {
        requestId,
        generatedAt: new Date().toISOString(),
        ttlSeconds: 3600,
        configVersion: poolSha,
        roleTaxonomyVersion: rolesDict.schemaVersion,
        roleTaxonomySha,
        ...(poolPath ? { poolPath } : {}),
      },
      ...(includeFilterReasons && feedBase.filtered ? { filtered: feedBase.filtered } : {}),
    });
  });
}

module.exports = { mountRecommendationRoutes };
