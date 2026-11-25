'use strict';

/**
 * THE PARTNER SANDBOX, gateway side (partner sandbox design, build steps 4 and 5 and decision 4; v0 decided
 * 25 Nov 2026). Everything the gateway does differently when `PIVOTA_ENV=sandbox` is decided here, so a reader can
 * see the whole difference in one file:
 *
 *   1. KEYS. The sandbox accepts ONLY `ak_test_<64 hex>` and refuses `ak_live_<hex>` and bare `ak_<hex>`. Every other
 *      environment keeps today's pattern exactly (and so keeps refusing `ak_test_`). `agentApiKeyFormatOk` is the one
 *      format check; src/server.js (invoke auth) and src/commerceMcpOAuth.js (api-key vs OAuth routing) both use it.
 *   2. BOOT CHECK. `assertSandboxConfig` refuses to start a sandbox revision whose settings could reach real money,
 *      prod, or a store's site. It names each offending SETTING and never prints a value. Outside the sandbox it is
 *      a no-op.
 *   3. DECISION 4. Copied catalog prices are fresh in the sandbox (`copiedPricesAreFresh`), and every MCP tool
 *      answer carries `sandbox: true` (`markSandboxToolValue` / `markSandboxToolResult`, applied once, in
 *      mcp-server/src/remoteMcpAdapter.js).
 *   4. /version adds `env: "sandbox"` (`sandboxVersionFields`).
 *
 * Env is read at call time, like src/config/platform.js. Dependency-free apart from platform.js and the AgenPas
 * config, so it can be required at the top of src/server.js before anything starts.
 */

const platform = require('./platform');

// ---------------------------------------------------------------------------------------------------------------
// 1. Key format.
// ---------------------------------------------------------------------------------------------------------------

/** Today's pattern, everywhere but the sandbox: `ak_<64 hex>` or `ak_live_<64 hex>`. Unchanged. */
const LIVE_AGENT_API_KEY_PATTERN = /^ak_(live_)?[0-9a-f]{64}$/;
/** The sandbox's only pattern: `ak_test_<64 hex>` (what the developer portal issues for the test environment). */
const SANDBOX_AGENT_API_KEY_PATTERN = /^ak_test_[0-9a-f]{64}$/;

function isSandbox(env) {
  return platform.isSandbox(env);
}

/** The agent API key pattern this environment accepts. */
function agentApiKeyPattern(env) {
  return isSandbox(env) ? SANDBOX_AGENT_API_KEY_PATTERN : LIVE_AGENT_API_KEY_PATTERN;
}

/** True when `key` has the format this environment accepts. Format only: the backend still verifies the key. */
function agentApiKeyFormatOk(key, env) {
  return typeof key === 'string' && agentApiKeyPattern(env).test(key);
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Boot check.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Hosts a sandbox must never call: the prod and staging backends and every Cloud Run service in either project.
 *   - exact hosts: the prod backend's public name, the old Railway backend, and the staging apex;
 *   - suffix: anything under the staging domain;
 *   - Cloud Run: every service in the prod or the staging GCP project. Cloud Run names a service
 *     `<svc>-<project hash>-<region>.a.run.app` or `<svc>-<project number>.<region>.run.app` (revision tags prefix
 *     `<tag>---`), so matching the PROJECT part covers every service in the project.
 *
 * THE PROJECT PARTS ARE NOT WRITTEN HERE. This repository is public, and the prod project's number and URL hash
 * have no other reason to be published. What ships is a salted scrypt digest of each (N=2^14, so guessing a
 * 12-digit project number back from its digest is impractical); a host's candidate segments are digested and
 * compared. The four digests are prod hash, prod number, staging hash, staging number, in that order. To check
 * them against the real values, run tests/partner_sandbox_config.node.test.cjs with
 * SANDBOX_REFUSED_PROJECT_PARTS_FOR_TEST=<the four values, comma-separated, in that order> (never commit them).
 */
const REFUSED_EXACT_HOSTS = Object.freeze([
  'api.pivota.cc',
  'web-production-fedb.up.railway.app',
  'staging.pivota.cc',
]);
const REFUSED_HOST_SUFFIXES = Object.freeze(['.staging.pivota.cc']);

const PROJECT_PART_SALT = 'pivota-sandbox-refused-run-app-project:v1';
const PROJECT_PART_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1 });
const SHIPPED_REFUSED_PROJECT_DIGESTS = Object.freeze([
  '18360046aac465fd0e7fe1baf8d2eab1345a8c8467ac07ce05ff735c13dac780',
  '2f81da7a12df20de3dd104111a61d74a4e327e322575351b71997b7d4d69450b',
  'd337b50182a6efebb670f013f4fc794683b5e8e7289f4a9f20c3108b5c89faff',
  '69d26bc2fd73d6ce4ccb1b9269689c4032239d599ad8b42d582f305b3f51b053',
]);
let refusedProjectDigests = new Set(SHIPPED_REFUSED_PROJECT_DIGESTS);

