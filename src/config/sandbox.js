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
 *      prod, or a store's site, or let the server run its own DB migrations. Two layers: a DENY list (prod and staging
 *      backends and Cloud Run projects, by digest) and an ALLOW list (every run.app host in the sandbox backend's own
 *      project; brand-zone hosts sandbox-labelled; database and Redis private; GOOGLE_CLOUD_PROJECT a sandbox-shaped
 *      project id). Outside run.app and the brand zones it is still a deny list (IPv6 or public IPs, other clouds' hosts,
 *      percent-encoded dots are not refused). The real second sandbox signal is the deploy's own read-back (sandbox
 *      infra), not GOOGLE_CLOUD_PROJECT: a copied PIVOTA_ENV=production skips this check entirely. The Aurora BFF is not loaded in the sandbox at all (src/server.js), which also keeps out its first-use DDL
 *      (recoRecallPoolCache, recoLabelSuggestionStore) and its prod-defaulting backfills. It names each offending SETTING and never prints a value. Outside the sandbox it is
 *      a no-op.
 *   3. DECISION 4. Copied catalog prices are fresh in the sandbox (`copiedPricesAreFresh`), and every MCP tool
 *      answer carries `sandbox: true` (`markSandboxToolValue` / `markSandboxToolResult`, applied once, in
 *      mcp-server/src/remoteMcpAdapter.js).
 *   (/version reports the env label in every environment; src/server.js reads it from platform.js.)
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
  // Never in a deploy: a caller there could otherwise swap the refused projects for none.
  if (!platform.isTestRuntime()) throw new Error('setRefusedProjectDigestsForTests is test-only');
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

// ---------------------------------------------------------------------------------------------------------------
// The ALLOW-LIST rules (pre-deploy hardening). The deny list above names what a sandbox must never call; these say
// what it MAY call, so a prod host nobody thought to list is still refused.
//   - Cloud Run: every *.run.app host in any setting must be in the SAME project as PIVOTA_API_BASE (the sandbox's
//     own backend), by the project part of its name. If PIVOTA_API_BASE is not a run.app host, no run.app host is
//     allowed at all.
//   - Brand zones: a host under pivota.cc, agenpaz.com, agenpas.com or reap.global must have a label containing
//     "sandbox" (sandbox.mcp.pivota.cc, sandbox.agenpaz.com, sandbox.api.reap.global). The same rule the sandbox
//     backend applies (pivota-backend config/sandbox_guard.py).
//   - No Railway host, no prod or staging GCP project name, no prod or staging database / Redis private IP.
//   - The database and Redis are private: a private IP that is not prod's or staging's, or a Cloud SQL socket in
//     the sandbox's own project (GOOGLE_CLOUD_PROJECT).
// ---------------------------------------------------------------------------------------------------------------

/** The project part of a Cloud Run host: the URL hash of `<svc>-<hash>-<region>.a.run.app`, the number of
 *  `<svc>-<number>.<region>.run.app` (revision tags `<tag>---` included), or null when the host is neither. */
function runAppProjectPart(host) {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '');
  const hashForm = /^(?:[a-z0-9-]+-)?([a-z0-9]{10})-[a-z0-9]+\.a\.run\.app$/.exec(h);
  if (hashForm) return hashForm[1];
  const numberForm = /^(?:[a-z0-9-]+-)?(\d{6,})\.[a-z0-9-]+\.run\.app$/.exec(h);
  return numberForm ? numberForm[1] : null;
}

const GUARDED_ZONES = Object.freeze(['pivota.cc', 'agenpaz.com', 'agenpas.com', 'reap.global']);
const RAILWAY_ZONES = Object.freeze(['railway.app', 'railway.internal', 'rlwy.net']);
const PROD_PROJECT_NAME_RE = /(?<![a-z0-9])(pivota-prod|pivota-staging)(?![a-z0-9])/;
// Prod's Cloud SQL and Redis and staging's Cloud SQL private IPs, as salted scrypt digests (projectPartDigest), NOT
// written here: this repository is public. Order: prod SQL, prod Redis, staging SQL. Check them against the real values
// locally with SANDBOX_REFUSED_IPS_FOR_TEST=<the three, comma-separated, in that order> (never commit them).
const SHIPPED_REFUSED_IP_DIGESTS = Object.freeze([
  '7970f70f6165b83240176d7802b643a3c768365ef97480f065fbe6268c7a0e11',
  '6a7f1d6f721400d55ed674780f99dcd92000505ad37cf6f810e8596d5ec2bfd8',
  'd65e24ac6add865bc3916a9c42095adbef809a0f9451a23913fd01d61fac1c09',
]);
let refusedIpDigests = new Set(SHIPPED_REFUSED_IP_DIGESTS);
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Test-only: refuse these IP digests instead of the shipped ones; no argument restores the shipped list. */
function setRefusedIpDigestsForTests(digests) {
  if (!platform.isTestRuntime()) throw new Error('setRefusedIpDigestsForTests is test-only');
  refusedIpDigests = new Set(digests === undefined ? SHIPPED_REFUSED_IP_DIGESTS : digests);
}

