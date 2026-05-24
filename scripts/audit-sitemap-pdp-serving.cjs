#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');

const DEFAULT_SITEMAP_URL = 'https://agent.pivota.cc/sitemap-products.xml';
const DEFAULT_GATEWAY_URL = 'https://agent.pivota.cc/api/gateway';

function readArg(name, fallback = null) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  return fallback;
}

function readNumberArg(name, fallback, min = 1) {
  const n = Number(readArg(name, String(fallback)));
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function readBooleanArg(name, fallback = false) {
  const raw = readArg(name, null);
  if (raw == null) return fallback;
  const normalized = String(raw || '').trim().toLowerCase();
  return normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes';
}

async function ensureParentDir(filePath) {
  if (!filePath) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function extractProductIdsFromSitemap(xml) {
  return Array.from(xml.matchAll(/<loc>\s*https?:\/\/[^/]+\/products\/([^<\s]+)\s*<\/loc>/gi))
    .map((match) => {
      try {
        return decodeURIComponent(match[1]);
      } catch (_err) {
        return match[1];
      }
    })
    .filter((id) => id.startsWith('sig_'));
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/xml,text/xml,*/*' },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}: ${text.slice(0, 200)}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function includesForMode(mode) {
  if (mode === 'gate' || mode === 'none') return [];
  if (mode === 'core') return ['offers'];
  return [
    'offers',
    'product_intel',
    'active_ingredients',
    'ingredients_inci',
    'how_to_use',
    'product_overview',
    'supplemental_details',
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBodyError(error) {
  if (!error) return null;
  if (typeof error === 'string') return error;
  if (typeof error === 'object') return error.code || error.message || JSON.stringify(error);
  return String(error);
}

function shouldRetryProbe(row) {
  if (!row || row.ok) return false;
  if (row.error === 'PROBE_FAILED') return true;
  return row.status === 429 || row.status === 500 || row.status === 502 || row.status === 503 || row.status === 504;
}

async function probePdpOnce(gatewayUrl, productId, timeoutMs, include) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: { product_id: productId },
          include,
          options: {
            debug: true,
            no_cache: true,
            cache_bypass: true,
            serving_eligible_only: true,
          },
        },
      }),
    });
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch (_err) {
      body = { parse_error: text.slice(0, 500) };
    }
    const missing = Array.isArray(body.missing) ? body.missing : [];
    const error = normalizeBodyError(body.error);
    return {
      product_id: productId,
      status: res.status,
      ok: res.ok && !error,
      error,
      reason: body.details?.reason || body.error?.message || null,
      blocker_code:
        body.details?.blocker_code ||
        body.details?.serving_eligibility?.blocker_code ||
        null,
      blocker_detail:
        body.details?.blocker_detail ||
        body.details?.serving_eligibility?.blocker_detail ||
        null,
      pdp_version: body.pdp_version || null,
      module_degrade_applied: body.metadata?.module_degrade?.applied ?? null,
      module_health_severity: body.metadata?.module_health?.severity || null,
      missing_modules: missing.map((item) => ({
        type: item?.type || item?.module || 'unknown',
        reason: item?.reason || 'unavailable',
      })),
      latency_ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      product_id: productId,
      status: 0,
      ok: false,
      error: 'PROBE_FAILED',
      reason: err?.message || String(err),
      blocker_code: null,
      blocker_detail: null,
      pdp_version: null,
      module_degrade_applied: null,
      module_health_severity: null,
      missing_modules: [],
      latency_ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probePdp(gatewayUrl, productId, timeoutMs, include, retries, retryDelayMs) {
  let row = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    row = await probePdpOnce(gatewayUrl, productId, timeoutMs, include);
    row.attempts = attempt + 1;
    if (!shouldRetryProbe(row) || attempt === retries) return row;
    await sleep(retryDelayMs * (attempt + 1));
  }
  return row;
}

async function mapWithConcurrency(items, concurrency, worker, onResult = null) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await worker(items[index], index);
      if (onResult) await onResult(out[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function increment(map, key) {
  const normalized = key == null || key === '' ? 'none' : String(key);
  map[normalized] = (map[normalized] || 0) + 1;
}

async function main() {
  const sitemapUrl = readArg('sitemap', process.env.PIVOTA_SITEMAP_URL || DEFAULT_SITEMAP_URL);
  const gatewayUrl = readArg('gateway', process.env.PIVOTA_GATEWAY_URL || DEFAULT_GATEWAY_URL);
  const timeoutMs = readNumberArg('timeout-ms', 20000, 1000);
  const concurrency = readNumberArg('concurrency', 8, 1);
  const limit = readNumberArg('limit', Number.MAX_SAFE_INTEGER, 1);
  const offset = readNumberArg('offset', 0, 0);
  const retries = readNumberArg('retries', 0, 0);
  const retryDelayMs = readNumberArg('retry-delay-ms', 1000, 0);
  const outPath = readArg('out', null);
  const jsonlOutPath = readArg('jsonl-out', null);
  const summaryOutPath = readArg('summary-out', null);
  const progressEvery = readNumberArg('progress-every', 250, 1);
  const quiet = readBooleanArg('quiet', false);
  const includeMode = String(readArg('include-mode', 'full') || 'full').trim().toLowerCase();
  const include = includesForMode(includeMode);

  await ensureParentDir(outPath);
  await ensureParentDir(jsonlOutPath);
  await ensureParentDir(summaryOutPath);
  if (jsonlOutPath) {
    await fs.writeFile(jsonlOutPath, '');
  }

  const xml = await fetchText(sitemapUrl, timeoutMs);
  const allIds = Array.from(new Set(extractProductIdsFromSitemap(xml)));
  const ids = allIds.slice(offset, offset + limit);
  let completed = 0;
  let appendChain = Promise.resolve();
  const rows = await mapWithConcurrency(
    ids,
    concurrency,
    (id) => probePdp(gatewayUrl, id, timeoutMs, include, retries, retryDelayMs),
    async (row) => {
      completed += 1;
      if (jsonlOutPath) {
        appendChain = appendChain.then(() => fs.appendFile(jsonlOutPath, `${JSON.stringify(row)}\n`));
      }
      if (!quiet && (completed === 1 || completed % progressEvery === 0 || completed === ids.length)) {
        process.stderr.write(`[pdp-sitemap-audit] probed ${completed}/${ids.length}\n`);
      }
    },
  );
  await appendChain;

  const byStatus = {};
  const byError = {};
  const byBlocker = {};
  const byModuleHealth = {};
  for (const row of rows) {
    increment(byStatus, row.status);
    increment(byError, row.ok ? 'ok' : row.error || 'unknown_error');
    increment(byBlocker, row.blocker_code || (row.ok ? 'none' : row.reason));
    increment(byModuleHealth, row.module_health_severity || (row.ok ? 'unknown' : 'none'));
  }

  const summary = {
    generated_at: new Date().toISOString(),
    sitemap_url: sitemapUrl,
    gateway_url: gatewayUrl,
    include_mode: includeMode,
    source_total_urls: allIds.length,
    offset,
    retries,
    retry_delay_ms: retryDelayMs,
    total_urls: ids.length,
    ok_count: rows.filter((row) => row.ok).length,
    product_not_servable_count: rows.filter((row) => row.error === 'PRODUCT_NOT_SERVABLE').length,
    failed_count: rows.filter((row) => !row.ok).length,
    module_degrade_applied_count: rows.filter((row) => row.module_degrade_applied === true).length,
    by_status: byStatus,
    by_error: byError,
    by_blocker: byBlocker,
    by_module_health: byModuleHealth,
  };

  const report = { summary, rows };
  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    await fs.writeFile(outPath, `${json}\n`);
  }
  if (summaryOutPath) {
    await fs.writeFile(summaryOutPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (quiet) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }

  if (summary.failed_count > 0) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