const digestCache = new Map();
/** The salted scrypt digest (hex) of one host segment. Cached: a boot digests each distinct segment once. */
function projectPartDigest(segment) {
  const key = String(segment);
  if (!digestCache.has(key)) {
    // eslint-disable-next-line global-require
    const digest = require('node:crypto').scryptSync(key, PROJECT_PART_SALT, 32, PROJECT_PART_SCRYPT).toString('hex');
    if (digestCache.size < 4096) digestCache.set(key, digest);
    return digest;
  }
  return digestCache.get(key);
}

/** Segments of a run.app host's first label that can be a project part: a 10-char URL hash or a project number. */
function runAppProjectCandidates(host) {
  const firstLabel = host.split('.')[0];
  return [...new Set(firstLabel.split('-').filter((seg) => /^[a-z0-9]{10}$/.test(seg) || /^\d{6,}$/.test(seg)))];
}

/** Test-only: refuse these digests instead of the shipped ones; no argument restores the shipped list. */
function setRefusedProjectDigestsForTests(digests) {
  refusedProjectDigests = new Set(digests === undefined ? SHIPPED_REFUSED_PROJECT_DIGESTS : digests);
}

function isRefusedHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return false;
  if (REFUSED_EXACT_HOSTS.includes(h)) return true;
  if (REFUSED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix))) return true;
  if (!h.endsWith('.run.app')) return false;
  return runAppProjectCandidates(h).some((seg) => refusedProjectDigests.has(projectPartDigest(seg)));
}

/** Every host-shaped token in a setting's value (the value is never returned or logged). */
function hostTokens(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/g) || [];
}

function valueNamesRefusedHost(value) {
  return hostTokens(value).some(isRefusedHost);
}

/**
 * The settings that name the backend this gateway calls. PIVOTA_API_BASE is REQUIRED (unset, the gateway calls
 * http://localhost:8080); each of the others, when set, must not name a refused host either.
 */
const REQUIRED_BACKEND_URL_SETTING = 'PIVOTA_API_BASE';
const BACKEND_URL_SETTINGS = Object.freeze([
  'PIVOTA_API_BASE',
  'AGENT_AUTH_INTROSPECT_URL',
  'GATEWAY_BACKEND_ID_TOKEN_AUDIENCE',
  'GATEWAY_BACKEND_ID_TOKEN_TARGET_ORIGIN',
  'PIVOTA_BACKEND_BASE_URL',
  'PROXY_SEARCH_AURORA_API_BASE',
  'PROXY_SEARCH_AURORA_BACKEND_BASE_URL',
]);

/**
 * LIVE READS AND STORE FETCHES that must be off. Each reader's own "off" is wider than this (an unknown value is off
 * to most of them); the boot check accepts only these spellings, so a typo fails loudly instead of reading as off.
 * `requireExplicit` is for a flag whose reader defaults ON when unset.
 */