function isRefusedIp(token) {
  return IPV4_RE.test(token) && refusedIpDigests.has(projectPartDigest(token));
}

/** Settings exempt from the brand-zone rule, with the only values allowed: display-only link hosts nothing fetches
 *  (the AgenPas terms / privacy links point at the real legal pages). Anything else in them is still refused. */
const DISPLAY_ONLY_HOST_SETTINGS = Object.freeze({ AGENPAS_LEGAL_HOSTS: Object.freeze(['pivota.cc', 'merchant.pivota.cc']) });

function inZone(host, zones) {
  return zones.find((z) => host === z || host.endsWith(`.${z}`)) || null;
}

/** A brand-zone host is a sandbox host when one of its labels IS `sandbox` or starts with `sandbox-`
 *  (sandbox.mcp.pivota.cc, sandbox-api.pivota.cc), never by substring (nosandbox.pivota.cc is not). */
function isSandboxBrandHost(host, zone) {
  const labels = host === zone ? [] : host.slice(0, -(zone.length + 1)).split('.');
  return labels.some((label) => label === 'sandbox' || label.startsWith('sandbox-'));
}

/** Why `value` (of setting `key`) names something outside the sandbox, or null. Never quotes the value. */
function allowListProblem(key, value, ownProjectPart) {
  const low = String(value == null ? '' : value).toLowerCase();
  if (!low) return null;
  if (PROD_PROJECT_NAME_RE.test(low)) return 'names a prod or staging GCP project';
  const exempt = DISPLAY_ONLY_HOST_SETTINGS[key];
  for (const raw of hostTokens(low)) {
    const host = raw.replace(/\.+$/, '');
    if (isRefusedIp(host)) return 'names a prod or staging database/Redis address';
    if (!host.includes('.')) continue;
    if (inZone(host, RAILWAY_ZONES)) return 'names a Railway host';
    const zone = inZone(host, GUARDED_ZONES);
    if (zone && !isSandboxBrandHost(host, zone) && !(exempt && exempt.includes(host))) return `names a non-sandbox ${zone} host`;
    if (host.endsWith('.run.app')) {
      const part = runAppProjectPart(host);
      if (!ownProjectPart || part !== ownProjectPart) return 'names a Cloud Run host outside the sandbox project';
    }
  }
  return null;
}

const PRIVATE_IP_RE = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/;

/** A database / Redis endpoint is allowed only as a private IP or a Cloud SQL socket in the sandbox's project. */
function privateEndpointProblem(host, sandboxProject) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return 'no host';
  if (h.startsWith('/')) {
    // Exactly /cloudsql/<project>:<region>:<instance>; no other path, no `..`.
    const socket = /^\/cloudsql\/([a-z][a-z0-9-]*):[a-z0-9-]+:[a-z0-9-]+$/.exec(h);
    if (!socket) return 'not a Cloud SQL socket path';
    return sandboxProject && socket[1] === sandboxProject ? null : 'Cloud SQL socket outside the sandbox project';
  }
  return PRIVATE_IP_RE.test(h) ? null : 'not a private address';
}

let pgConnectionString = null;
function parsePgUrl(raw) {
  if (pgConnectionString === null) {
    // eslint-disable-next-line global-require
    const path = require('node:path');
    // The copy pg itself uses (src/db/index.js resolves it the same way).
    // eslint-disable-next-line global-require
    const mod = require(require.resolve('pg-connection-string', { paths: [path.dirname(require.resolve('pg'))] }));
    pgConnectionString = typeof mod.parse === 'function' ? mod.parse : mod;
  }
  return pgConnectionString(raw);
}

