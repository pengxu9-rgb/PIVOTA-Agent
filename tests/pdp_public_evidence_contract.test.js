const { buildPdpPayload } = require('../src/pdpBuilder');
const { projectPublicMediaEvidence, normalizeReviewMedia, projectPublicPdpStateDictionary,
  reviewAvailability, publicSourceUrl } = require('../src/services/pdpPublicEvidence');

const product = { product_id: 'sig_6bb6c7ae7b7e71e838aefb564c60371a',
  merchant_id: 'merch_obs_0531e02c57f00f5b', title: 'MooGoo Full Cream Moisturizer',
  source_url: 'https://moogoousa.com/products/full-cream-moisturizer',
  image_url: 'https://cdn.shopify.com/fullcream.jpg', price: { amount: 11.90, currency: 'USD' } };
const review = { review_id: 'r_123', merchant_id: product.merchant_id };
const media = { type: 'image', url: 'https://reviews.example.com/photo.jpg', role: 'customer_review',
  provenance: { source_type: 'customer_review', review_id: review.review_id, merchant_id: product.merchant_id,
    product_id: product.product_id, scope: 'exact_item', moderation_status: 'active', verification_status: 'review_linked' } };

test('official gallery remains explicitly official with zero eligible customer media', () => {
  const payload = buildPdpPayload({ product, relatedProducts: [], includeEmptyReviews: true });
  const gallery = payload.modules.find(m => m.type === 'media_gallery');
  expect(gallery.data.items[0]).toMatchObject({ role: 'official_product', provenance: {
    source_type: 'merchant_product', product_id: product.product_id, merchant_id: product.merchant_id,
  } });
  expect(payload.modules.find(m => m.type === 'reviews_preview').data.availability_state).toBe('unavailable');
  expect(payload.x_content_module_states.ingredients_inci.state).toBe('absent');
  expect(payload.x_content_module_states.reviews_preview.state).toBe('unavailable');
});

test('review media preserves only review-linked, active, scoped evidence without private payloads', () => {
  const value = normalizeReviewMedia({ ...media, provenance: { ...media.provenance,
    raw: 'secret', operator_note: 'private', source_observed_at: '2026-10-04T04:17:28Z' } }, review);
  expect(value).toMatchObject(media);
  expect(value.provenance.raw).toBeUndefined();
  expect(value.provenance.operator_note).toBeUndefined();
  expect(value.provenance.source_observed_at).toBe('2026-10-04T04:17:28Z');
  expect(normalizeReviewMedia(media, { review_id: 'wrong' }).role).toBeUndefined();
  expect(normalizeReviewMedia(media, { ...review, merchant_id: 'wrong' }).role).toBeUndefined();
  for (const change of [{ moderation_status: 'pending' }, { verification_status: 'unknown' }, { scope: 'group' }, { product_id: '' }]) {
    expect(projectPublicMediaEvidence({ ...media, provenance: { ...media.provenance, ...change } })).toBeNull();
  }
});

test('review groups and product-line scopes are never substituted for each other', () => {
  const group = projectPublicMediaEvidence({ ...media, provenance: { ...media.provenance,
    product_id: undefined, scope: 'review_group', review_group_id: '123' } });
  expect(group.provenance.scope).toBe('review_group');
  expect(group.provenance.review_family_id).toBeUndefined();
  expect(projectPublicMediaEvidence({ ...media, provenance: { ...media.provenance,
    scope: 'product_line', review_family_id: undefined } })).toBeNull();
});

test('unknown counts are not evidence of zero reviews; explicitly completed empty store is scoped', () => {
  for (const summary of [null, {}, { review_count: 0 }, { review_count: null }, { review_count: '', status: 'ready' }, { review_count: 0, status: 'unavailable' }]) {
    expect(reviewAvailability(summary)).toBe('unavailable');
  }
  expect(reviewAvailability({ review_count: 0, availability_state: 'empty', review_scope: 'linked_review_store' })).toBe('empty');
  expect(reviewAvailability({ review_count: 3, status: 'error' })).toBe('error');
  expect(reviewAvailability({ review_count: 236 })).toBe('ready');
  expect(reviewAvailability({ review_count: 236 }, true)).toBe('unavailable');
});

test('field evidence exposes actual capture time and clean source path, never a fresh synthetic timestamp or dossier', () => {
  const projected = projectPublicPdpStateDictionary({ ingredients_inci: { state: 'READY',
    source_url: 'https://merchant.example/products/cream?token=private#fragment',
    source_observed_at: '2026-10-04T04:17:28Z', generated_at: '2099-01-01T00:00:00Z',
    raw: 'secret', operator_note: 'private' } });
  expect(projected.ingredients_inci).toEqual({ state: 'READY', source_url: 'https://merchant.example/products/cream', source_observed_at: '2026-10-04T04:17:28Z' });
  expect(publicSourceUrl('javascript:alert(1)')).toBeUndefined();
  expect(publicSourceUrl('https://user:pass@merchant.example/')).toBeUndefined();
  expect(projectPublicPdpStateDictionary({ how_to_use: { state: 'absent', captured_at: '2026-10-04T04:17:28Z' } })).toEqual({ how_to_use: { state: 'absent' } });
});

test('builder retains review media contract and date without assigning proven buyer identity to legacy images', () => {
  const payload = buildPdpPayload({ product: { ...product,
    review_summary: { review_count: 2, rating: 4, preview_items: [
      { ...review, media: [media] }, { review_id: 'legacy', media: [{ type: 'image', url: product.image_url }] },
    ] } }, relatedProducts: [] });
  const data = payload.modules.find(m => m.type === 'reviews_preview').data;
  expect(data.preview_items[0].media[0]).toMatchObject(media);
  expect(data.preview_items[1].media[0].role).toBeUndefined();
});
