'use strict';

// What of a product's `seed_data` may leave the invoke route.
//
// WHY. buildExternalSeedProduct attaches the stored external-seed blob to every product it builds
// (`seed_data: runtimeSeedData`), and buildApprovedRuntimeSeedData only deletes a fixed list of keys from
// it. Everything else the backend keeps in seed_data -- price-read bookkeeping, refresh state, review
// aggregates, authority sources, recall internals, canonicalised variant pricing and inventory -- rides on
// the product. In-process readers need it (pdpBuilder, RecommendationEngine, the relationship graph, ...),
// so it cannot be stripped at build time. But several invoke exits serialize the product whole:
// get_discovery_feed's default 'full' detail, find_products_multi's discovery bridge and its creator
// human-apparel lane, and anything else that returns a built product before an allowlist projection.
//
// WHAT. An ALLOWLIST, not a denylist: a key added to seed_data later is dropped here unless someone adds it
// below on purpose. The kept fields are exactly the ones a known consumer reads off an invoke response:
//   - agent-ui (src/lib/api.ts, src/features/pdp/adapter/mapToPdpPayload.ts): image fallbacks from
//     seed_data and seed_data.snapshot (image_url / imageUrl / image / images / image_urls);
//   - agent-ui (src/lib/productCardPresentation.ts): derived.recall.retrieval_summary and
//     snapshot.description as card-text fallbacks, snapshot.variants[0].option_name for the variant badge;
//   - checkoutHandoffResolver.deriveWarmHandoffVariantGid: a client may echo a product back as the handoff
//     descriptor, and the warm-handoff lane reads variant ids + stock from descriptor.seed_data
//     (shopifyVariantResolver.resolveVariantFromSeed: variants / snapshot.variants).
// Nothing else on the invoke surface reads seed_data from a response (checked: agent-ui, creator-ui,
// aurora-chatbox, glow-agent, agents-portal, marketing, the backend's gateway callers, and the gateway's own
// loopback callers -- those all read seed_data from DB rows in-process, which this module never touches).
//
// When nothing allowlisted is present the key is dropped entirely rather than sent as `{}`.

const SEED_IMAGE_FIELDS = Object.freeze(['image_url', 'imageUrl', 'image', 'images', 'image_urls']);
const SEED_SNAPSHOT_TEXT_FIELDS = Object.freeze(['description']);
const SEED_VARIANT_FIELDS = Object.freeze([
  'variant_id',
  'variant_gid',
  'selected_variant_id',
  'id',
  'sku',
  'option_name',
  'stock',
  'availability',
  'availability_status',
]);

// Deep enough for any real response (products sit 2-5 levels down); a bound so a pathological body can
// never recurse without limit. Below it the body is passed through unchanged.
const MAX_WALK_DEPTH = 32;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPresent(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function pickPresent(source, fields, out = {}) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field) && isPresent(source[field])) {
      out[field] = source[field];
    }
  }
  return out;
}

function projectSeedVariants(variants) {
  if (!Array.isArray(variants)) return undefined;
  const projected = [];
  for (const variant of variants) {
    if (!isPlainObject(variant)) continue;
    const kept = pickPresent(variant, SEED_VARIANT_FIELDS);
    if (Object.keys(kept).length > 0) projected.push(kept);
  }
  return projected.length > 0 ? projected : undefined;
}

// One seed_data value -> its allowlisted projection, or undefined when nothing allowlisted is present
// (including a seed_data that is not an object at all: a string or array would be passed through whole).
function projectSeedData(seedData) {
  if (!isPlainObject(seedData)) return undefined;
  const out = pickPresent(seedData, SEED_IMAGE_FIELDS);

  const variants = projectSeedVariants(seedData.variants);
  if (variants) out.variants = variants;

  if (isPlainObject(seedData.snapshot)) {
    const snapshot = pickPresent(seedData.snapshot, [...SEED_IMAGE_FIELDS, ...SEED_SNAPSHOT_TEXT_FIELDS]);
    const snapshotVariants = projectSeedVariants(seedData.snapshot.variants);
    if (snapshotVariants) snapshot.variants = snapshotVariants;
    if (Object.keys(snapshot).length > 0) out.snapshot = snapshot;
  }

  const recall = isPlainObject(seedData.derived) && isPlainObject(seedData.derived.recall)
    ? seedData.derived.recall
    : null;
  if (recall && isPresent(recall.retrieval_summary)) {
    out.derived = { recall: { retrieval_summary: recall.retrieval_summary } };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

// Walk a response body and replace every `seed_data` value, at any depth, with its projection.
//
// COPY-ON-WRITE: response bodies are often shared objects (feed and search caches hand out the same
// product objects to later requests), so the input is never mutated, and a subtree with no seed_data in it
// is returned as the SAME reference. A body with no seed_data anywhere therefore comes back as the very
// object that went in -- byte-identical output, no allocation.
function projectSeedDataDeep(value, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return value;
  if (Array.isArray(value)) {
    let copy = null;
    for (let i = 0; i < value.length; i += 1) {
      const next = projectSeedDataDeep(value[i], depth + 1);
      if (next !== value[i]) {
        if (!copy) copy = value.slice();
        copy[i] = next;
      }
    }
    return copy || value;
  }
  if (!isPlainObject(value)) return value;

  let copy = null;
  for (const key of Object.keys(value)) {
    const current = value[key];
    let next;
    if (key === 'seed_data') {
      next = projectSeedData(current);
      // A missing projection drops the key; even an already-empty seed_data is rewritten so the
      // contract "seed_data on the wire is allowlisted" has no exceptions.
      if (next === undefined) {
        if (!copy) copy = { ...value };
        delete copy[key];
        continue;
      }
    } else {
      next = projectSeedDataDeep(current, depth + 1);
      if (next === current) continue;
    }
    if (!copy) copy = { ...value };
    copy[key] = next;
  }
  return copy || value;
}

module.exports = {
  projectSeedData,
  projectSeedDataDeep,
  SEED_IMAGE_FIELDS,
  SEED_SNAPSHOT_TEXT_FIELDS,
  SEED_VARIANT_FIELDS,
  MAX_WALK_DEPTH,
};
