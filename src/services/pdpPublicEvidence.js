'use strict';

// Public evidence is an allowlist, never a pass-through of operator provenance.
const STATES = new Set(['absent', 'loading', 'ready', 'empty', 'error', 'missing', 'unavailable', 'blocked', 'not_fetched', 'withheld', 'not_applicable']);
const text = value => typeof value === 'string' ? value.trim() : (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '');
function publicSourceUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.search = ''; url.hash = '';
    return url.toString();
  } catch { return undefined; }
}
function observedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}
function projectPublicMediaEvidence(media) {
  if (!media || typeof media !== 'object' || !['image', 'video'].includes(media.type) || !text(media.url)) return null;
  const source = media.provenance;
  if (!source || typeof source !== 'object') return null;
  if (media.role === 'official_product' && source.source_type === 'merchant_product') {
    return { role: 'official_product', provenance: {
      source_type: 'merchant_product', scope: 'exact_item',
      ...(text(source.product_id) ? { product_id: text(source.product_id) } : {}),
      ...(text(source.merchant_id) ? { merchant_id: text(source.merchant_id) } : {}),
      ...(publicSourceUrl(source.source_url) ? { source_url: publicSourceUrl(source.source_url) } : {}),
    } };
  }
  if (media.role !== 'customer_review' || source.source_type !== 'customer_review' ||
      source.verification_status !== 'review_linked' || source.moderation_status !== 'active' ||
      !text(source.review_id) || !text(source.merchant_id)) return null;
  const scope = source.scope;
  if (!['exact_item', 'product_line', 'review_group'].includes(scope) ||
      (scope === 'exact_item' && !text(source.product_id)) ||
      (scope === 'product_line' && !text(source.review_family_id)) ||
      (scope === 'review_group' && !text(source.review_group_id))) return null;
  const provenance = { source_type: 'customer_review', review_id: text(source.review_id),
    merchant_id: text(source.merchant_id), verification_status: 'review_linked', moderation_status: 'active', scope };
  for (const key of ['product_id', 'review_family_id', 'review_group_id', 'source_record_id']) {
    if (text(source[key])) provenance[key] = text(source[key]);
  }
  if (observedAt(source.source_observed_at)) provenance.source_observed_at = observedAt(source.source_observed_at);
  return { role: 'customer_review', provenance };
}
function normalizeReviewMedia(media, review) {
  if (!media || typeof media !== 'object') return null;
  const result = { type: media.type || 'image', url: media.url || media.image_url,
    ...(media.thumbnail_url ? { thumbnail_url: media.thumbnail_url } : {}) };
  const evidence = projectPublicMediaEvidence({ ...media, ...result });
  // A photo cannot acquire buyer provenance from an array position or a gallery.
  if (evidence?.role === 'customer_review' && evidence.provenance.review_id === text(review?.review_id || review?.id) &&
      (!text(review?.merchant_id) || evidence.provenance.merchant_id === text(review.merchant_id))) Object.assign(result, evidence);
  return result;
}
function projectPublicPdpStateValue(value) {
  const valid = item => typeof item === 'string' && STATES.has(item.toLowerCase());
  if (valid(value)) return value;
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['state', 'status']) if (valid(value[key])) result[key] = value[key];
  if (publicSourceUrl(value.source_url)) result.source_url = publicSourceUrl(value.source_url);
  if (observedAt(value.source_observed_at)) result.source_observed_at = observedAt(value.source_observed_at);
  return result;
}
function projectPublicPdpStateDictionary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => /^[a-z][a-z0-9_]{0,63}$/.test(key))
    .map(([key, state]) => [key, projectPublicPdpStateValue(state)]));
}
function isSyntheticReviewSummary(summary) {
  if (!summary || typeof summary !== 'object') return false;
  if (summary.force_filled === true || summary.distribution_estimated === true) return true;
  const signals = ['status', 'review_status', 'source', 'source_kind', 'sourceKind', 'source_origin', 'sourceOrigin', 'source_type', 'sourceType', 'content_review_state', 'aggregation_scope']
    .map(key => text(summary[key])).join(' ');
  return /(?:pivota_force_fill|force_filled|force_fill|synthetic|simulation|mock|browser_fallback|legacy_fallback|\bestimated\b)/i.test(signals);
}
function reviewAvailability(summary, synthetic = false) {
  if (!summary || synthetic || isSyntheticReviewSummary(summary)) return 'unavailable';
  const state = text(summary.availability_state || summary.status || summary.review_status).toLowerCase();
  if (['loading', 'pending', 'deferred', 'fetching'].includes(state)) return 'loading';
  if (['failed', 'failure', 'timeout'].includes(state)) return 'error';
  if (['rejected', 'removed', 'deleted'].includes(state)) return 'withheld';
  if (['error', 'unavailable', 'absent', 'not_fetched', 'withheld', 'blocked'].includes(state)) return state;
  if (state && !['ready', 'available', 'success', 'active', 'empty'].includes(state)) return 'unavailable';
  const rawCount = summary.review_count ?? summary.count ?? summary.total;
  if (rawCount == null || rawCount === '' || !Number.isFinite(Number(rawCount)) || Number(rawCount) < 0) return 'unavailable';
  if (Number(rawCount) > 0) return 'ready';
  // Zero is conclusive only for an explicitly completed, source-scoped read.
  return ['ready', 'empty'].includes(state) ? 'empty' : 'unavailable';
}
function buildContentModuleStates(modules, product) {
  const states = {};
  const kinds = ['ingredients_inci', 'active_ingredients', 'how_to_use', 'product_overview', 'supplemental_details', 'materials', 'product_specs', 'size_fit', 'care_instructions', 'usage_safety', 'product_facts', 'reviews_preview'];
  const quality = product?.pdp_field_quality_summary || {};
  for (const kind of kinds) {
    const module = modules.find(item => item.type === kind);
    const evidence = quality[kind] || (kind === 'ingredients_inci' ? quality.ingredients_raw : null) || {};
    states[kind] = projectPublicPdpStateValue({
      state: kind === 'reviews_preview' ? (module?.data?.availability_state || 'absent') : module ? 'ready' : 'absent',
      source_url: evidence.source_url || evidence.source_ref,
      source_observed_at: evidence.source_observed_at || evidence.captured_at,
    });
  }
  return states;
}
module.exports = { publicSourceUrl, projectPublicMediaEvidence, normalizeReviewMedia,
  projectPublicPdpStateValue, projectPublicPdpStateDictionary, reviewAvailability, isSyntheticReviewSummary, buildContentModuleStates };