/** EVERY host a postgres / redis URL could connect to: the authority's host, each `host=` parameter (libpq and
 *  pg-connection-string disagree on which one wins when there are several), and what pg-connection-string itself
 *  resolves. Null when the URL cannot be parsed at all (refused). */
function urlConnectHosts(raw) {
  const s = String(raw).trim();
  const hosts = new Set();
  let u = null;
  try {
    u = new URL(s);
  } catch {
    u = null;
  }
  if (u) {
    if (u.hostname) hosts.add(u.hostname);
    for (const h of u.searchParams.getAll('host')) hosts.add(h);
  } else {
    // Not a WHATWG URL (the standard socket form `postgresql://u:p@/db?host=/cloudsql/...` has credentials and no
    // host): read the authority's host and every host= parameter by hand.
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/:?#]*)/i.exec(s);
    if (!m) return null;
    if (m[1]) hosts.add(m[1]);
    const q = s.indexOf('?');
    if (q >= 0) for (const h of new URLSearchParams(s.slice(q + 1).split('#')[0]).getAll('host')) hosts.add(h);
  }
  try {
    const parsed = parsePgUrl(s);
    if (parsed && parsed.host) hosts.add(String(parsed.host));
  } catch {
    return null;
  }
  return [...hosts].map((h) => h.trim()).filter(Boolean);
}

/** The hostname of an http(s) URL, or ''. */
function httpUrlHost(raw) {
  try {
    return new URL(String(raw).trim()).hostname;
  } catch {
    return '';
  }
}

const GCP_PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const ENVIRONMENT_WORDS = Object.freeze(['prod', 'production', 'staging', 'stage', 'stg', 'shared']);

/** Why GOOGLE_CLOUD_PROJECT is not a sandbox project id, or null. Not hard-coded: the sandbox project's id is chosen
 *  at creation; this asks only that it be a valid id with no environment word in it. */
function sandboxProjectProblem(id) {
  const v = String(id || '').trim();
  if (!v) return 'must be set';
  if (!GCP_PROJECT_ID_RE.test(v)) return 'not a GCP project id';
  if (v.split('-').some((w) => ENVIRONMENT_WORDS.includes(w))) return 'names another environment';
  return null;
}

/** Settings that name a GCP project the gateway talks to: each, when set, must be the sandbox's own project. */
const PROJECT_SETTINGS = Object.freeze(['PRICE_CACHE_FIRESTORE_PROJECT', 'PIVOTA_AGENT_CENTER_GEMINI_VERTEX_PROJECT']);

/** An LLM provider credential setting, by name: <...>_<PROVIDER>[_...]_(API_KEY|KEY|TOKEN|API_TOKEN|SECRET), plus
 *  GOOGLE_API_KEY. Today that is GEMINI_API_KEY, PIVOTA_GEMINI_API_KEY, FALLBACK_GEMINI_API_KEY, GOOGLE_API_KEY,
 *  OPENAI_API_KEY, ANTHROPIC_API_KEY, LLM_API_KEY and AURORA_{DIAG,RECO,SKIN,TRAVEL,VISION}_GEMINI_API_KEY. Not
 *  LLM_KILL_SWITCH, GEMINI_JSON_TIMEOUT or *_MAX_OUTPUT_TOKENS (they hold no credential). */
