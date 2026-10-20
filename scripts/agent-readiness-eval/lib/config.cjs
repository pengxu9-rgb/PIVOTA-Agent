'use strict';

// Configuration for the partner-simulator readiness eval.
//
// Everything that decides WHERE the harness points and HOW HARD it pushes is read here, once, from flags
// and env (flags win). The harness is target-agnostic: a base URL + an MCP path + an auth mode + a tier.
// What it is NOT allowed to point at is decided in ./safety.cjs, never here, so a config bug cannot widen
// the blast radius.

const os = require('node:os');
const path = require('node:path');

const TIERS = Object.freeze({
  // The auth:none read tier (four read tools, projected shapes, structuredContent).
  public: { path: '/public/mcp', defaultAuth: 'none' },
  // The authenticated commerce door (API key or OAuth bearer).
  commerce: { path: '/mcp', defaultAuth: 'api_key' },
});

const AUTH_MODES = Object.freeze(['none', 'api_key', 'bearer']);
// 'prod-synthetic' is deliberately absent: no server-side synthetic-traffic designation exists (see safety.cjs).
const TARGET_KINDS = Object.freeze(['local', 'prod-clone']);

// SLO defaults. Every one is overridable with --slo key=value (or READINESS_EVAL_SLO_<KEY>).
const DEFAULT_SLOS = Object.freeze({
  availability_min: 0.995,
  tool_error_rate_max: 0.01,
  search_p95_ms_max: 3000,
  in_catalog_zero_result_rate_max: 0.1,
  relevance_pass_rate_min: 0.9,
  currency_market_mismatch_max: 0,
  missing_price_max: 0,
  missing_link_max: 0,
  // Not in the original brief; reported and gated, but set to null to make it informational only.
  negative_control_pass_rate_min: 0.9,
  duplicate_query_rate_max: 0.05,
  consistency_stable_rate_min: 0.9,
  offer_search_price_agreement_min: 0.9,
  chain_resolve_rate_min: 0.98,
});

const DEFAULTS = Object.freeze({
  tier: 'public',
  targetKind: 'local',
  timeoutMs: 30000,
  // Discovery is paced, not a load test: one call at a time unless --concurrency says otherwise.
  concurrency: 1,
  pacingMs: 250,
  pageSize: 10,
  relevanceTopK: 5,
  relevanceQueryPassThreshold: 0.6,
  followTop: 2,
  followSample: 1,
  consistencySample: 20,
  consistencyRepeats: 2,
  priceAgreementTolerance: 0.05,
  journeys: ['discovery', 'follow', 'recommend', 'consistency'],
  limit: 0,
  seed: 20261020,
  syntheticHeader: 'X-Pivota-Synthetic-Traffic',
  syntheticHeaderValue: 'readiness-eval',
  clientName: 'pivota-readiness-eval',
  clientVersion: '1.0.0',
  protocolVersion: '2025-06-18',
});

// Load mode defaults: OFF, and modest when on. Hard caps live in safety.cjs and cannot be raised by config.
const LOAD_DEFAULTS = Object.freeze({
  enabled: false,
  rpsStart: 0.5,
  rpsEnd: 2,
  rampSeconds: 60,
  holdSeconds: 60,
  maxConcurrency: 4,
  maxRequests: 500,
  tools: ['search_catalog'],
  breakerWindow: 50,
  breakerErrorRate: 0.5,
});

// Flags that once existed and must now be a hard error, never silently ignored: a Host header override is a
// way to address one vhost through another's address, and the remote/synthetic switches are replaced by the
// compiled-in allowlist.
const REMOVED_FLAGS = Object.freeze(['host-header', 'allow-remote-target', 'synthetic-flag-ack', 'allow-remote']);

function parseArgv(argv) {
  const out = { _: [], slo: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    let key;
    let val;
    if (eq > -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        val = next;
        i += 1;
      } else {
        val = true;
      }
    }
    if (key === 'slo') {
      const [k, v] = String(val).split('=');
      out.slo[k] = v;
    } else {
      out[key] = val;
    }
  }
  return out;
}

