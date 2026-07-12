'use strict';
/**
 * Fix Plan D · T3 — discovery provenance (`seed_data.discovered_via`).
 *
 * Records HOW a seed entered the index, as a small additive structure:
 *   discovered_via = { channel, evidence_url, source_host, at }
 * where `channel` is one of 'ulta' | 'sephora' | 'olive_young' | 'target' |
 * 'amazon' | 'brand_site' | 'agent_search' | ... (open vocabulary).
 *
 * This is the STRUCTURED source of truth for "available at Olive Young / Ulta"
 * copy — externalSeedLocalityFacts.js otherwise guesses the channel from title
 * tokens / URLs. We NEVER invent a channel: OY provenance is only stamped when a
 * seed genuinely arrived via the OY lane, and the OY-discovered D2C cohort whose
 * channel is unknown is reported for founder input rather than inferred.
 */

const CHANNEL_HOST_PATTERNS = [
  ['olive_young', /(^|\.)oliveyoung\.(com|co\.kr)$|(^|\.)global\.oliveyoung\.com$/i],
  ['ulta', /(^|\.)ulta\.com$/i],
  ['sephora', /(^|\.)sephora\.(com|[a-z.]+)$/i],
  ['target', /(^|\.)target\.com$/i],
  ['amazon', /(^|\.)amazon\.[a-z.]+$|(^|\.)amzn\.(to|com)$/i],
  ['walmart', /(^|\.)walmart\.com$/i],
  ['nordstrom', /(^|\.)nordstrom\.com$/i],
  ['dermstore', /(^|\.)dermstore\.com$/i],
  ['yesstyle', /(^|\.)yesstyle\.com$/i],
];

function hostFromUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Infer a discovery channel from an evidence URL/host. Returns '' when unknown. */
function inferChannelFromHost(urlOrHost) {
  const host = hostFromUrl(urlOrHost);
  if (!host) return '';
  for (const [channel, re] of CHANNEL_HOST_PATTERNS) {
    if (re.test(host)) return channel;
  }
  return '';
}

/**
 * Build a discovered_via record. `channel` wins if provided; otherwise it is
 * inferred from the evidence URL; otherwise the caller-supplied `fallback`.
 */
function buildDiscoveredVia({ channel, evidenceUrl, fallback = 'agent_search', at } = {}) {
  const host = hostFromUrl(evidenceUrl);
  const resolved = String(channel || '').trim() || inferChannelFromHost(evidenceUrl) || fallback;
  const record = { channel: resolved, at: at || new Date().toISOString() };
  if (evidenceUrl) record.evidence_url = String(evidenceUrl);
  if (host) record.source_host = host;
  return record;
}

/** True when a seed_data object already carries a usable discovered_via.channel. */
function hasDiscoveredVia(seedData) {
  const dv = seedData && typeof seedData === 'object' ? seedData.discovered_via : null;
  return Boolean(dv && typeof dv === 'object' && String(dv.channel || '').trim());
}

/**
 * Attach discovered_via onto a seed_data object (and its snapshot), immutably.
 * No-op (returns the same shape) when discovered_via already present unless
 * `overwrite` is set.
 */
function applyDiscoveredViaToSeedData(seedData = {}, discoveredVia, { overwrite = false } = {}) {
  const base = seedData && typeof seedData === 'object' ? seedData : {};
  if (!overwrite && hasDiscoveredVia(base)) return base;
  const snapshot = base.snapshot && typeof base.snapshot === 'object' ? base.snapshot : undefined;
  return {
    ...base,
    discovered_via: discoveredVia,
    ...(snapshot ? { snapshot: { ...snapshot, discovered_via: discoveredVia } } : {}),
  };
}

module.exports = {
  CHANNEL_HOST_PATTERNS,
  hostFromUrl,
  inferChannelFromHost,
  buildDiscoveredVia,
  hasDiscoveredVia,
  applyDiscoveredViaToSeedData,
};
