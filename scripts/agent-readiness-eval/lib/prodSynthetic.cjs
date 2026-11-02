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
const oauth = require('./oauth.cjs');

// What production's tools/list shows our eval client (src/guardrails/syntheticCallers.js SYNTHETIC_READ_TOOLS).
const PRODUCTION_SYNTHETIC_TOOLS = Object.freeze(['get_alternatives', 'get_intel', 'get_offers', 'get_product', 'search_catalog']);
const GCP = Object.freeze({ project: 'pivota-prod', region: 'us-west1', gateway: 'gateway', backend: 'web' });
const SECRET_ENV = 'SYNTHETIC_ASSERTION_SECRET';

// gcloud runs with the operator's environment LESS the harness's secrets: it needs none of them.
const SECRET_ENV_RE = /^READINESS_EVAL_(OAUTH_CLIENT_SECRET|OAUTH_CLIENT_ID|BEARER_TOKEN|API_KEY|CALLER_KEYS)$/;
function gcloudEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV_RE.test(k)));
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
    const fresh = await oauth.ensureFreshToken({ file: config.oauthTokenFile || oauth.DEFAULT_TOKEN_FILE, env, fetchImpl: deps.oauthFetch });
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
 * THE CANARY: one tools/call on the preflight's client, then stop. Prints when it ran (for the log reconciliation),
 * what came back, and nothing of the payload.
 * @returns {Promise<{ code: number, summary: object }>} 0 ok, 1 the call failed or the tool answered an error, 3 halted.
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
    error_code: toolErrorCode(result),
    error: rec.error || null,
  };
  const code = client.halted ? 3 : rec.outcome === 'ok' && summary.is_error === false ? 0 : 1;
  return { code, summary };
}

module.exports = { PRODUCTION_SYNTHETIC_TOOLS, GCP, deploymentProblems, preflight, canary, runGcloud, gcloudEnv };
