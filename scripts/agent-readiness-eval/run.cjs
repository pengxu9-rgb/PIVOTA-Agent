#!/usr/bin/env node
'use strict';

// Partner-simulator production-readiness eval for the Pivota agent API (MCP).
//
//   node scripts/agent-readiness-eval/run.cjs --dry-run [flags]          print the plan; calls nothing
//   node scripts/agent-readiness-eval/run.cjs --base-url http://127.0.0.1:3000 [flags]
//   node scripts/agent-readiness-eval/run.cjs diff <previous/results.json> <current/results.json>
//
// Runbook: docs/runbooks/agent_readiness_eval.md. DO NOT point this at production: production tool calls
// mint attribution click rows and can trigger live merchant reads. The target guard in lib/safety.cjs
// refuses production hosts unless a server-side synthetic-traffic designation exists and is acknowledged.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveConfig, validateConfig, redactConfig } = require('./lib/config.cjs');
const { checkTarget, checkLoad, createKillSwitch, HARD_CAPS } = require('./lib/safety.cjs');
const { McpClient } = require('./lib/mcpClient.cjs');
const { runJourneys, loadQuerySet, planCalls } = require('./lib/journeys.cjs');
const { runLoad } = require('./lib/load.cjs');
const { loadJudge } = require('./lib/judge.cjs');
const { buildReport, renderMarkdown, renderHtml, diffRuns } = require('./lib/report.cjs');

const HELP = `Agent API readiness eval (partner simulator)

Target (env or flag):
  --base-url / READINESS_EVAL_BASE_URL           e.g. http://127.0.0.1:3000 (required to run)
  --tier public|commerce / READINESS_EVAL_TIER     public = /public/mcp (auth none); commerce = /mcp (API key or bearer)
  --mcp-path / READINESS_EVAL_MCP_PATH             override the path
  --auth none|api_key|bearer / READINESS_EVAL_AUTH
  READINESS_EVAL_API_KEY | READINESS_EVAL_BEARER_TOKEN  (env only; never a flag, never logged)
  --target-kind local|prod-clone                    local = a loopback IP literal; prod-clone = a host in the
                                                    compiled-in EVAL_CLONE_HOSTS allowlist (empty today)
  Every response must carry X-Pivota-Deployment: eval-clone or the run halts (see runbook).

Run shape:
  --dry-run                       print the plan and the safety verdict; call nothing
  --journeys discovery,follow,recommend,consistency
  --classes / --langs / --markets (comma lists; market "none" = no market) / --limit N
  --concurrency 1..32 (default 1) --pacing-ms >=1 (default 250) --timeout-ms 1000..120000 (default 30000)
  --page-size N --top-k N --follow-top N --follow-sample 0..1
  --consistency-sample N --consistency-repeats N --price-tolerance 0.05
  --query-set <json> --query-overlay <json>   (overlay = private extra queries, not committed)
  --judge-module <path>           optional LLM judge (off by default; see lib/judge.cjs for the data boundary)
  --slo key=value                 override an SLO threshold (value "off" disables it)
  --out <dir>                     base dir; each run gets its own new subdir (default: OS temp dir). Refused inside
                                  any git checkout: results hold measured metrics and this repo is public
  --rps N (default 4, cap ${HARD_CAPS.maxDiscoveryRps})   shared start rate for non-load runs
  --max-wall-seconds N (default 3600)   wall-clock limit for the whole run
  --diff-against <results.json>   add a diff vs a previous run

Load mode (OFF unless --load):
  --load --rps-start 0.5 --rps-end 2 --ramp-seconds 60 --hold-seconds 60 --load-concurrency 4 --max-requests 500
  READINESS_EVAL_CALLER_KEYS=key1,key2   one MCP session per caller identity (env only)
  Kill switch: touch <out>/KILL (or --kill-file), Ctrl-C, or READINESS_EVAL_KILL=1. Error breaker:
  --breaker-window 50 --breaker-error-rate 0.5. Hard caps (cannot be raised): ${JSON.stringify(HARD_CAPS)}
`;

function writeOut(dir, report, markdown) {
  fs.writeFileSync(path.join(dir, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'scorecard.md'), markdown);
  fs.writeFileSync(path.join(dir, 'scorecard.html'), renderHtml(markdown, report.verdict));
}

