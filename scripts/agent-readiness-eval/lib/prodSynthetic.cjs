'use strict';

// THE PRODUCTION SYNTHETIC PREFLIGHT, before any tool call (run.cjs, --target-kind prod-synthetic). Each step is a
// reason production could serve our eval calls as ordinary ones, with real writes:
//
//   1. the eval client's token is fresh (lib/oauth.cjs): one access token covers the whole run;
//   2. RUN ONLY: the deployment is set up to mark them -- the gateway is in `enforce`, and the gateway AND the
//      backend mount the same Secret Manager version of SYNTHETIC_ASSERTION_SECRET (a backend without it would
//      take the gateway's marker for a stranger's header), each from its latest revision, Ready and serving all
//      traffic. Read with `gcloud run services describe`, read-only, under the operator's own credentials;
//   3. the door says so: initialize carries X-Pivota-Synthetic (enforce for a run; observe or enforce for the
//      classification check), and tools/list offers EXACTLY the five read tools production allows the eval
//      client. Anything else means this token is not the listed eval client, or the config is not the one
//      deployed (docs/runbooks/synthetic_callers.md, "Before the first harness call").
//
// After the preflight, every response of the run must still carry X-Pivota-Synthetic: enforce, or the client
// halts (mcpClient.cjs).

const { execFile } = require('node:child_process');
const { McpClient } = require('./mcpClient.cjs');
const { canaryArguments } = require('./safety.cjs');
const { toolPayload, readSearch, readProduct, readOffers, readAlternatives } = require('./responses.cjs');
const oauth = require('./oauth.cjs');

// What production's tools/list shows our eval client (src/guardrails/syntheticCallers.js SYNTHETIC_READ_TOOLS).
const PRODUCTION_SYNTHETIC_TOOLS = Object.freeze(['get_alternatives', 'get_intel', 'get_offers', 'get_product', 'search_catalog']);
const GCP = Object.freeze({ project: 'pivota-prod', region: 'us-west1', gateway: 'gateway', backend: 'web' });
const SECRET_ENV = 'SYNTHETIC_ASSERTION_SECRET';

// gcloud runs with ONLY what it needs from the operator's environment: where it lives and its config, the
// locale, and the proxy. Nothing else in the shell (the harness's secrets, an LLM key, a GitHub token) reaches it.
const GCLOUD_ENV_KEYS = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TZ', 'GOOGLE_APPLICATION_CREDENTIALS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE']);
const GCLOUD_ENV_PREFIXES = ['CLOUDSDK_', 'LC_'];
function gcloudEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => GCLOUD_ENV_KEYS.has(k) || GCLOUD_ENV_PREFIXES.some((p) => k.startsWith(p))));
}

