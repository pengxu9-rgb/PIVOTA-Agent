const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function helpersPath() {
  return path.join(__dirname, '..', 'scripts', 'internal_batch_helpers.mjs');
}

async function loadHelpers() {
  return import(pathToFileURL(helpersPath()).href);
}

test('internal batch parser: extracts photo_modules/actions/products/evidence/claims summary', async () => {
  const { summarizeAnalysisEnvelope } = await loadHelpers();

  const envelope = {
    request_id: 'req_parse_1',
    trace_id: 'trace_parse_1',
    cards: [
      {
        type: 'analysis_summary',
        payload: {
          used_photos: true,
          analysis_source: 'vision_gemini',
          quality_report: { photo_quality: { grade: 'pass' } },
        },
      },
      {
        type: 'photo_modules_v1',
        payload: {
          quality_grade: 'pass',
          face_crop: {
            coord_space: 'orig_px_v1',
            bbox_px: { x: 1, y: 2, w: 3, h: 4 },
          },
          regions: [
            { type: 'bbox' },
            { type: 'polygon' },
            { type: 'heatmap' },
          ],
          modules: [
            {
              module_id: 'forehead',
              issues: [
                {
                  issue_type: 'redness',
                  severity_0_4: 3.7,
                  confidence_0_1: 0.91,
                  explanation_template_fallback: true,
                  explanation_template_reason: 'template_missing',
                },
                {
                  issue_type: 'tone',
                  severity_0_4: 2.1,
                  confidence_0_1: 0.62,
                  explanation_template_fallback: false,
                  explanation_template_reason: 'banned_terms',
                },
              ],
              actions: [
                {
                  evidence_grade: 'B',
                  citations_count: 2,
                  why_template_fallback: false,
                  why_template_reason: 'ok',
                },
              ],
              products: [
                {
                  why_match_template_fallback: true,
                  why_match_template_reason: 'template_missing',
                  evidence: {
                    evidence_grade: 'A',
                    citation_ids: ['c1', 'c2'],
                  },
                },
              ],
              internal_debug: {
                product_suppressed_reason: 'LOW_EVIDENCE',
              },
            },
            {
              module_id: 'chin',
              issues: [
                {
                  issue_type: 'texture',
                  severity_0_4: 1.2,
                  confidence_0_1: 0.4,
                  explanation_template_fallback: false,
                  explanation_template_reason: 'ok',
                },
              ],
              actions: [],
              products: [],
            },
          ],
        },
      },
    ],
  };

  const summary = summarizeAnalysisEnvelope(envelope);

  assert.equal(summary.request_id, 'req_parse_1');
  assert.equal(summary.trace_id, 'trace_parse_1');
  assert.equal(summary.has_analysis_card, true);
  assert.equal(summary.has_photo_modules_card, true);
  assert.equal(summary.used_photos, true);
  assert.equal(summary.analysis_source, 'vision_gemini');
  assert.equal(summary.quality_grade, 'pass');

  assert.equal(summary.regions_count, 3);
  assert.equal(summary.regions_bbox_count, 1);
  assert.equal(summary.regions_polygon_count, 1);
  assert.equal(summary.regions_heatmap_count, 1);

  assert.equal(summary.modules_count, 2);
  assert.equal(summary.actions_count, 1);
  assert.equal(summary.products_count, 1);

  assert.ok(Array.isArray(summary.issues_top));
  assert.equal(summary.issues_top[0].module_id, 'forehead');
  assert.equal(summary.issues_top[0].issue_type, 'redness');

  assert.deepEqual({ ...summary.evidence_grade_distribution }, { B: 1, A: 1 });
  assert.deepEqual({ ...summary.citations_count_distribution }, { 2: 2 });

  assert.equal(summary.claims_audit_known, true);
  assert.equal(summary.claims_template_fallback_count, 2);
  assert.equal(summary.claims_violation_detected, true);
  assert.equal(summary.claims_template_fallback_reasons.template_missing, 2);
  assert.equal(summary.claims_violation_reasons.banned_terms, 1);

  assert.deepEqual(summary.product_suppression_reasons, ['LOW_EVIDENCE']);
});

test('internal batch parser: graceful unknown for missing claims fields and missing photo_modules card', async () => {
  const { summarizeAnalysisEnvelope } = await loadHelpers();

  const envelope = {
    data: {
      request_id: 'req_parse_2',
      trace_id: 'trace_parse_2',
      cards: [
        {
          type: 'analysis_summary',
          payload: {
            used_photos: false,
            analysis_source: 'rule_based_with_photo_qc',
          },
        },
      ],
    },
  };

  const summary = summarizeAnalysisEnvelope(envelope);

  assert.equal(summary.request_id, 'req_parse_2');
  assert.equal(summary.trace_id, 'trace_parse_2');
  assert.equal(summary.has_analysis_card, true);
  assert.equal(summary.has_photo_modules_card, false);
  assert.equal(summary.claims_audit_known, false);
  assert.equal(summary.claims_template_fallback_count, 'unknown');
  assert.equal(summary.claims_violation_detected, 'unknown');
  assert.equal(summary.actions_count, 0);
  assert.equal(summary.products_count, 0);
});

test('internal batch parser: output does not expose raw bbox_px', async () => {
  const { summarizeAnalysisEnvelope } = await loadHelpers();

  const envelope = {
    request_id: 'req_parse_3',
    trace_id: 'trace_parse_3',
    cards: [
      {
        type: 'analysis_summary',
        payload: {
          used_photos: true,
          analysis_source: 'vision_gemini',
        },
      },
      {
        type: 'photo_modules_v1',
        payload: {
          face_crop: {
            bbox_px: { x: 10, y: 20, w: 30, h: 40 },
          },
          regions: [],
          modules: [],
        },
      },
    ],
  };

  const summary = summarizeAnalysisEnvelope(envelope);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('bbox_px'), false);
  assert.equal(serialized.includes('"x":10'), false);
});