function num(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  if (v === true) return true;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function list(v, fallback) {
  if (v === undefined || v === null || v === '' || v === true) return fallback;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Build the resolved config. Pure: (argv, env) in, plain object out. Secrets are kept in `secrets` and
 * never appear in anything the report serializes (see redactConfig).
 */
function resolveConfig(argv = [], env = process.env) {
  const f = parseArgv(argv);
  const pick = (flag, envKey) => (f[flag] !== undefined ? f[flag] : env[envKey]);

  const tier = String(pick('tier', 'READINESS_EVAL_TIER') || DEFAULTS.tier).trim();
  const tierDef = TIERS[tier];
  const auth = String(pick('auth', 'READINESS_EVAL_AUTH') || (tierDef ? tierDef.defaultAuth : 'none')).trim();
  const baseUrl = String(pick('base-url', 'READINESS_EVAL_BASE_URL') || '').trim().replace(/\/+$/, '');
  const mcpPath = String(pick('mcp-path', 'READINESS_EVAL_MCP_PATH') || (tierDef ? tierDef.path : '/mcp')).trim();

  const slos = { ...DEFAULT_SLOS };
  for (const key of Object.keys(DEFAULT_SLOS)) {
    const envVal = env[`READINESS_EVAL_SLO_${key.toUpperCase()}`];
    const raw = f.slo[key] !== undefined ? f.slo[key] : envVal;
    if (raw === undefined) continue;
    slos[key] = raw === 'null' || raw === 'off' ? null : num(raw, slos[key]);
  }
  const unknownSlos = Object.keys(f.slo).filter((k) => !(k in DEFAULT_SLOS));

  const callerKeys = list(pick('caller-keys', 'READINESS_EVAL_CALLER_KEYS'), []);

  const outDir = String(
    // Default OUTSIDE the repo: results carry measured metrics, and this repository is public.
    pick('out', 'READINESS_EVAL_OUT_DIR') || path.join(os.tmpdir(), 'pivota-readiness-eval', timestampSlug()),
  );

  const config = {
    mode: f['dry-run'] || bool(env.READINESS_EVAL_DRY_RUN) ? 'dry-run' : 'run',
    tier,
    auth,
    baseUrl,
    mcpPath,
    endpoint: baseUrl ? `${baseUrl}${mcpPath.startsWith('/') ? '' : '/'}${mcpPath}` : '',
    targetKind: String(pick('target-kind', 'READINESS_EVAL_TARGET_KIND') || DEFAULTS.targetKind).trim(),
    // Fixed, not configurable: a configurable header NAME is a way to smuggle a Host (or auth) header.
    syntheticHeader: DEFAULTS.syntheticHeader,
    syntheticHeaderValue: DEFAULTS.syntheticHeaderValue,
    timeoutMs: num(pick('timeout-ms', 'READINESS_EVAL_TIMEOUT_MS'), DEFAULTS.timeoutMs),
    concurrency: num(pick('concurrency', 'READINESS_EVAL_CONCURRENCY'), DEFAULTS.concurrency),
    pacingMs: num(pick('pacing-ms', 'READINESS_EVAL_PACING_MS'), DEFAULTS.pacingMs),
    pageSize: num(pick('page-size', 'READINESS_EVAL_PAGE_SIZE'), DEFAULTS.pageSize),
    relevanceTopK: num(pick('top-k', 'READINESS_EVAL_TOP_K'), DEFAULTS.relevanceTopK),
    relevanceQueryPassThreshold: num(pick('query-pass-threshold', 'READINESS_EVAL_QUERY_PASS_THRESHOLD'), DEFAULTS.relevanceQueryPassThreshold),
    followTop: num(pick('follow-top', 'READINESS_EVAL_FOLLOW_TOP'), DEFAULTS.followTop),
    followSample: num(pick('follow-sample', 'READINESS_EVAL_FOLLOW_SAMPLE'), DEFAULTS.followSample),
    consistencySample: num(pick('consistency-sample', 'READINESS_EVAL_CONSISTENCY_SAMPLE'), DEFAULTS.consistencySample),
    consistencyRepeats: num(pick('consistency-repeats', 'READINESS_EVAL_CONSISTENCY_REPEATS'), DEFAULTS.consistencyRepeats),
    priceAgreementTolerance: num(pick('price-tolerance', 'READINESS_EVAL_PRICE_TOLERANCE'), DEFAULTS.priceAgreementTolerance),
    journeys: list(pick('journeys', 'READINESS_EVAL_JOURNEYS'), DEFAULTS.journeys),
    limit: num(pick('limit', 'READINESS_EVAL_LIMIT'), DEFAULTS.limit),
    classes: list(pick('classes', 'READINESS_EVAL_CLASSES'), null),
    langs: list(pick('langs', 'READINESS_EVAL_LANGS'), null),
    markets: list(pick('markets', 'READINESS_EVAL_MARKETS'), null),
    seed: num(pick('seed', 'READINESS_EVAL_SEED'), DEFAULTS.seed),
    querySet: String(
      pick('query-set', 'READINESS_EVAL_QUERY_SET') || path.join(__dirname, '..', 'fixtures', 'queries.v1.json'),
    ),
    queryOverlay: pick('query-overlay', 'READINESS_EVAL_QUERY_OVERLAY') || null,
    outDir,
    diffAgainst: pick('diff-against', 'READINESS_EVAL_DIFF_AGAINST') || null,
    judgeModule: pick('judge-module', 'READINESS_EVAL_JUDGE_MODULE') || null,
    killFile: String(pick('kill-file', 'READINESS_EVAL_KILL_FILE') || path.join(outDir, 'KILL')),
    clientName: DEFAULTS.clientName,
    clientVersion: DEFAULTS.clientVersion,
    protocolVersion: String(pick('protocol-version', 'READINESS_EVAL_PROTOCOL_VERSION') || DEFAULTS.protocolVersion),
    slos,
    unknownSlos,
    removedFlags: REMOVED_FLAGS.filter((k) => f[k] !== undefined || env[`READINESS_EVAL_${k.replace(/-/g, '_').toUpperCase()}`] !== undefined),
    load: {
      enabled: bool(pick('load', 'READINESS_EVAL_LOAD'), LOAD_DEFAULTS.enabled),
      rpsStart: num(pick('rps-start', 'READINESS_EVAL_RPS_START'), LOAD_DEFAULTS.rpsStart),
      rpsEnd: num(pick('rps-end', 'READINESS_EVAL_RPS_END'), LOAD_DEFAULTS.rpsEnd),
      rampSeconds: num(pick('ramp-seconds', 'READINESS_EVAL_RAMP_SECONDS'), LOAD_DEFAULTS.rampSeconds),
      holdSeconds: num(pick('hold-seconds', 'READINESS_EVAL_HOLD_SECONDS'), LOAD_DEFAULTS.holdSeconds),
      maxConcurrency: num(pick('load-concurrency', 'READINESS_EVAL_LOAD_CONCURRENCY'), LOAD_DEFAULTS.maxConcurrency),
      maxRequests: num(pick('max-requests', 'READINESS_EVAL_MAX_REQUESTS'), LOAD_DEFAULTS.maxRequests),
      tools: list(pick('load-tools', 'READINESS_EVAL_LOAD_TOOLS'), LOAD_DEFAULTS.tools),
      breakerWindow: num(pick('breaker-window', 'READINESS_EVAL_BREAKER_WINDOW'), LOAD_DEFAULTS.breakerWindow),
      breakerErrorRate: num(pick('breaker-error-rate', 'READINESS_EVAL_BREAKER_ERROR_RATE'), LOAD_DEFAULTS.breakerErrorRate),
      callerCount: callerKeys.length,
    },
    secrets: {
      apiKey: String(env.READINESS_EVAL_API_KEY || '').trim() || null,
      bearerToken: String(env.READINESS_EVAL_BEARER_TOKEN || '').trim() || null,
      callerKeys,
    },
  };
  return config;
}

function timestampSlug(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
}

/** Validate shape (not safety). Returns a list of problems; empty = ok. */
function validateConfig(config) {
  const problems = [];
  if (!TIERS[config.tier]) problems.push(`unknown tier "${config.tier}" (expected ${Object.keys(TIERS).join('|')})`);
  if (!AUTH_MODES.includes(config.auth)) problems.push(`unknown auth "${config.auth}" (expected ${AUTH_MODES.join('|')})`);
  if (!TARGET_KINDS.includes(config.targetKind)) {
    problems.push(`unknown target kind "${config.targetKind}" (expected ${TARGET_KINDS.join('|')})`);
  }
  if (config.mode === 'run' && !config.baseUrl) problems.push('READINESS_EVAL_BASE_URL / --base-url is required');
  if (config.baseUrl) {
    try {
      const u = new URL(config.baseUrl);
      if (!['http:', 'https:'].includes(u.protocol)) problems.push('base URL must be http(s)');
    } catch {
      problems.push(`base URL "${config.baseUrl}" does not parse`);
    }
  }
  if (config.mode === 'run') {
    if (config.auth === 'api_key' && !config.secrets.apiKey && config.secrets.callerKeys.length === 0) {
      problems.push('auth=api_key needs READINESS_EVAL_API_KEY (or READINESS_EVAL_CALLER_KEYS)');
    }
    if (config.auth === 'bearer' && !config.secrets.bearerToken) problems.push('auth=bearer needs READINESS_EVAL_BEARER_TOKEN');
  }
  for (const removed of config.removedFlags) {
    problems.push(`--${removed} is not supported (removed: the target allowlist in safety.cjs is the only way to choose a target)`);
  }
  if (config.unknownSlos.length) problems.push(`unknown --slo keys: ${config.unknownSlos.join(', ')}`);
  if (!(config.concurrency >= 1)) problems.push('concurrency must be >= 1');
  if (!(config.timeoutMs > 0)) problems.push('timeout must be > 0');
  if (!(config.followSample >= 0 && config.followSample <= 1)) problems.push('follow-sample must be within [0,1]');
  return problems;
}

/** A copy safe to print or write: secrets replaced by presence + count only. */
function redactConfig(config) {
  const { secrets, ...rest } = config;
  return {
    ...rest,
    secrets: {
      apiKey: secrets.apiKey ? '<set>' : null,
      bearerToken: secrets.bearerToken ? '<set>' : null,
      callerKeys: `<${secrets.callerKeys.length} keys>`,
    },
  };
}

module.exports = {
  TIERS,
  AUTH_MODES,
  TARGET_KINDS,
  DEFAULT_SLOS,
  DEFAULTS,
  LOAD_DEFAULTS,
  parseArgv,
  resolveConfig,
  validateConfig,
  redactConfig,
};
