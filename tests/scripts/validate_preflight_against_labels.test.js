const { runValidation } = require('../../scripts/validate-preflight-against-labels');

// Build a fake queryFn that responds to the two SELECTs the script issues:
// 1. SELECT ... FROM relationship_candidate_labels WHERE ...
// 2. SELECT * FROM product_beauty_attributes WHERE product_key = ANY(...)
function makeQueryFn({ labels = [], attributesByKey = {} } = {}) {
  return jest.fn(async (sql, params) => {
    if (/FROM relationship_candidate_labels/.test(sql)) {
      return { rows: labels };
    }
    if (/FROM product_beauty_attributes/.test(sql)) {
      const requestedKeys = Array.isArray(params?.[0]) ? params[0] : [];
      const rows = requestedKeys
        .map((k) => attributesByKey[k])
        .filter(Boolean);
      return { rows };
    }
    return { rows: [] };
  });
}

function pba(overrides = {}) {
  return {
    product_form: 'serum',
    product_form_confidence: 0.95,
    target_area: 'face',
    target_area_confidence: 0.95,
    spf_or_otc_flag: 'cosmetic',
    spf_or_otc_flag_confidence: 0.95,
    audit_status: 'pending',
    ...overrides,
  };
}

describe('validate-preflight-against-labels', () => {
  test('approved candidate that matches on all attributes is counted TP', async () => {
    const queryFn = makeQueryFn({
      labels: [{
        id: 'lbl_1',
        anchor_type: 'product',
        anchor_ref: 'product:ext_anchor',
        candidate_product_ref: 'product:ext_cand',
        relation_type: 'competitive_alternative',
        label_state: 'human_approved',
        market: 'US',
      }],
      attributesByKey: {
        ext_anchor: { product_key: 'ext_anchor', ...pba() },
        ext_cand: { product_key: 'ext_cand', ...pba() },
      },
    });
    const r = await runValidation({ queryFn });
    expect(r.confusion_matrix).toEqual({ TP: 1, FP: 0, TN: 0, FN: 0, skipped: 0 });
    expect(r.metrics.approved_pass_rate).toBe(1);
  });

  test('rejected candidate with category_leaf + target_area mismatch is counted TN', async () => {
    const queryFn = makeQueryFn({
      labels: [{
        id: 'lbl_2',
        anchor_type: 'product',
        anchor_ref: 'product:ext_a',
        candidate_product_ref: 'product:ext_b',
        relation_type: 'competitive_alternative',
        label_state: 'human_rejected',
        market: 'US',
      }],
      attributesByKey: {
        ext_a: { product_key: 'ext_a', ...pba({ product_form: 'lipstick', category_leaf: 'matte_lipstick', category_leaf_confidence: 0.95, target_area: 'lips' }) },
        ext_b: { product_key: 'ext_b', ...pba({ product_form: 'foundation', category_leaf: 'powder_foundation', category_leaf_confidence: 0.95, target_area: 'face' }) },
      },
    });
    const r = await runValidation({ queryFn });
    expect(r.confusion_matrix.TN).toBe(1);
    expect(r.metrics.rejected_catch_rate).toBe(1);
    expect(r.failure_reason_top_codes.category_leaf_mismatch).toBe(1);
    expect(r.failure_reason_top_codes.target_area_mismatch).toBe(1);
  });

  test('approved candidate that fails a gate is counted FP (gates too aggressive)', async () => {
    const queryFn = makeQueryFn({
      labels: [{
        id: 'lbl_fp',
        anchor_type: 'product',
        anchor_ref: 'product:ext_a',
        candidate_product_ref: 'product:ext_b',
        relation_type: 'competitive_alternative',
        label_state: 'human_approved',
        market: 'US',
      }],
      attributesByKey: {
        // Distinct category_leaves with no shared token AND distinct product_forms
        // (so the category gate's same-form fallback does not rescue) → gate fires.
        ext_a: { product_key: 'ext_a', ...pba({ product_form: 'serum', category_leaf: 'serum', category_leaf_confidence: 0.95 }) },
        ext_b: { product_key: 'ext_b', ...pba({ product_form: 'lipstick', category_leaf: 'lipstick', category_leaf_confidence: 0.95 }) },
      },
    });
    const r = await runValidation({ queryFn });
    expect(r.confusion_matrix.FP).toBe(1);
    expect(r.metrics.approved_pass_rate).toBe(0);
  });

  test('rejected candidate that gates miss is counted FN', async () => {
    const queryFn = makeQueryFn({
      labels: [{
        id: 'lbl_fn',
        anchor_type: 'product',
        anchor_ref: 'product:ext_a',
        candidate_product_ref: 'product:ext_b',
        relation_type: 'competitive_alternative',
        label_state: 'human_rejected',
        market: 'US',
      }],
      attributesByKey: {
        ext_a: { product_key: 'ext_a', ...pba() },
        ext_b: { product_key: 'ext_b', ...pba() },
      },
    });
    const r = await runValidation({ queryFn });
    expect(r.confusion_matrix.FN).toBe(1);
    expect(r.metrics.rejected_catch_rate).toBe(0);
  });

  test('missing attributes count toward coverage stats and skip gating', async () => {
    const queryFn = makeQueryFn({
      labels: [
        { id: 'a', anchor_type: 'product', anchor_ref: 'product:ext_a', candidate_product_ref: 'product:ext_b', relation_type: 'dupe', label_state: 'human_approved', market: 'US' },
        { id: 'b', anchor_type: 'product', anchor_ref: 'product:ext_c', candidate_product_ref: 'product:ext_d', relation_type: 'dupe', label_state: 'human_approved', market: 'US' },
      ],
      attributesByKey: {
        ext_a: { product_key: 'ext_a', ...pba() },
        // ext_b missing
        // ext_c, ext_d both missing
      },
    });
    const r = await runValidation({ queryFn });
    expect(r.attribute_coverage.both_attrs_present).toBe(0);
    expect(r.attribute_coverage.one_missing).toBe(1);
    expect(r.attribute_coverage.both_missing).toBe(1);
    // Both rows pass through because gates can't fire with missing data
    expect(r.confusion_matrix.TP).toBe(2);
    expect(r.confusion_matrix.FP).toBe(0);
  });

  test('label_states outside approved/rejected go to skipped bucket', async () => {
    const queryFn = makeQueryFn({
      labels: [
        { id: 'pending_row', anchor_type: 'product', anchor_ref: 'product:ext_a', candidate_product_ref: 'product:ext_b', relation_type: 'dupe', label_state: 'needs_evidence', market: 'US' },
      ],
      attributesByKey: {},
    });
    const r = await runValidation({ queryFn });
    expect(r.confusion_matrix.skipped).toBe(1);
    expect(r.confusion_matrix.TP + r.confusion_matrix.FP + r.confusion_matrix.TN + r.confusion_matrix.FN).toBe(0);
  });
});
