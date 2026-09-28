'use strict';

const MAX_ROBOTS_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_DOMAIN = 50;
const MAX_RETRIES = 1;
const REQUIRED_USER_AGENT_PREFIX = 'PivotaCommerceIndexBot/';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeHttpsUrl(value) {
  const raw = nonEmptyString(value);
  if (!raw) return { error: 'URL is required.' };
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return { error: 'URL must use HTTPS.' };
    if (parsed.username || parsed.password) return { error: 'URL must not contain credentials.' };
    parsed.hash = '';
    return { url: parsed };
  } catch {
    return { error: 'URL is invalid.' };
  }
}

function parseCheckedAt(value, now) {
  const timestamp = Date.parse(nonEmptyString(value));
  if (!Number.isFinite(timestamp)) return 'robots.checked_at must be an ISO timestamp.';
  if (timestamp > now.getTime()) return 'robots.checked_at cannot be in the future.';
  if (now.getTime() - timestamp > MAX_ROBOTS_AGE_MS) {
    return 'robots.checked_at is older than 24 hours.';
  }
  return null;
}

function normalizeSource(source, errors) {
  const sourceId = nonEmptyString(source?.id);
  const kind = nonEmptyString(source?.kind).toLowerCase();
  if (!sourceId) errors.push('source.id is required.');
  if (!['merchant_api', 'contracted_feed', 'public_crawl'].includes(kind)) {
    errors.push('source.kind must be merchant_api, contracted_feed, or public_crawl.');
  }
  if (kind === 'public_crawl') {
    if (!nonEmptyString(source?.public_crawl_policy_ref)) {
      errors.push('public_crawl source requires public_crawl_policy_ref.');
    }
  } else if (!nonEmptyString(source?.consent_ref)) {
    errors.push('merchant_api and contracted_feed sources require consent_ref.');
  }
  return { id: sourceId, kind };
}

function validateLimits(limits, errors) {
  if (Number(limits?.per_domain_concurrency) !== 1) {
    errors.push('limits.per_domain_concurrency must equal 1.');
  }
  const requests = Number(limits?.max_requests_per_domain);
  if (!Number.isInteger(requests) || requests < 1 || requests > MAX_REQUESTS_PER_DOMAIN) {
    errors.push(`limits.max_requests_per_domain must be an integer from 1 to ${MAX_REQUESTS_PER_DOMAIN}.`);
  }
  const retries = Number(limits?.max_retries);
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) {
    errors.push(`limits.max_retries must be an integer from 0 to ${MAX_RETRIES}.`);
  }
  const delay = Number(limits?.min_delay_ms);
  if (!Number.isInteger(delay) || delay < 1000) {
    errors.push('limits.min_delay_ms must be at least 1000.');
  }
  return { maxRequestsPerDomain: requests, maxRetries: retries, minDelayMs: delay };
}

function validateRobots(robots, targets, now, errors) {
  if (!robots || typeof robots !== 'object' || Array.isArray(robots)) {
    errors.push('robots must be an object keyed by target hostname.');
    return;
  }
  for (const target of targets) {
    const decision = robots[target.hostname];
    if (!decision || typeof decision !== 'object') {
      errors.push(`robots decision is required for ${target.hostname}.`);
      continue;
    }
    if (decision.allowed !== true) errors.push(`robots denies ${target.hostname}.`);
    const checkedAtError = parseCheckedAt(decision.checked_at, now);
    if (checkedAtError) errors.push(`${target.hostname}: ${checkedAtError}`);
    const robotsUrl = normalizeHttpsUrl(decision.url);
    if (robotsUrl.error || robotsUrl.url.hostname !== target.hostname || robotsUrl.url.pathname !== '/robots.txt') {
      errors.push(`${target.hostname}: robots.url must be its HTTPS /robots.txt URL.`);
    }
  }
}

function validateCrawlManifest(manifest, { now = new Date() } = {}) {
  // This is deliberately a review gate, not an authorization service. The
  // runtime executor must independently resolve source.id against the active
  // Commerce Index source registry and fetch robots.txt before any request.
  // Accepting a caller-supplied manifest must never itself authorize a crawl.
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['Manifest must be a JSON object.'], plan: null };
  }
  if (manifest.dry_run !== true) errors.push('dry_run must be exactly true; this gate never authorizes a live crawl.');
  const market = nonEmptyString(manifest.market).toUpperCase();
  if (!/^[A-Z]{2}$/.test(market)) errors.push('market must be a two-letter ISO country code.');
  const userAgent = nonEmptyString(manifest.user_agent);
  if (!userAgent.startsWith(REQUIRED_USER_AGENT_PREFIX)) {
    errors.push(`user_agent must start with ${REQUIRED_USER_AGENT_PREFIX}`);
  }
  const source = normalizeSource(manifest.source, errors);
  const limits = validateLimits(manifest.limits, errors);
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    errors.push('targets must contain at least one product URL.');
  }

  const targets = [];
  const seen = new Set();
  for (const [index, target] of (Array.isArray(manifest.targets) ? manifest.targets : []).entries()) {
    if (target?.kind !== 'product') errors.push(`targets[${index}].kind must be product.`);
    const normalized = normalizeHttpsUrl(target?.url);
    if (normalized.error) {
      errors.push(`targets[${index}]: ${normalized.error}`);
      continue;
    }
    const key = normalized.url.toString();
    if (seen.has(key)) {
      errors.push(`targets[${index}]: duplicate URL.`);
      continue;
    }
    seen.add(key);
    targets.push({ url: key, hostname: normalized.url.hostname });
  }
  validateRobots(manifest.robots, targets, now, errors);

  if (errors.length) return { ok: false, errors, plan: null };
  const byDomain = {};
  for (const target of targets) byDomain[target.hostname] = (byDomain[target.hostname] || 0) + 1;
  for (const [hostname, count] of Object.entries(byDomain)) {
    if (count > limits.maxRequestsPerDomain) {
      return { ok: false, errors: [`${hostname} exceeds limits.max_requests_per_domain.`], plan: null };
    }
  }
  return {
    ok: true,
    errors: [],
    plan: {
      dryRun: true,
      source,
      market,
      userAgent,
      limits,
      targetCount: targets.length,
      domains: Object.entries(byDomain).map(([hostname, targetCount]) => ({ hostname, targetCount })),
      targets,
    },
  };
}

module.exports = { MAX_REQUESTS_PER_DOMAIN, validateCrawlManifest };