const LLM_KEY_SETTING_RE = /^(?:[A-Z0-9_]*_)?(?:GEMINI|OPENAI|ANTHROPIC|CLAUDE|LLM|GENAI|OPENROUTER|DASHSCOPE|DEEPSEEK|MISTRAL|COHERE|GROQ|PERPLEXITY|XAI)(?:_[A-Z0-9]+)*_(?:API_KEY|KEY|TOKEN|SECRET|API_TOKEN)$|^GOOGLE_API_KEY$/;

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
  // platform.isTestRuntime also answers true on NODE_TEST_CONTEXT (set by `node --test`).
  if (str(e.NODE_TEST_CONTEXT)) problems.push('NODE_TEST_CONTEXT(test runtime)');

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

  // The allow list, over every setting (one problem per setting; the deny-list hit above already names it).
  const ownProjectPart = runAppProjectPart(httpUrlHost(e[REQUIRED_BACKEND_URL_SETTING]));
  const apiHost = httpUrlHost(e[REQUIRED_BACKEND_URL_SETTING]).toLowerCase();
  if (apiHost && !ownProjectPart && !(inZone(apiHost, GUARDED_ZONES) && isSandboxBrandHost(apiHost, inZone(apiHost, GUARDED_ZONES)))) {
    problems.push(`${REQUIRED_BACKEND_URL_SETTING}(must be the sandbox backend: a run.app host or a sandbox host)`);
  }
  const denied = new Set(problems.map((p) => p.slice(0, p.indexOf('('))));
  for (const key of Object.keys(e).sort()) {
    if (denied.has(key)) continue;
    const why = allowListProblem(key, e[key], ownProjectPart);
    if (why) problems.push(`${key}(${why})`);
  }

  // The project this revision runs in (set from one source by the sandbox deploy). A sandbox-SHAPED id only: it does not
  // by itself prove the sandbox; the deploy's own read-back does (sandbox infra).
  const projectWhy = sandboxProjectProblem(e.GOOGLE_CLOUD_PROJECT);
  if (projectWhy) problems.push(`GOOGLE_CLOUD_PROJECT(${projectWhy})`);
  const sandboxProject = projectWhy ? null : str(e.GOOGLE_CLOUD_PROJECT);
  for (const key of PROJECT_SETTINGS) {
    if (str(e[key]) && str(e[key]) !== sandboxProject) problems.push(`${key}(must be the sandbox project)`);
  }

  // The database and Redis: private, and in the sandbox's own project.
  for (const key of ['DATABASE_URL', 'REDIS_URL']) {
    if (!str(e[key])) continue;
    const hosts = urlConnectHosts(e[key]);
    if (hosts === null) {
      problems.push(`${key}(not a parsable URL)`);
      continue;
    }
    const why = hosts.length === 0 ? 'no host' : hosts.map((h) => privateEndpointProblem(h, sandboxProject)).find(Boolean);
    if (why) problems.push(`${key}(${why})`);
  }
  for (const key of ['PGHOST', 'REDIS_HOST']) {
    if (!str(e[key])) continue;
    const why = privateEndpointProblem(e[key], sandboxProject);
    if (why) problems.push(`${key}(${why})`);
  }

  // The Aurora BFF is not loaded in the sandbox (src/server.js), so a fail-closed switch for it would refuse the
  // boot later with a less useful message: refuse it here, by name.
  for (const key of ['AURORA_ROUTES_FAIL_CLOSED', 'AURORA_BFF_FAIL_CLOSED']) {
    if (['1', 'true', 'yes', 'y', 'on'].includes(str(e[key]).toLowerCase())) problems.push(`${key}(the Aurora BFF is not loaded in the sandbox)`);
  }

  // LEXICAL-ONLY (sandbox plan Q7): no Vertex/Gemini call from the sandbox. GOOGLE_CLOUD_PROJECT is the sandbox signal
  // there, and its only gateway reader is the Vertex client (src/llm/vertexGemini.js), which would then bill and call
  // in the sandbox project. VERTEX_AI_ENABLED is refused in ANY truthy spelling (the reader takes only 'true', so
  // this is stricter), and the LLM kill switch must be exactly 'true'.
  if (['1', 'true', 'yes', 'y', 'on'].includes(str(e.VERTEX_AI_ENABLED).toLowerCase())) problems.push('VERTEX_AI_ENABLED(must be off in the sandbox)');
  if (e.LLM_KILL_SWITCH !== 'true') problems.push('LLM_KILL_SWITCH(must be exactly true in the sandbox)');
  // ...and no LLM provider key may even be PRESENT (empty included), so no non-Vertex path (an API-key Gemini,
  // OpenAI or Anthropic client) has a credential to call with. Matched by NAME, so a key added later is caught too.
  for (const key of Object.keys(e).sort()) {
    if (LLM_KEY_SETTING_RE.test(key)) problems.push(`${key}(no LLM key may be set in the sandbox)`);
  }

  // Live reads and store fetches.
  for (const flag of LIVE_READ_FLAGS) {
    if (!flagIsOff(e, flag)) problems.push(`${flag.name}(must be off${flag.requireExplicit ? ', set explicitly' : ''})`);
  }

  // The gateway's own DB migrations (src/db/migrations, ledger schema_migrations) are applied in the sandbox by
  // ONE deliberate run (`node src/db/cli.js migrate`, which never loads this file), never by the server: not at
  // boot (src/server.js runs them unless DB_AUTO_MIGRATE is 'false') and not on a request. Four modules call
  // runMigrations() on first use unless SKIP_DB_MIGRATIONS is exactly 'true' (taxonomyStore, telemetry
  // outcomeStore, layer1 compatibilitySamplesUS and layer1BundleSamplesUS), and their routes are public, so any
  // caller could otherwise start a full migration run. Both spellings below are exactly what those readers test.
  if (e.SKIP_DB_MIGRATIONS !== 'true') problems.push('SKIP_DB_MIGRATIONS(must be exactly true)');
  if (String(e.DB_AUTO_MIGRATE || '').toLowerCase() !== 'false') problems.push('DB_AUTO_MIGRATE(must be false)');

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