function runGcloud(args, { execFileImpl = execFile, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl('gcloud', args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: gcloudEnv(env) }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function describeService(service, gcloud) {
  const raw = await gcloud(['run', 'services', 'describe', service, `--project=${GCP.project}`, `--region=${GCP.region}`, '--format=json']);
  return JSON.parse(raw);
}

function containerEnv(svc) {
  const containers = svc?.spec?.template?.spec?.containers;
  const env = Array.isArray(containers) && containers[0] && Array.isArray(containers[0].env) ? containers[0].env : [];
  return new Map(env.map((e) => [e.name, e]));
}

function secretRef(entry) {
  const ref = entry?.valueFrom?.secretKeyRef;
  return ref && ref.name ? { name: String(ref.name), key: String(ref.key || '') } : null;
}

/**
 * Problems with the deployment for a synthetic RUN (step 2). `gcloud(args) -> stdout` is injectable.
 * @returns {Promise<string[]>}
 */
async function deploymentProblems({ gcloud = runGcloud } = {}) {
  const problems = [];
  let gw;
  let web;
  try {
    [gw, web] = await Promise.all([describeService(GCP.gateway, gcloud), describeService(GCP.backend, gcloud)]);
  } catch (err) {
    return [`could not read the deployment with gcloud (${String(err && err.message).slice(0, 200)})`];
  }
  const gwEnv = containerEnv(gw);
  const webEnv = containerEnv(web);
  const mode = gwEnv.get('SYNTHETIC_TRAFFIC_MODE')?.value;
  if (mode !== 'enforce') problems.push(`the gateway's SYNTHETIC_TRAFFIC_MODE is ${mode ? `"${mode}"` : 'unset'}, not "enforce": eval calls would be ordinary calls`);
  const gwRef = secretRef(gwEnv.get(SECRET_ENV));
  const webRef = secretRef(webEnv.get(SECRET_ENV));
  if (!gwRef) problems.push(`the gateway mounts no ${SECRET_ENV}`);
  if (!webRef) problems.push(`the backend (${GCP.backend}) mounts no ${SECRET_ENV}: it would serve eval calls as real ones`);
  if (gwRef && webRef && (gwRef.name !== webRef.name || gwRef.key !== webRef.key)) {
    problems.push(`the gateway and the backend mount different ${SECRET_ENV} versions (${gwRef.name}:${gwRef.key} vs ${webRef.name}:${webRef.key})`);
  }
  for (const [who, ref] of [['gateway', gwRef], ['backend', webRef]]) {
    if (ref && !/^[0-9]+$/.test(ref.key)) problems.push(`the ${who} mounts ${SECRET_ENV} as "${ref.key || '(none)'}", not a pinned version number`);
  }
  for (const [who, svc] of [['gateway', gw], ['backend', web]]) {
    const st = svc?.status || {};
    if (st.latestCreatedRevisionName && st.latestCreatedRevisionName !== st.latestReadyRevisionName) {
      problems.push(`the ${who}'s latest revision ${st.latestCreatedRevisionName} is not Ready`);
    }
    // The env read above is the latest revision's: an older revision still taking traffic may lack it.
    const serving = (Array.isArray(st.traffic) ? st.traffic : []).filter((t) => Number(t && t.percent) > 0);
    if (serving.length === 0 || serving.some((t) => !(t.latestRevision === true || t.revisionName === st.latestReadyRevisionName))) {
      problems.push(`the ${who} does not serve all its traffic from its latest ready revision`);
    }
  }
  return problems;
}

function toolNames(record) {
  const tools = record?.rpc?.result?.tools;
  return Array.isArray(tools) ? tools.map((t) => String(t && t.name)).sort() : null;
}

/**
 * The preflight (steps 1-3). Never calls a tool.
 * @returns {Promise<{ problems: string[], bearerToken: string|null, report: object }>}
 */
async function preflight({ config, env = process.env, deps = {}, log = () => {} }) {
  const report = { target: config.endpoint, stage: config.checkClassification ? 'check' : 'run' };
  let token;
  try {
    // A run must not outlive its token; a check or a canary takes seconds, so the stored token serves while it has
    // a few minutes left, and no refresh (which needs the client secret) is made for it.
    const minSeconds = config.checkClassification || config.canary ? oauth.SHORT_JOB_MIN_SECONDS : oauth.MIN_FRESH_SECONDS;
    const fresh = await oauth.ensureFreshToken({ file: config.oauthTokenFile || oauth.DEFAULT_TOKEN_FILE, env, fetchImpl: deps.oauthFetch, minSeconds });
    token = fresh.token;
    report.token = { refreshed: fresh.refreshed, expires_at: new Date(token.expires_at * 1000).toISOString(), client_id: token.client_id };
    log(`eval token ${fresh.refreshed ? 'refreshed' : 'fresh'}, expires ${report.token.expires_at}`);
  } catch (err) {
    return { problems: [err.message], bearerToken: null, report };
  }
  if (!config.checkClassification) {
    const problems = await deploymentProblems({ gcloud: deps.gcloud });
    if (problems.length) return { problems, bearerToken: null, report };
    log('deployment marks eval calls: gateway in enforce, the same pinned secret on the gateway and the backend');
  }
  const client = new McpClient({
    endpoint: config.endpoint,
    auth: 'bearer',
    bearerToken: token.access_token,
    stage: report.stage,
    timeoutMs: config.timeoutMs,
    protocolVersion: config.protocolVersion,
    clientInfo: { name: config.clientName, version: config.clientVersion },
    fetchImpl: deps.fetchImpl,
  });
  const init = await client.initialize();
  report.state = init.attested || null;
  if (client.halted || init.outcome !== 'ok') {
    return { problems: [`initialize: ${client.halted || init.error || init.outcome}`], bearerToken: null, report };
  }
  const list = await client.listTools();
  report.tools = toolNames(list);
  if (client.halted) return { problems: [`tools/list: ${client.halted}`], bearerToken: null, report };
  if (!report.tools || report.tools.join(',') !== PRODUCTION_SYNTHETIC_TOOLS.join(',')) {
    return {
      problems: [`tools/list offers ${report.tools ? report.tools.join(', ') : 'nothing'}, not exactly ${PRODUCTION_SYNTHETIC_TOOLS.join(', ')}: this token is not the listed eval client`],
      bearerToken: null,
      report,
    };
  }
  return { problems: [], bearerToken: token.access_token, report, client };
}

// Server text in a canary summary is printed only in a safe shape: an error code as a plain token (else "other"),
// an error message with URLs and token values blanked, no control characters, at most 160 characters.
const ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function cappedErrorCode(value) {
  if (value === null || value === undefined) return null;
  return ERROR_CODE_RE.test(String(value)) ? String(value) : 'other';
}
function sanitizedError(value) {
  if (!value) return null;
  return String(value)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/token=[^\s&"']+/gi, 'token=<redacted>')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 160);
}

function toolErrorCode(result) {
  if (!result || result.isError !== true) return null;
  try {
    const parsed = JSON.parse(result.content[0].text);
    return String(parsed.error.code || parsed.error || 'unknown').slice(0, 80);
  } catch {
    return 'unparsed';
  }
}

/**
 * The links an offer answer carries, counted, never printed: every *_url / url field of each offer, how many are
 * /r redirects (`/r?token=<payload>.<signature>`), and how many of those say `syn: 1` in their token payload (the
 * backend stamps it on every link it mints for a synthetic call). The payload is decoded, not verified.
 */
function offerLinkFacts(payload) {
  const v = payload && payload.value && typeof payload.value === 'object' ? payload.value : {};
  const offers = Array.isArray(v.signals) ? v.signals.map((s) => (s && typeof s.value === 'object' && s.value) || s) : [];
  // top_level_urls: the offer's own *_url / url fields only (not nested objects, arrays or best_offer); the /r
  // links the backend mints sit there.
  const facts = { top_level_urls: 0, r_links: 0, r_syn: 0 };
  for (const o of offers) {
    if (!o || typeof o !== 'object') continue;
    for (const [k, raw] of Object.entries(o)) {
      if (!/(^|_)url$/.test(k) || typeof raw !== 'string' || !raw) continue;
      facts.top_level_urls += 1;
      let u;
      try {
        u = new URL(raw);
      } catch {
        continue;
      }
      const token = u.searchParams.get('token');
      if (!/\/r\/?$/.test(u.pathname) || !token) continue;
      facts.r_links += 1;
      try {
        const body = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
        if (body && body.syn === 1) facts.r_syn += 1;
      } catch {
        // An unreadable token says nothing about the flag.
      }
    }
  }
  return facts;
}

// An empty answer's reason comes from the server: printed only when it is a plain short token, else `other`.
const EMPTY_CLASS_RE = /^[a-z0-9_]{1,48}$/;
function cappedEmptyClass(value) {
  const v = typeof value === 'string' ? value : '';
  return EMPTY_CLASS_RE.test(v) ? v : 'other';
}

/** What a canary's answer held: a refusal, an empty answer, or items (and how many). Null when no answer came. */
function canaryResult(tool, rec) {
  if (rec.outcome !== 'ok') return null;
  const payload = toolPayload(rec);
  if (payload.isError) return { kind: 'refusal', count: 0, empty_class: null };
  let count;
  let emptyClass;
  if (tool === 'search_catalog') {
    const s = readSearch(payload);
    [count, emptyClass] = [s.products.length, s.empty_class];
  } else if (tool === 'get_product') {
    const p = readProduct(payload);
    [count, emptyClass] = [p.found ? 1 : 0, p.found ? null : 'not_found'];
  } else if (tool === 'get_offers') {
    const o = readOffers(payload);
    [count, emptyClass] = [o.offers.length, o.empty_class];
  } else {
    const a = readAlternatives(payload);
    [count, emptyClass] = [a.items.length, a.empty_class];
  }
  const out = { kind: count > 0 ? 'items' : 'empty', count, empty_class: count > 0 ? null : cappedEmptyClass(emptyClass || 'unspecified') };
  if (tool === 'get_offers') out.links = offerLinkFacts(payload);
  return out;
}

/**
 * THE CANARY: one tools/call on the preflight's client, then stop. Prints when it ran (for the log reconciliation),
 * what came back, and nothing of the payload.
 * @returns {Promise<{ code: number, summary: object }>} 0 items came back, 1 the call failed or the answer was a
 *   refusal, 3 halted (not marked enforce), 5 the answer was empty.
 */
async function canary({ config, client, now = () => new Date() }) {
  const args = canaryArguments(config.canary, config.canaryArgs);
  const startedAt = now().toISOString();
  const rec = await client.callTool(config.canary, args);
  const result = rec.rpc && rec.rpc.result ? rec.rpc.result : null;
  const summary = {
    canary: config.canary,
    args,
    started_at: startedAt,
    finished_at: now().toISOString(),
    outcome: rec.outcome,
    http_status: rec.http_status,
    state: rec.attested === undefined ? null : rec.attested,
    latency_ms: rec.latency_ms,
    is_error: result ? result.isError === true : null,
    error_code: cappedErrorCode(toolErrorCode(result)),
    error: sanitizedError(rec.error),
    // How many alternatives, products or offers came back; never the items themselves.
    result: canaryResult(config.canary, rec),
  };
  // 0 only for an answer with items. An empty answer (5) is not a failed call (1): read result.kind before any
  // re-run, and take the next id pair from the lookup rather than re-calling with the same one.
  const kind = summary.result && summary.result.kind;
  const code = client.halted ? 3 : kind === 'items' ? 0 : kind === 'empty' ? 5 : 1;
  return { code, summary };
}

module.exports = { PRODUCTION_SYNTHETIC_TOOLS, GCP, deploymentProblems, preflight, canary, offerLinkFacts, runGcloud, gcloudEnv };
