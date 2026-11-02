'use strict';

const net = require('node:net');
// The gateway's own rule for which get_product scope is served on its unscoped detail lane.
const { isSeedSupplyUnservableUpstream } = require('../../../src/services/externalSeedLane');

// WHERE THE HARNESS MAY POINT, AND HOW HARD IT MAY PUSH.
//
// A production agent tool call mints attribution click rows (/r links) and can trigger live reads against
// merchant stores, whoever calls it. So the harness may only address targets it can PROVE are not production.
// That is an ALLOWLIST, never a denylist: a denylist of production domains was bypassed on 2026-10-20 by Cloud
// Run service and revision URLs, the hosting provider's default domain, IP literals in every spelling, wildcard
// DNS (*.nip.io) and *.test / *.localhost names. Two things are allowed, nothing else:
//
//   1. LOOPBACK IP LITERALS: 127.0.0.0/8 and ::1, over http or https. No names: "localhost" (or anything that
//      must be resolved) is refused, because resolution is exactly what a hosts entry, a tunnel or wildcard
//      DNS can point at production.
//   2. EVAL_CLONE_HOSTS: exact hostnames of the prod-data clone, https only, compiled in. EMPTY TODAY. A host
//      is added here in a reviewed change once the clone exists and is verified to have its own attribution
//      tables and no merchant egress.
//   3. PROD_SYNTHETIC_HOSTS: the production commerce door, for OUR OWN EVAL CLIENT ONLY (`--target-kind
//      prod-synthetic`). Production marks that client's calls synthetic (src/guardrails/syntheticCallers.js,
//      docs/runbooks/synthetic_callers.md): read tools only, no writes, no live merchant reads. https, the /mcp
//      path, an OAuth bearer, no load mode, and its own lower caps (PROD_SYNTHETIC_CAPS).
//
// Being allowed is necessary, not sufficient: EVERY response must also carry the deployment attestation
// header below, which only the clone (or a local test stub) sets; the client halts the run on the first
// response without it. That defeats a loopback port forwarded or tunnelled to production.
//
// The caps below are COMPILED IN. Config can lower them, never raise them.

const HARD_CAPS = Object.freeze({
  maxRps: 20,
  maxConcurrency: 32,
  maxLoadRequests: 5000,
  maxLoadSeconds: 900,
  maxDiscoveryCalls: 20000,
  // Non-load runs are paced too: a shared start-rate limit and a wall-clock limit.
  maxDiscoveryRps: 50,
  maxRunSeconds: 4 * 3600,
  minTimeoutMs: 1000,
  maxTimeoutMs: 120000,
});

// Exact hostnames (lowercase, no trailing dot, no port). Added only in a reviewed change. See the note above.
const EVAL_CLONE_HOSTS = Object.freeze([]);

// The positive server attestation every response must carry. Header names are case-insensitive on the wire.
const ATTESTATION = Object.freeze({ header: 'x-pivota-deployment', value: 'eval-clone' });

// Exact hostnames of the production synthetic target. See (3) above.
const PROD_SYNTHETIC_HOSTS = Object.freeze(['commerce.mcp.pivota.cc']);
const PROD_SYNTHETIC_PATH = '/mcp';
// What production says about the eval client on every /mcp response: the state it is served in. A run needs
// `enforce` on EVERY response (any other value means its calls are ordinary ones, with real writes); the
// classification check (initialize + tools/list only, no tool call) accepts `observe` too.
const SYNTHETIC_STATE = Object.freeze({ header: 'x-pivota-synthetic', run: Object.freeze(['enforce']), check: Object.freeze(['observe', 'enforce']) });
// The read tools production allows the eval client, less get_intel (no journey calls it).
const PROD_SYNTHETIC_TOOLS = Object.freeze(['search_catalog', 'get_product', 'get_offers', 'get_alternatives']);
// A canary (`--canary <tool>`) is ONE call of one tool, with exactly these arguments, given as flags. The ids come
// from a read-only lookup, never from a production search. `market` is never sent, so nothing asks for a live read.
// get_product's schema requires a merchant_id, and an ordinary merchant's scope goes straight to the backend: its
// canary takes only a seed-supply pair the gateway serves on its unscoped detail lane (get_pdp_v2, over the
// loopback), the lane the synthetic marker has to survive.
const CANARY_ARGS = Object.freeze({
  get_alternatives: Object.freeze(['merchant_id', 'product_id']),
  get_product: Object.freeze(['merchant_id', 'product_id']),
  search_catalog: Object.freeze(['query']),
  get_offers: Object.freeze(['merchant_id', 'product_id']),
});
const CANARY_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
// Lower than HARD_CAPS. A run fits inside one access token (an hour): it is refreshed right before the run.
const PROD_SYNTHETIC_CAPS = Object.freeze({ maxConcurrency: 2, maxRps: 1, maxLimit: 200, maxRunSeconds: 3000 });