const OFF_SPELLINGS = Object.freeze(['off', 'false', '0']);
const LIVE_READ_FLAGS = Object.freeze([
  // The gateway's own live reads of a merchant's UCP catalog (src/services/ucpLiveOfferRead.js readMode).
  { name: 'UCP_LIVE_OFFER_READ' },
  { name: 'UCP_LIVE_SEARCH_READ' },
  { name: 'UCP_LIVE_PRODUCT_READ' },
  { name: 'UCP_LIVE_PDP_READ' },
  // get_offers' cart for a live-verified stale offer (src/services/offerLiveVerification.js liveCartMode).
  { name: 'GET_OFFERS_LIVE_CART' },
  // Search's live merchant price overlay (src/server.js, parseBooleanEnv default false).
  { name: 'SERVE_LIVE_MERCHANT_PRICE' },
  // Cafe24 Global Catalog search lane (src/services/cafe24GlobalCatalog.js readMode).
  { name: 'CAFE24_CATALOG_SEARCH' },
  // Checkout-intake variant lookup at the merchant's own endpoint (src/server.js isMerchantVariantSourcingEnabled).
  { name: 'MERCHANT_VARIANT_SOURCING_ENABLED' },
  // PDP identity graph's live promotion (src/services/pdpIdentityGraph.js).
  { name: 'PDP_IDENTITY_GRAPH_AUTO_ENABLE_LIVE' },
  // Image cache: fetches store image URLs. The job runner defaults ON, so it must be set off explicitly.
  { name: 'CATALOG_IMAGE_CACHE_BOOTSTRAP_ENABLED' },
  { name: 'CATALOG_IMAGE_CACHE_JOB_RUNNER_ENABLED', requireExplicit: true },
]);

/** The gateway's own service keys (src/server.js AGENT_AUTH_*_KEYS): none may be a live-format key here. */
const SERVICE_KEY_SETTINGS = Object.freeze([
  'PIVOTA_API_KEY',
  'AGENT_API_KEY',
  'SHOP_GATEWAY_AGENT_API_KEY',
  'CREATOR_INVOKE_API_KEY',
  'PIVOTA_BACKEND_AGENT_API_KEY',
  'PIVOTA_AGENT_API_KEY',
  'AGENT_AUTH_EMERGENCY_API_KEY',
  'AGENT_AUTH_EMERGENCY_FALLBACK_KEYS',
]);

const A2A_RAIL_PREFIX = 'A2A_RAIL_';

function str(v) {
  return v == null ? '' : String(v).trim();
}

function flagIsOff(env, { name, requireExplicit = false }) {
  const v = str(env[name]).toLowerCase();
  if (!v) return !requireExplicit;
  return OFF_SPELLINGS.includes(v);
}

/**
 * Every refusal for this environment, as `SETTING(reason)` strings: names only, never a value. Empty outside the
 * sandbox and for a sandbox that is safe to serve.
 */
function sandboxConfigProblems(env = process.env) {
  const e = env && typeof env === 'object' ? env : process.env;
  if (!platform.namesSandbox(e)) return [];
  const problems = [];

  // A sandbox label beside a production signal: every guard would see production, the key check would see
  // production keys. Refuse instead of serving that mixture.
  if (platform.isProduction(e)) {
    for (const key of platform.ENV_NAME_SOURCES) {
      if (platform.normalizeEnvName(e[key]) === platform.PLATFORM_ENVS.PRODUCTION) problems.push(`${key}(names production)`);
    }
    if (!problems.length) problems.push('PIVOTA_ENV(production signal)');
  }

  // Under a test runtime the invoke route can bypass API-key auth (src/server.js shouldBypassInvokeAuthForTest).
  if (str(e.NODE_ENV).toLowerCase() === 'test') problems.push('NODE_ENV(test disables auth)');
  if (str(e.JEST_WORKER_ID)) problems.push('JEST_WORKER_ID(test disables auth)');

  // Rails: Reap only. AgenPas drops `reap` and falls back to a2a unless consent is on (src/agenpas/config.js), so
  // the raw value alone is not enough: the rails the page would actually mint must be exactly ['reap'].
  if (str(e.AGENPAS_RAILS) !== 'reap') {
    problems.push('AGENPAS_RAILS(must be exactly reap)');
  } else {
    // eslint-disable-next-line global-require
    const minted = require('../agenpas/config').rails(e, () => {});
    if (!(minted.length === 1 && minted[0] === 'reap')) problems.push('AGENPAS_CONSENT_ENABLED(must be on for the reap rail)');
  }
  for (const key of Object.keys(e).sort()) {
    if (key.startsWith(A2A_RAIL_PREFIX)) problems.push(`${key}(no A2A rail setting may be set)`);
  }

  // The backend.
  if (!str(e[REQUIRED_BACKEND_URL_SETTING])) {
    problems.push(`${REQUIRED_BACKEND_URL_SETTING}(must be set)`);
  } else {
    try {
      // eslint-disable-next-line no-new
      new URL(str(e[REQUIRED_BACKEND_URL_SETTING]));
    } catch {
      problems.push(`${REQUIRED_BACKEND_URL_SETTING}(not a URL)`);
    }
  }
  const named = new Set();
  for (const key of BACKEND_URL_SETTINGS) {
    if (valueNamesRefusedHost(e[key])) {
      problems.push(`${key}(prod or staging host)`);
      named.add(key);
    }
  }
  // Any other setting that names a prod or staging backend / Cloud Run service.
  for (const key of Object.keys(e).sort()) {
    if (named.has(key)) continue;
    if (valueNamesRefusedHost(e[key])) problems.push(`${key}(prod or staging host)`);
  }

  // Live reads and store fetches.
  for (const flag of LIVE_READ_FLAGS) {
    if (!flagIsOff(e, flag)) problems.push(`${flag.name}(must be off${flag.requireExplicit ? ', set explicitly' : ''})`);
  }

  // The gateway's own keys.
  for (const key of SERVICE_KEY_SETTINGS) {
    const entries = str(e[key]).split(',').map((s) => s.trim()).filter(Boolean);
    if (entries.some((k) => LIVE_AGENT_API_KEY_PATTERN.test(k))) problems.push(`${key}(live-format key)`);
  }

  return problems;
}

