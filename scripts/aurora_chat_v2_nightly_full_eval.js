#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const cur = argv[i];
    if (!String(cur).startsWith('--')) continue;
    const key = String(cur).slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function runCommand(cmd, args, env = process.env) {
  const startedAt = new Date().toISOString();
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    env,
  });
  const endedAt = new Date().toISOString();
  const ok = Number(res.status) === 0 && !res.error;
  return {
    cmd: [cmd, ...args].join(' '),
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: Number.isFinite(Number(res.status)) ? Number(res.status) : null,
    signal: res.signal || null,
    ok,
    error: res.error ? String(res.error.message || res.error) : null,
  };
}

function extractMeta(body) {
  if (body && body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)) return body.meta;
  if (
    body &&
    body.session_patch &&
    typeof body.session_patch === 'object' &&
    !Array.isArray(body.session_patch) &&
    body.session_patch.meta &&
    typeof body.session_patch.meta === 'object' &&
    !Array.isArray(body.session_patch.meta)
  ) {
    return body.session_patch.meta;
  }
  return null;
}

function normalizeHeaders(inputHeaders) {
  const out = {};
  const entries = inputHeaders && typeof inputHeaders.entries === 'function' ? Array.from(inputHeaders.entries()) : [];
  for (const [k, v] of entries) out[String(k || '').toLowerCase()] = String(v || '');
  return out;
}

function makeSkippedStep(cmd, reason, extra = {}) {
  const now = new Date().toISOString();
  return {
    cmd,
    started_at: now,
    ended_at: now,
    exit_code: 0,
    signal: null,
    ok: true,
    skipped: true,
    warning: reason,
    ...extra,
  };
}

async function probeLiveTarget(base) {
  const startedAt = new Date().toISOString();
  const cmd = `probe:live-target ${String(base).replace(/\/+$/, '')}/healthz`;
  try {
    const res = await fetch(`${String(base).replace(/\/+$/, '')}/healthz`);
    let body = {};
    try {
      body = await res.json();
    } catch (_err) {
      body = {};
    }
    const status = Number(res.status || 0);
    const version = body && body.version && typeof body.version === 'object' && !Array.isArray(body.version)
      ? body.version
      : {};
    const commit = String(version.commit || '').trim();
    const deploymentId = String(version.deployment_id || '').trim();
    const buildId = String(version.build_id || '').trim();
    const warning = status === 200 && !commit
      ? `live target is missing a commit marker (deployment_id=${deploymentId || 'unknown'}, build_id=${buildId || 'unknown'})`
      : null;
    return {
      cmd,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      exit_code: status === 200 ? 0 : 2,
      signal: null,
      ok: status === 200,
      skipped: false,
      error: status === 200 ? null : `healthz status expected 200, actual=${status}`,
      warning,
      target: {
        status,
        commit: commit || null,
        deployment_id: deploymentId || null,
        build_id: buildId || null,
      },
      skip_live_eval: Boolean(status === 200 && !commit),
    };
  } catch (err) {
    return {
      cmd,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      exit_code: 2,
      signal: null,
      ok: false,
      skipped: false,
      error: `healthz request failed: ${String(err && err.message ? err.message : err)}`,
      warning: null,
      target: null,
      skip_live_eval: false,
    };
  }
}

