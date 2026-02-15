#!/usr/bin/env node

require('dotenv').config();
const axios = require('axios');

function parseTargets(raw, defaultMerchantId) {
  const source = String(raw || '').trim();
  if (!source) return [];

  const fallbackMerchant = String(defaultMerchantId || '').trim();
  const seen = new Set();
  const out = [];

  for (const tokenRaw of source.split(/[,\n]/g)) {
    const token = String(tokenRaw || '').trim();
    if (!token) continue;

    let merchantId = fallbackMerchant;
    let productId = token;
    const sepIdx = token.indexOf(':');
    if (sepIdx > 0) {
      merchantId = String(token.slice(0, sepIdx)).trim() || fallbackMerchant;
      productId = String(token.slice(sepIdx + 1)).trim();
    }
    if (!merchantId || !productId) continue;

    const dedupeKey = `${merchantId}:${productId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ merchant_id: merchantId, product_id: productId });
  }

  return out;
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function run() {
  const gatewayUrl = String(
    process.env.PDP_CORE_PREWARM_GATEWAY_URL ||
      process.env.PIVOTA_GATEWAY_URL ||
      'http://127.0.0.1:3000/agent/shop/v1/invoke',
  )
    .trim()
    .replace(/\/$/, '');
  const defaultMerchantId = String(process.env.PDP_CORE_PREWARM_DEFAULT_MERCHANT_ID || '').trim();
  const targets = parseTargets(process.env.PDP_CORE_PREWARM_TARGETS || '', defaultMerchantId);
  const timeoutMs = parsePositiveInt(process.env.PDP_CORE_PREWARM_TIMEOUT_MS, 6500);
  const rounds = parsePositiveInt(process.env.PDP_CORE_PREWARM_ROUNDS, 1);
  const delayMs = parsePositiveInt(process.env.PDP_CORE_PREWARM_ROUND_DELAY_MS, 400);

  if (!targets.length) {
    console.error(
      'No targets configured. Set PDP_CORE_PREWARM_TARGETS=merchant_id:product_id[,merchant_id:product_id,...]',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        gateway_url: gatewayUrl,
        timeout_ms: timeoutMs,
        rounds,
        targets,
      },
      null,
      2,
    ),
  );

  for (let round = 1; round <= rounds; round += 1) {
    let succeeded = 0;
    let failed = 0;
    const roundStart = Date.now();

    for (const target of targets) {
      const reqBody = {
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: target.merchant_id,
            product_id: target.product_id,
          },
          include: ['offers'],
          options: {
            debug: false,
          },
        },
        metadata: {
          source: 'pdp_core_prewarm_script',
        },
      };

      const t0 = Date.now();
      try {
        const resp = await axios.post(gatewayUrl, reqBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: timeoutMs,
        });
        const latencyMs = Math.max(0, Date.now() - t0);
        succeeded += 1;
        console.log(
          JSON.stringify({
            round,
            merchant_id: target.merchant_id,
            product_id: target.product_id,
            status: resp.status,
            latency_ms: latencyMs,
            request_id: resp?.data?.request_id || null,
          }),
        );
      } catch (err) {
        const latencyMs = Math.max(0, Date.now() - t0);
        failed += 1;
        console.log(
          JSON.stringify({
            round,
            merchant_id: target.merchant_id,
            product_id: target.product_id,
            status: err?.response?.status || null,
            latency_ms: latencyMs,
            error: err?.message || String(err),
          }),
        );
      }
    }

    console.log(
      JSON.stringify({
        round,
        attempted: targets.length,
        succeeded,
        failed,
        duration_ms: Math.max(0, Date.now() - roundStart),
      }),
    );

    if (round < rounds) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

run().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
