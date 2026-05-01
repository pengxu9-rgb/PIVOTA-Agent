#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function auditMismatch(report = {}, options = {}) {
  const expectedCurrency = asString(options.expectedCurrency || 'USD').toUpperCase();
  const targetMerchant = asString(options.merchantName);
  const targets = Array.isArray(report.targets) ? report.targets : [];
  const mismatches = [];

  for (const target of targets) {
    const offers = Array.isArray(target.offers) ? target.offers : [];
    const offendingOffers = offers.filter((offer) => {
      const merchantName = asString(offer.merchant_name || offer.merchantName);
      const currency = asString(offer.currency || offer.price_currency).toUpperCase();
      if (targetMerchant && merchantName !== targetMerchant) return false;
      return Boolean(currency) && currency !== expectedCurrency;
    });
    if (!offendingOffers.length) continue;
    mismatches.push({
      key: asString(target.key),
      product_id: asString(target.product_id),
      page: asString(target.page),
      expected_currency: expectedCurrency,
      offending_offers: offendingOffers.map((offer) => ({
        merchant_name: asString(offer.merchant_name || offer.merchantName),
        price_amount: offer.price_amount ?? null,
        currency: asString(offer.currency || offer.price_currency).toUpperCase(),
        source_url: asString(offer.source_url || offer.url),
      })),
    });
  }

  return {
    current_build_id: asString(report.current_build_id || report.build_id),
    expected_currency: expectedCurrency,
    merchant_name: targetMerchant || null,
    target_count: targets.length,
    mismatch_count: mismatches.length,
    mismatches,
  };
}

async function main() {
  const reportPath = path.resolve(
    argValue('report') ||
      '/Users/pengchydan/dev/PIVOTA-Agent/reports/k_beauty_seed_expansion_20260429/live_pdp/ohlolly_boj_offer_merge_live_probe_current_build_20260501.json',
  );
  const outPath = path.resolve(
    argValue('out') ||
      path.join(path.dirname(reportPath), 'offer_currency_mismatch_audit_20260501.json'),
  );
  const report = readJson(reportPath);
  const result = {
    generated_at: new Date().toISOString(),
    report_path: reportPath,
    ...auditMismatch(report, {
      expectedCurrency: argValue('expected-currency') || argValue('expectedCurrency') || 'USD',
      merchantName: argValue('merchant') || argValue('merchant-name') || argValue('merchantName') || '',
    }),
  };
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ out: outPath, mismatch_count: result.mismatch_count }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error?.code || error?.name || 'live_offer_currency_mismatch_audit_failed',
          message: error?.message || String(error),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  });
}

module.exports = {
  auditMismatch,
};
