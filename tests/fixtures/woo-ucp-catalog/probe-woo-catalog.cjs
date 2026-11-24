'use strict';

const { createWooUcpCatalogClient } = require('../../../src/services/wooUcpCatalogClient');

async function probeWooCatalog({ origin, productId, variantId, profile, fetchMerchant }) {
  const client = createWooUcpCatalogClient({ merchantOrigin: origin, profileUrl: profile, fetchMerchant });
  const result = await client.lookupVariant({ productId, variantId, country: 'US', currency: 'USD' });
  if (result.lookup.sku !== 'UCP-FIX-BLUE' || result.lookup.price.amount !== 1234 || !result.lookup.available) {
    throw Object.assign(new Error('fixture_sku_price_or_availability_mismatch'), {
      code: 'fixture_sku_price_or_availability_mismatch', evidence: result.lookup,
    });
  }
  return { status: 'pass', auth: 'anonymous', profileIncluded: Boolean(profile), ...result };
}

module.exports = { probeWooCatalog };

if (require.main === module) {
  const [origin, productId, variantId] = process.argv.slice(2);
  if (!origin || !productId || !variantId) {
    console.error('Usage: node probe-woo-catalog.cjs HTTPS_ORIGIN PRODUCT_ID VARIANT_ID');
    process.exitCode = 2;
  } else {
    probeWooCatalog({ origin, productId, variantId, profile: process.env.WOO_CATALOG_AGENT_PROFILE_URL })
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(JSON.stringify({ status: 'failed', code: error.code ?? error.name, evidence: error.evidence }));
        process.exitCode = 1;
      });
  }
}
