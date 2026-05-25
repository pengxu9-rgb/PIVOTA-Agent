#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool } = require(path.join(__dirname, '../../..', 'src/db'));
const {
  buildIdentityListingFromProduct,
  _internals,
} = require(path.join(__dirname, '../../..', 'src/services/pdpIdentityGraph'));

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? String(value).trim() : '';
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function idsFromArg(value) {
  return text(value)
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolvePath(value) {
  const raw = text(value);
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function writeOut(filePath, payload) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const externalProductIds = idsFromArg(argValue('external-product-ids'));
  if (!externalProductIds.length) throw new Error('Missing --external-product-ids');
  const rows = await _internals.fetchBackfillProducts({
    externalProductIds,
    limit: externalProductIds.length,
  });
  const built = rows
    .map((row) => {
      const listing = buildIdentityListingFromProduct({
        merchantId: row.merchant_id,
        productId: row.product_id,
        product: row.product,
        sourceKind: row.source_kind,
        sourceMeta: row.source_meta,
      });
      return { row, listing };
    })
    .filter((entry) => entry.listing);
  const clustered = _internals.clusterIdentityListings(
    _internals.applyReviewedMultiOfferMergeCandidates(built.map((entry) => entry.listing)),
  );
  const listingByRef = new Map(clustered.map((listing) => [listing.source_listing_ref, listing]));
  const payload = {
    ok: true,
    generated_at: new Date().toISOString(),
    requested_ids: externalProductIds,
    rows: built.map(({ row, listing }) => {
      const finalListing = listingByRef.get(listing.source_listing_ref) || listing;
      return {
        source_listing_ref: finalListing.source_listing_ref,
        brand: finalListing.source_payload?.brand?.name || finalListing.source_payload?.brand || null,
        title: finalListing.source_payload?.title || finalListing.source_payload?.name || null,
        identity_status: finalListing.identity_status,
        review_required: finalListing.review_required,
        review_reason_codes: finalListing.review_reason_codes,
        matched_by_rule: finalListing.matched_by_rule,
        match_basis: finalListing.match_basis,
        variant_axes: finalListing.variant_axes,
        variants: (finalListing.source_payload?.variants || []).map((variant) => ({
          title: variant.title,
          option_name: variant.option_name,
          option_value: variant.option_value,
          axis_kind: variant.axis_kind,
          display_label: variant.display_label,
          source_quality_status: variant.source_quality_status,
        })),
        source_meta: row.source_meta,
      };
    }),
  };
  writeOut(resolvePath(argValue('out')), payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
