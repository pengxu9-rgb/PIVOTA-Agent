#!/usr/bin/env node
const axios = require('axios');

function pickArg(name) {
  const prefix = `${name}=`;
  for (const item of process.argv.slice(2)) {
    if (item.startsWith(prefix)) return item.slice(prefix.length).trim();
  }
  return '';
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function buildHeaders(adminKey) {
  return {
    'X-Aurora-Admin-Key': adminKey,
    'Content-Type': 'application/json',
  };
}

async function getState(baseUrl, adminKey) {
  const resp = await axios.get(`${baseUrl}/v1/ops/pdp-prefetch/state`, {
    headers: buildHeaders(adminKey),
    timeout: 10000,
    validateStatus: () => true,
  });
  return {
    status: Number(resp?.status || 0),
    body: resp?.data || null,
  };
}

async function runOnce(baseUrl, adminKey, reason) {
  const resp = await axios.post(
    `${baseUrl}/v1/ops/pdp-prefetch/run`,
    reason ? { reason } : {},
    {
      headers: buildHeaders(adminKey),
      timeout: 120000,
      validateStatus: () => true,
    },
  );
  return {
    status: Number(resp?.status || 0),
    body: resp?.data || null,
  };
}

async function main() {
  const baseUrl = normalizeBaseUrl(
    pickArg('--base') ||
      process.env.AURORA_BASE_URL ||
      process.env.BASE_URL ||
      process.env.AURORA_BFF_BASE_URL ||
      '',
  );
  const adminKey = String(
    pickArg('--admin-key') ||
      process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ADMIN_KEY ||
      '',
  ).trim();
  const reason = String(
    pickArg('--reason') ||
      process.env.PDP_PREWARM_REASON ||
      'hotset_prewarm_manual_script',
  ).trim();
  const stateOnly = hasFlag('--state-only');

  if (!baseUrl) {
    console.error('missing base url: pass --base=... or set AURORA_BASE_URL');
    process.exitCode = 2;
    return;
  }
  if (!adminKey) {
    console.error('missing admin key: pass --admin-key=... or set AURORA_BFF_PDP_HOTSET_PREWARM_ADMIN_KEY');
    process.exitCode = 2;
    return;
  }

  const before = await getState(baseUrl, adminKey);
  if (before.status !== 200) {
    console.error(JSON.stringify({ step: 'state_before', ...before }, null, 2));
    process.exitCode = 1;
    return;
  }

  let runResult = null;
  if (!stateOnly) {
    runResult = await runOnce(baseUrl, adminKey, reason);
    if (runResult.status !== 200) {
      console.error(JSON.stringify({ step: 'run_once', ...runResult }, null, 2));
      process.exitCode = 1;
      return;
    }
  }

  const after = await getState(baseUrl, adminKey);
  if (after.status !== 200) {
    console.error(JSON.stringify({ step: 'state_after', ...after }, null, 2));
    process.exitCode = 1;
    return;
  }

  const output = {
    ok: true,
    base_url: baseUrl,
    mode: stateOnly ? 'state_only' : 'run_once',
    reason: stateOnly ? null : reason,
    before: before.body,
    run: runResult ? runResult.body : null,
    after: after.body,
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