/**
 * The header and values a response must carry for this target kind. `stage` is "run" or "check".
 * @returns {{ header: string, values: readonly string[] }}
 */
function attestationFor(kind, { stage = 'run' } = {}) {
  if (kind === 'prod-synthetic') return { header: SYNTHETIC_STATE.header, values: stage === 'check' ? SYNTHETIC_STATE.check : SYNTHETIC_STATE.run };
  return { header: ATTESTATION.header, values: [ATTESTATION.value] };
}

function isLoopbackLiteral(host) {
  if (typeof host !== 'string') return false;
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const v = net.isIP(h);
  if (v === 4) return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
  if (v === 6) return h === '::1';
  return false;
}

/**
 * The URL's hostname exactly as the WHATWG parser normalizes it, brackets stripped; null if unparseable. The
 * parser already lowercases hosts and canonicalizes numeric IPv4 (0x7f000001 -> 127.0.0.1); it does NOT strip
 * a trailing dot, and neither does this (a test pins all three).
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * Classify one URL against the allowlist. Pure.
 * @param {string} url
 * @param {{ cloneHosts?: readonly string[] }} [opts] cloneHosts defaults to the compiled-in list (tests inject one).
 * @returns {{ ok: boolean, kind: 'loopback'|'clone'|null, host: string|null, problem: string|null }}
 */
function classifyTarget(url, { cloneHosts = EVAL_CLONE_HOSTS, prodSyntheticHosts = PROD_SYNTHETIC_HOSTS } = {}) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return { ok: false, kind: null, host: null, problem: `target URL "${url}" does not parse` };
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // already lowercased by the WHATWG parser
  const refuse = (problem) => ({ ok: false, kind: null, host, problem });
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return refuse(`scheme ${u.protocol} is not http(s)`);
  if (u.username || u.password) return refuse('a target URL must not carry credentials (user:pass@)');
  if (isLoopbackLiteral(host)) return { ok: true, kind: 'loopback', host, problem: null };
  if (cloneHosts.includes(host)) {
    if (u.protocol !== 'https:') return refuse(`eval clone ${host} must be addressed over https`);
    return { ok: true, kind: 'clone', host, problem: null };
  }
  if (prodSyntheticHosts.includes(host)) {
    if (u.protocol !== 'https:') return refuse(`production synthetic target ${host} must be addressed over https`);
    if (u.port) return refuse(`production synthetic target ${host} takes no port`);
    return { ok: true, kind: 'prod-synthetic', host, problem: null };
  }
  return refuse(
    `target ${host || '(empty)'} is not allowed: only loopback IP literals (127.0.0.0/8, ::1), the compiled-in ` +
      'EVAL_CLONE_HOSTS (empty today) and, as our eval client, PROD_SYNTHETIC_HOSTS may be addressed',
  );
}

const MCP_PATH_RE = /^\/[A-Za-z0-9_\-/]*$/;

/**
 * Decide whether a run may proceed against the configured target. Pure. Judges the FINAL endpoint (base URL
 * + MCP path), so a crafted path cannot move the host.
 * @returns {{ ok: boolean, problems: string[], notes: string[] }}
 */
function checkTarget(config, { cloneHosts = EVAL_CLONE_HOSTS, prodSyntheticHosts = PROD_SYNTHETIC_HOSTS } = {}) {
  const problems = [];
  const notes = [];
  if (!config.baseUrl) {
    if (config.mode === 'run') problems.push('no target');
    return { ok: problems.length === 0, problems, notes };
  }
  if (!MCP_PATH_RE.test(String(config.mcpPath || ''))) problems.push(`MCP path "${config.mcpPath}" must be a plain absolute path`);
  const base = classifyTarget(config.baseUrl, { cloneHosts, prodSyntheticHosts });
  const endpoint = classifyTarget(config.endpoint, { cloneHosts, prodSyntheticHosts });
  for (const c of [base, endpoint]) if (!c.ok && !problems.includes(c.problem)) problems.push(c.problem);
  if (base.ok && endpoint.ok && base.host !== endpoint.host) problems.push('the MCP path moved the target host');
  if (endpoint.ok) {
    const wanted = { loopback: 'local', clone: 'prod-clone', 'prod-synthetic': 'prod-synthetic' }[endpoint.kind];
    if (config.targetKind !== wanted) problems.push(`target ${endpoint.host} is a ${endpoint.kind} target: --target-kind must be ${wanted}`);
    const att = attestationFor(endpoint.kind, { stage: config.checkClassification ? 'check' : 'run' });
    notes.push(`target ${endpoint.host} is an allowed ${endpoint.kind} target; every response must carry ${att.header}: ${att.values.join('|')}`);
    if (endpoint.kind === 'prod-synthetic') problems.push(...checkProdSynthetic(config));
  }
  if (config.timeoutMs < HARD_CAPS.minTimeoutMs || config.timeoutMs > HARD_CAPS.maxTimeoutMs) {
    problems.push(`timeout ${config.timeoutMs}ms outside [${HARD_CAPS.minTimeoutMs}, ${HARD_CAPS.maxTimeoutMs}]`);
  }
  if (config.concurrency > HARD_CAPS.maxConcurrency) {
    problems.push(`concurrency ${config.concurrency} exceeds hard cap ${HARD_CAPS.maxConcurrency}`);
  }
  return { ok: problems.length === 0, problems, notes };
}