/**
 * A JSON body from an MCP door or the REST invoke route, marked for the sandbox (never mutated):
 *   - a JSON-RPC result: `_meta.sandbox` (and `structuredContent.sandbox`), as markSandboxToolResult;
 *   - a JSON-RPC error: `error.data.sandbox: true` (the spec's place for extra error information);
 *   - any other plain object (an invoke answer, a 401/429/503 body): a top-level `sandbox: true`;
 *   - a JSON-RPC batch: each member.
 */
function markSandboxResponseBody(body) {
  if (Array.isArray(body)) return body.map((member) => (isPlainObject(member) && member.jsonrpc === '2.0' ? markSandboxResponseBody(member) : member));
  if (!isPlainObject(body)) return body;
  if (body.jsonrpc === '2.0') {
    if (isPlainObject(body.result)) return { ...body, result: markSandboxToolResult(body.result) };
    if (isPlainObject(body.error)) {
      const data = isPlainObject(body.error.data) ? body.error.data : {};
      return { ...body, error: { ...body.error, data: { ...data, sandbox: true } } };
    }
    return body;
  }
  return { ...body, sandbox: true };
}

/** An adapter outcome `{ status, headers, body }` with its body marked, in the sandbox only (else the same object). */
function markSandboxRpcOutcome(out, env) {
  if (!isSandbox(env) || !out || typeof out !== 'object') return out;
  return { ...out, body: markSandboxResponseBody(out.body) };
}

/** A JSON-RPC body the server writes itself (the heartbeat's error), marked in the sandbox only. */
function markSandboxRpcBody(body, env) {
  return isSandbox(env) ? markSandboxResponseBody(body) : body;
}

/**
 * THE ONE EXPRESS MIDDLEWARE for the sandbox's response marks (mounted first in src/server.js). Outside the sandbox
 * it calls next() and does nothing else. In the sandbox: every response carries `X-Pivota-Env: sandbox`, and on a
 * path `isMarkedPath(req)` names (the MCP doors and the REST invoke route) every `res.json` body is marked by
 * markSandboxResponseBody, whichever handler sends it: tool results, tool refusals that never reach the adapter,
 * JSON-RPC errors and HTTP error bodies alike. Bodies the heartbeat writes raw are marked at their two call sites.
 */
function sandboxResponseMarks(isMarkedPath) {
  return function sandboxResponseMarksMiddleware(req, res, next) {
    if (!isSandbox()) return next();
    res.setHeader('X-Pivota-Env', platform.PLATFORM_ENVS.SANDBOX);
    if (typeof isMarkedPath === 'function' && isMarkedPath(req)) {
      const json = res.json.bind(res);
      res.json = (body) => json(markSandboxResponseBody(body));
    }
    return next();
  };
}

/** The paths whose JSON bodies the sandbox marks: the MCP doors and the REST invoke routes. Normalized the way Express
 *  routes them (case-insensitive, trailing slashes ignored), so /MCP and /agent/shop/v1/invoke/ are marked too. */
const SANDBOX_MARKED_PATHS = Object.freeze(['/mcp', '/ucp/mcp', '/agent/shop/v1/invoke', '/agent/creator/v1/invoke']);
function isSandboxMarkedPath(path) {
  return SANDBOX_MARKED_PATHS.includes(String(path || '').toLowerCase().replace(/\/+$/, ''));
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
  SHIPPED_REFUSED_IP_DIGESTS,
  setRefusedIpDigestsForTests,
  sandboxConfigProblems,
  assertSandboxConfig,
  copiedPricesAreFresh,
  markSandboxToolValue,
  markSandboxToolResult,
  markSandboxResponseBody,
  markSandboxRpcOutcome,
  markSandboxRpcBody,
  sandboxResponseMarks,
  isSandboxMarkedPath,
  SANDBOX_MARKED_PATHS,
  runAppProjectPart,
  sandboxProjectProblem,
  LLM_KEY_SETTING_RE,
};