async function runStagingTravelPreflight(base) {
  const startedAt = new Date().toISOString();
  const cmd = `preflight:aurora-travel ${String(base).replace(/\/+$/, '')}/v1/chat`;
  const payload = {
    message: 'Travel next week skincare plan please.',
    session: {
      state: 'idle',
      profile: {
        skinType: 'combination',
        sensitivity: 'medium',
        barrierStatus: 'stable',
        goals: ['hydration'],
      },
    },
    language: 'EN',
  };

  try {
    const res = await fetch(`${String(base).replace(/\/+$/, '')}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aurora-UID': `nightly_preflight_uid_${Date.now()}`,
        'X-Trace-ID': `nightly_preflight_trace_${Date.now()}`,
        'X-Brief-ID': `nightly_preflight_brief_${Date.now()}`,
      },
      body: JSON.stringify(payload),
    });

    let body = {};
    try {
      body = await res.json();
    } catch (_err) {
      body = {};
    }
    const headers = normalizeHeaders(res.headers);
    const meta = extractMeta(body);
    const errors = [];
    const status = Number(res.status || 0);
    if (status !== 200) errors.push(`status expected 200, actual=${status}`);
    if (!meta) errors.push('meta is missing in preflight');

    const policy = String((meta && meta.policy_version) || headers['x-aurora-policy-version'] || '');
    if (policy && policy !== 'aurora_chat_v2_p0') {
      errors.push(`policy_version expected aurora_chat_v2_p0, actual=${policy}`);
    }

    const intent = String((meta && meta.intent_canonical) || '');
    if (intent && intent !== 'travel_planning') {
      errors.push(`intent_canonical expected travel_planning, actual=${intent}`);
    }

    const gate = String((meta && meta.gate_type) || '');
    if (gate && gate !== 'soft') {
      errors.push(`gate_type expected soft, actual=${gate}`);
    }

    return {
      cmd,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      exit_code: errors.length ? 2 : 0,
      signal: null,
      ok: errors.length === 0,
      error: errors.length ? errors.join(' | ') : null,
      preflight: {
        status,
        policy_version: meta ? meta.policy_version || null : null,
        intent_canonical: meta ? meta.intent_canonical || null : null,
        gate_type: meta ? meta.gate_type || null : null,
        rollout_variant: meta ? meta.rollout_variant || null : null,
        build_sha: meta ? meta.build_sha || null : null,
      },
    };
  } catch (err) {
    return {
      cmd,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      exit_code: 2,
      signal: null,
      ok: false,
      error: `preflight request failed: ${String(err && err.message ? err.message : err)}`,
    };
  }
}

function buildMarkdown(report) {
  const lines = [];
  lines.push('# Aurora Chat V2 Nightly Full Eval');
  lines.push('');
  lines.push(`- base: ${report.base}`);
  lines.push(`- started_at: ${report.started_at}`);
  lines.push(`- finished_at: ${report.finished_at}`);
  lines.push(`- status: ${report.status}`);
  lines.push(`- total_steps: ${report.steps.length}`);
  lines.push(`- failed_steps: ${report.steps.filter((s) => !s.ok).length}`);
  lines.push('');

  lines.push('## Step Results');
  lines.push('');
  for (const step of report.steps) {
    const label = step.skipped ? 'SKIP' : step.ok ? 'PASS' : 'FAIL';
    lines.push(`- ${label}: \`${step.cmd}\` (exit=${step.exit_code == null ? 'null' : step.exit_code})`);
    if (step.warning) lines.push(`- warning: ${step.warning}`);
  }
  lines.push('');

  const failed = report.steps.filter((s) => !s.ok);
  if (failed.length) {
    lines.push('## Failure Clusters');
    lines.push('');
    for (const item of failed) {
      lines.push(`- command: \`${item.cmd}\``);
      if (item.error) lines.push(`- error: ${item.error}`);
      lines.push('');
    }
  }

  lines.push('## Notes');
  lines.push('');
  lines.push('- Focused blockers: unit/replay + local-mock(travel) + live-target traceability + follow-up canary.');
  lines.push('- Follow-up canary remains included for conversation continuity drift.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const base = String(args.base || process.env.AURORA_EVAL_BASE_URL || 'https://pivota-agent-staging.up.railway.app').replace(/\/+$/, '');
  const stamp = nowStamp();
  const reportDir = 'reports';
  fs.mkdirSync(reportDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const steps = [];

  steps.push(runCommand('npm', ['run', 'test:preflight']));
  if (steps[steps.length - 1].ok) {
    steps.push(
      runCommand('node', [
        '--test',
        'tests/aurora_chat_v2_routes.node.test.cjs',
        'tests/aurora_chat_v2_nightly_gates.node.test.cjs',
      ]),
    );
  }
  if (steps[steps.length - 1].ok) {
    steps.push(
      runCommand('npx', [
        'jest',
        'tests/aurora_bff_chatcard_factory_structured_sections.test.js',
        '--runInBand',
      ]),
    );
  }
  if (steps[steps.length - 1].ok) {
    steps.push(runCommand('npm', ['run', 'test:replay-quality']));
  }
  if (steps[steps.length - 1].ok) {
    steps.push(
      runCommand('node', [
        'scripts/aurora_travel_gate.js',
        '--mode',
        'local-mock',
        '--strict-meta',
        'true',
        '--report-dir',
        reportDir,
      ]),
    );
  }
  if (steps[steps.length - 1].ok) {
    steps.push(await probeLiveTarget(base));
  }
  const liveTargetStep = steps[steps.length - 1];
  const shouldSkipLiveEval = Boolean(liveTargetStep && liveTargetStep.ok && liveTargetStep.skip_live_eval);

  if (shouldSkipLiveEval) {
    const reason = liveTargetStep.warning || 'live target skipped';
    steps.push(makeSkippedStep(`preflight:aurora-travel ${base}/v1/chat`, reason));
    steps.push(makeSkippedStep(`node scripts/aurora_travel_gate.js --mode staging-live --base ${base} --strict-meta false --report-dir ${reportDir}`, reason));
    steps.push(makeSkippedStep(`node scripts/chat_followup_canary.mjs --base ${base}`, reason));
  }

  if (steps[steps.length - 1].ok && !shouldSkipLiveEval) {
    steps.push(await runStagingTravelPreflight(base));
  }
  if (steps[steps.length - 1].ok && !shouldSkipLiveEval) {
    steps.push(
      runCommand('node', [
        'scripts/aurora_travel_gate.js',
        '--mode',
        'staging-live',
        '--base',
        base,
        '--strict-meta',
        'false',
        '--report-dir',
        reportDir,
      ]),
    );
  }
  if (steps[steps.length - 1].ok && !shouldSkipLiveEval) {
    steps.push(
      runCommand('node', [
        'scripts/chat_followup_canary.mjs',
        '--base',
        base,
        '--out',
        path.join(reportDir, `chat_followup_canary_nightly_${stamp}.md`),
      ]),
    );
  }

  const failed = steps.filter((s) => !s.ok).length;
  const report = {
    schema_version: 'aurora.chat.nightly_full_eval.v1',
    base,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: failed > 0 ? 'failed' : 'passed',
    steps,
  };

  const jsonPath = path.join(reportDir, `aurora_chat_v2_nightly_full_${stamp}.json`);
  const mdPath = path.join(reportDir, `aurora_chat_v2_nightly_full_${stamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, buildMarkdown(report), 'utf8');
  process.stdout.write(`${JSON.stringify({ report_json: jsonPath, report_md: mdPath, status: report.status })}\n`);

  if (failed > 0) process.exit(2);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[aurora_chat_v2_nightly_full_eval] fatal: ${String(err && err.stack ? err.stack : err)}\n`);
    process.exit(1);
  });
}