/** What a production synthetic run may be: the eval client on the commerce door, reading, gently. Pure. */
function checkProdSynthetic(config) {
  const problems = [];
  if (config.tier !== 'commerce') problems.push('a production synthetic run uses --tier commerce');
  if (config.mcpPath !== PROD_SYNTHETIC_PATH) problems.push(`a production synthetic run uses the ${PROD_SYNTHETIC_PATH} path`);
  if (config.auth !== 'bearer') problems.push('a production synthetic run authenticates as the eval OAuth client (--auth bearer)');
  if (config.load && config.load.enabled) problems.push('load mode never runs against production');
  if (config.canary) {
    if (config.checkClassification) problems.push('--canary and --check-classification are separate steps');
    problems.push(...checkCanary(config.canary, config.canaryArgs || {}));
    // One call: the run caps are moot.
    return problems;
  }
  // The classification check makes two requests (initialize, tools/list) and calls no tool: the run caps are moot.
  if (config.checkClassification) return problems;
  for (const j of config.journeys || []) {
    if (j === 'recommend') problems.push('the recommend journey is not a production synthetic journey (recommend_products is not allowed)');
  }
  if (config.concurrency > PROD_SYNTHETIC_CAPS.maxConcurrency) problems.push(`concurrency ${config.concurrency} exceeds the production synthetic cap ${PROD_SYNTHETIC_CAPS.maxConcurrency}`);
  if (config.discoveryRps > PROD_SYNTHETIC_CAPS.maxRps) problems.push(`rps ${config.discoveryRps} exceeds the production synthetic cap ${PROD_SYNTHETIC_CAPS.maxRps}`);
  if (!(config.limit > 0) || config.limit > PROD_SYNTHETIC_CAPS.maxLimit) problems.push(`a production synthetic run takes --limit 1..${PROD_SYNTHETIC_CAPS.maxLimit} queries`);
  if (!(config.maxWallSeconds > 0) || config.maxWallSeconds > PROD_SYNTHETIC_CAPS.maxRunSeconds) {
    problems.push(`a production synthetic run takes --max-wall-seconds 1..${PROD_SYNTHETIC_CAPS.maxRunSeconds} (one access token)`);
  }
  return problems;
}

/** A canary's tool and arguments. Pure. */
function checkCanary(tool, args) {
  const want = Object.prototype.hasOwnProperty.call(CANARY_ARGS, tool) ? CANARY_ARGS[tool] : null;
  if (!want) return [`--canary must be one of ${Object.keys(CANARY_ARGS).join(', ')}`];
  const problems = [];
  for (const key of ['merchant_id', 'product_id', 'query']) {
    const flag = `--canary-${key.replace(/_/g, '-')}`;
    const v = args[key] === undefined ? null : args[key];
    if (!want.includes(key)) {
      if (v !== null) problems.push(`--canary ${tool} takes no ${flag}`);
    } else if (v === null) {
      problems.push(`--canary ${tool} needs ${flag}`);
    } else if (key === 'query' ? v.length > 200 || /[\u0000-\u001f\u007f]/.test(v) : !CANARY_ID_RE.test(v)) {
      problems.push(`${flag} must be ${key === 'query' ? 'at most 200 printable characters' : 'an id of letters, digits and _.:- (at most 200)'}`);
    }
  }
  if (tool === 'get_product' && problems.length === 0 && !isSeedSupplyUnservableUpstream(args.merchant_id, args.product_id)) {
    problems.push('--canary get_product takes a seed-supply pair (an observed seller, or the shared seed bucket with a sig_ id): any other merchant scope goes straight to the backend, not through the unscoped detail lane');
  }
  return problems;
}

/** The arguments a canary sends: exactly its tool's keys. */
function canaryArguments(tool, args) {
  return Object.fromEntries(CANARY_ARGS[tool].map((k) => [k, args[k]]));
}

