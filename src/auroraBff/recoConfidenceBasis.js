'use strict';

// WHAT THE CONFIDENCE NUMBERS ON AN ANSWER ARE MADE OF, as a function of which path produced it.
//
// Only `llm_primary` produces a confidence at all — the model's own self-report. Both catalog paths
// carry `score: Math.max(72, 95 - index * 3)`, which is the item's POSITION, plus a hard-coded
// top-level 0.9 (0.62 for the transient fallback). With a shortlist of six, 95 - 3i never drops
// below 80, so every catalog item bands to the top band whatever it is and whatever was asked for.
//
// A pure mapping in its own module because it is the ONE place the answer-path -> basis question is
// decided, and because a mapping embedded in a 40k-line engine is a mapping nobody can test.
const RECO_CONFIDENCE_BASIS = {
  MODEL_SELF_REPORT: 'model_self_report',
  POSITIONAL: 'positional',
  NONE: 'none',
};

const POSITIONAL_SOURCES = new Set(['catalog_grounded', 'catalog_transient_fallback']);

function deriveRecoConfidenceBasis(structuredSource) {
  const source = String(structuredSource || '').trim().toLowerCase();
  if (source === 'llm_primary') return RECO_CONFIDENCE_BASIS.MODEL_SELF_REPORT;
  // BOTH catalog paths, not just the grounded one. The transient fallback hard-codes 0.62 and a
  // `90 - 2*index` score over a FIXED product list that does not depend on the need at all, which is
  // the least defensible confidence of the three.
  if (POSITIONAL_SOURCES.has(source)) return RECO_CONFIDENCE_BASIS.POSITIONAL;
  return RECO_CONFIDENCE_BASIS.NONE;
}

module.exports = { RECO_CONFIDENCE_BASIS, deriveRecoConfidenceBasis };