/**
 * Boot-time refusal. Outside the sandbox: returns `{ sandbox: false }` and does nothing else. In the sandbox:
 * throws `SANDBOX_CONFIG_REFUSED: <SETTING(reason)>, ...` when anything above is wrong, else `{ sandbox: true }`.
 */
function assertSandboxConfig(env = process.env) {
  if (!platform.namesSandbox(env)) return { sandbox: false };
  const problems = sandboxConfigProblems(env);
  if (problems.length) {
    throw new Error(`SANDBOX_CONFIG_REFUSED: ${problems.join(', ')}`);
  }
  return { sandbox: true };
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Decision 4.
// ---------------------------------------------------------------------------------------------------------------

/**
 * In the sandbox a copied catalog price is fresh: its age (or a missing read date, the copy carries prod's) never
 * makes it `price_stale`. What still makes an offer stale there is not age: a seed held for live verification
 * (`requires_live_verification`, it has no cart) and a live read that found the market unpriced.
 */
function copiedPricesAreFresh(env) {
  return isSandbox(env);
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = Object.getPrototypeOf(value);
  return p === Object.prototype || p === null;
}

/** A tool's answer with a top-level `sandbox: true`, when it is a plain object (else unchanged). Never mutates. */
function markSandboxToolValue(value) {
  return isPlainObject(value) ? { ...value, sandbox: true } : value;
}

/**
 * An MCP tool result marked for the sandbox: `_meta.sandbox: true` on every result (answers and errors alike), and
 * `structuredContent.sandbox: true` where the result has structured content. Never mutates.
 */
function markSandboxToolResult(result) {
  if (!isPlainObject(result)) return result;
  const out = { ...result, _meta: { ...(isPlainObject(result._meta) ? result._meta : {}), sandbox: true } };
  if (isPlainObject(result.structuredContent)) out.structuredContent = { ...result.structuredContent, sandbox: true };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 4. /version.
// ---------------------------------------------------------------------------------------------------------------

/** Extra /version fields: `{ env: 'sandbox' }` in the sandbox, nothing anywhere else (byte-identical). */
function sandboxVersionFields(env) {
  return isSandbox(env) ? { env: platform.PLATFORM_ENVS.SANDBOX } : {};
}

module.exports = {
  LIVE_AGENT_API_KEY_PATTERN,
  SANDBOX_AGENT_API_KEY_PATTERN,
  BACKEND_URL_SETTINGS,
  LIVE_READ_FLAGS,
  OFF_SPELLINGS,
  SERVICE_KEY_SETTINGS,
  isSandbox,
  agentApiKeyPattern,
  agentApiKeyFormatOk,
  isRefusedHost,
  projectPartDigest,
  setRefusedProjectDigestsForTests,
  SHIPPED_REFUSED_PROJECT_DIGESTS,
  sandboxConfigProblems,
  assertSandboxConfig,
  copiedPricesAreFresh,
  markSandboxToolValue,
  markSandboxToolResult,
  sandboxVersionFields,
};