/** The nearest ancestor (or self) that holds a `.git` entry — a repository or worktree root — or null. */
function enclosingGitRoot(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

/** A fresh, never-reused run directory under `base` (mkdir of the leaf fails if it exists). */
function createRunDir(base) {
  fs.mkdirSync(base, { recursive: true });
  const slug = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 17);
  const dir = path.join(base, `run_${slug}_${process.pid}_${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir);
  return dir;
}

// Test-only deps: `fetchImpl` (refusal tests inject one that throws and counts, so "the harness made no
// request" is asserted rather than assumed), `callBudget` (can only lower the compiled-in call cap),
// `onRunDir(dir)` (where this run wrote its results).
async function main(argv = process.argv.slice(2), env = process.env, io = { out: process.stdout, err: process.stderr }, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out.write(HELP);
    return 0;
  }
  if (argv[0] === 'diff') {
    const [a, b] = argv.slice(1);
    if (!a || !b) {
      io.err.write('usage: run.cjs diff <previous/results.json> <current/results.json>\n');
      return 2;
    }
    const prev = JSON.parse(fs.readFileSync(a, 'utf8'));
    const cur = JSON.parse(fs.readFileSync(b, 'utf8'));
    io.out.write(`${JSON.stringify(diffRuns(prev, cur), null, 2)}\n`);
    return 0;
  }

  const config = resolveConfig(argv, env);
  const problems = [...validateConfig(config)];
  const target = checkTarget(config);
  const loadCheck = checkLoad(config.load);
  problems.push(...target.problems, ...loadCheck.problems);
  // Results hold measured metrics and this repository is public: never write them into any git checkout.
  const gitRoot = enclosingGitRoot(config.outDir);
  if (gitRoot) problems.push(`--out ${config.outDir} is inside a git checkout (${gitRoot}); write results outside any repository`);
  const querySet = loadQuerySet(config.querySet, config.queryOverlay);

  if (config.mode === 'dry-run') {
    const plan = {
      mode: 'dry-run (no network calls made)',
      config: redactConfig(config),
      safety: { ok: problems.length === 0, problems, notes: target.notes, hard_caps: HARD_CAPS },
      query_set: { file: config.querySet, version: querySet.version, recommend_needs: querySet.recommend.length },
      plan: planCalls(config, querySet),
      load: config.load.enabled ? config.load : 'disabled',
      judge: config.judgeModule ? `module ${config.judgeModule}` : 'disabled',
    };
    io.out.write(`${JSON.stringify(plan, null, 2)}\n`);
    return problems.length ? 2 : 0;
  }

  if (problems.length) {
    io.err.write(`REFUSED:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 2;
  }

  const judgeFn = loadJudge(config.judgeModule);
  const runDir = createRunDir(config.outDir);
  const killFile = config.killFile || path.join(runDir, 'KILL');
  const killSwitch = createKillSwitch({ killFile, env });
  const extraHeaders = config.syntheticHeader ? { [config.syntheticHeader.toLowerCase()]: config.syntheticHeaderValue } : {};
  const makeClient = (identity) =>
    new McpClient({
      endpoint: config.endpoint,
      auth: identity ? identity.auth : config.auth,
      apiKey: identity ? (identity.auth === 'api_key' ? identity.secret : null) : config.secrets.apiKey,
      bearerToken: identity ? (identity.auth === 'bearer' ? identity.secret : null) : config.secrets.bearerToken,
      timeoutMs: config.timeoutMs,
      protocolVersion: config.protocolVersion,
      clientInfo: { name: config.clientName, version: config.clientVersion },
      extraHeaders,
      fetchImpl: deps.fetchImpl,
      runSignal: killSwitch.signal,
    });
  const log = (msg) => io.err.write(`[readiness-eval] ${msg}\n`);
  log(`run dir ${runDir}`);
  log(`KILL SWITCH: touch ${killFile}   (or Ctrl-C to stop and cancel in-flight calls; Ctrl-C twice exits at once)`);

  let run;
  try {
    log(`target ${config.endpoint} tier=${config.tier} kind=${config.targetKind}; ${querySet.queries.length} queries in set`);
    run = await runJourneys({ config, client: makeClient(null), querySet, judgeFn, killSwitch, log, callBudget: deps.callBudget });
    run.query_set_version = querySet.version;
    if (config.load.enabled && !run.aborted) {
      log('load mode: starting');
      run.load = await runLoad({ config, makeClient, querySet, killSwitch, log });
    }
  } finally {
    killSwitch.dispose();
  }

  const previous = config.diffAgainst ? JSON.parse(fs.readFileSync(config.diffAgainst, 'utf8')) : null;
  const report = buildReport(run, config, previous);
  const markdown = renderMarkdown(report);
  writeOut(runDir, report, markdown);
  if (deps.onRunDir) deps.onRunDir(runDir);
  log(`verdict ${report.verdict.toUpperCase()} — ${path.join(runDir, 'scorecard.md')}`);
  for (const s of report.slos) log(`  ${s.status.padEnd(7)} ${s.label}: ${s.value === null ? '—' : s.value} (threshold ${s.threshold})`);
  // pass = every gated SLO measured and met; incomplete (an SLO had no data) and fail both exit 1.
  return report.verdict === 'pass' ? 0 : report.verdict === 'aborted' ? 3 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[readiness-eval] fatal: ${(err && err.stack) || err}\n`);
      process.exit(4);
    },
  );
}

module.exports = { main };