/** Load-mode settings vs the compiled-in caps. Pure. */
function checkLoad(load) {
  const problems = [];
  if (!load || !load.enabled) return { ok: true, problems };
  if (!(load.rpsStart > 0) || !(load.rpsEnd > 0)) problems.push('load rps must be > 0');
  if (Math.max(load.rpsStart, load.rpsEnd) > HARD_CAPS.maxRps) {
    problems.push(`load rps ${Math.max(load.rpsStart, load.rpsEnd)} exceeds hard cap ${HARD_CAPS.maxRps}`);
  }
  if (load.maxConcurrency > HARD_CAPS.maxConcurrency) {
    problems.push(`load concurrency ${load.maxConcurrency} exceeds hard cap ${HARD_CAPS.maxConcurrency}`);
  }
  if (load.maxRequests > HARD_CAPS.maxLoadRequests) {
    problems.push(`load max requests ${load.maxRequests} exceeds hard cap ${HARD_CAPS.maxLoadRequests}`);
  }
  const seconds = load.rampSeconds + load.holdSeconds;
  if (seconds > HARD_CAPS.maxLoadSeconds) problems.push(`load duration ${seconds}s exceeds hard cap ${HARD_CAPS.maxLoadSeconds}s`);
  if (!(seconds > 0)) problems.push('load duration must be > 0');
  if (!(load.breakerErrorRate > 0 && load.breakerErrorRate <= 1)) problems.push('breaker error rate must be within (0,1]');
  if (!(Number.isInteger(load.breakerWindow) && load.breakerWindow >= 1)) problems.push('breaker window must be an integer >= 1');
  if (!(Number.isInteger(load.maxConcurrency) && load.maxConcurrency >= 1)) problems.push('load concurrency must be an integer >= 1');
  if (!(Number.isInteger(load.maxRequests) && load.maxRequests >= 1)) problems.push('load max requests must be an integer >= 1');
  if (!(load.rampSeconds >= 0) || !(load.holdSeconds >= 0)) problems.push('load ramp/hold seconds must be >= 0');
  return { ok: problems.length === 0, problems };
}

/**
 * The kill switch: a file whose existence stops the run, SIGINT/SIGTERM, the env var at start, and trip() (the
 * load breaker, a halted client). Stopping is not only "send nothing new": `signal` is a run-wide AbortSignal
 * every MCP client passes to fetch, so stopping also CANCELS what is in flight. A SECOND signal exits the
 * process immediately (exit code 130), whatever is still running.
 *
 * `check()` is cheap and is called before every request.
 */
function createKillSwitch({ killFile, env = process.env, fs = require('node:fs'), onSignal = true, exit = (code) => process.exit(code) } = {}) {
  const controller = new AbortController();
  let killedReason = null;
  const kill = (reason) => {
    if (!killedReason) killedReason = reason;
    if (!controller.signal.aborted) controller.abort(new Error(`readiness-eval stopped: ${killedReason}`));
  };
  if (env.READINESS_EVAL_KILL && /^(1|true|yes|on)$/i.test(env.READINESS_EVAL_KILL)) kill('READINESS_EVAL_KILL set');
  const handlers = [];
  let signals = 0;
  if (onSignal) {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      const h = () => {
        signals += 1;
        if (signals >= 2) {
          process.stderr.write(`[readiness-eval] second signal (${sig}): exiting now\n`);
          exit(130);
          return;
        }
        process.stderr.write(`[readiness-eval] ${sig}: stopping and cancelling in-flight calls (send again to exit now)\n`);
        kill(`received ${sig}`);
      };
      process.on(sig, h);
      handlers.push([sig, h]);
    }
  }
  return {
    signal: controller.signal,
    check() {
      if (killedReason) return killedReason;
      if (killFile) {
        try {
          if (fs.existsSync(killFile)) kill(`kill file present: ${killFile}`);
        } catch {
          // An unreadable path is not a kill.
        }
      }
      return killedReason;
    },
    trip(reason) {
      kill(reason);
    },
    // Test hook: what a signal would do, without sending one to the test runner.
    _signal(sig) {
      for (const [s2, h] of handlers) if (s2 === sig) h();
    },
    dispose() {
      for (const [sig, h] of handlers) process.removeListener(sig, h);
    },
  };
}

module.exports = {
  HARD_CAPS,
  EVAL_CLONE_HOSTS,
  ATTESTATION,
  PROD_SYNTHETIC_HOSTS,
  PROD_SYNTHETIC_PATH,
  PROD_SYNTHETIC_TOOLS,
  PROD_SYNTHETIC_CAPS,
  SYNTHETIC_STATE,
  CANARY_ARGS,
  attestationFor,
  checkProdSynthetic,
  checkCanary,
  canaryArguments,
  isLoopbackLiteral,
  hostOf,
  classifyTarget,
  checkTarget,
  checkLoad,
  createKillSwitch,
};
