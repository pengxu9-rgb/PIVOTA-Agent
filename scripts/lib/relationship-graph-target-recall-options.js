'use strict';

const { normalizeTargetRecallOptions } = require('../../src/auroraBff/productRelationshipGraphTargetRecall');

function parseTargetRecallOptions({ hasFlag, argValue }) {
  return { expandTargetRecall: hasFlag('expand-target-recall'),
    targetRecallOptions: normalizeTargetRecallOptions({
      maxAnchors: argValue('target-recall-max-anchors'),
      batchSize: argValue('target-recall-batch-size'),
      perAnchor: argValue('target-recall-per-anchor'),
      maxCandidates: argValue('target-recall-max-candidates'),
      maxPages: argValue('target-recall-max-pages'),
    }) };
}

function appendTargetRecallArgs(args, options) {
  if (!options.expandTargetRecall) return;
  args.push('--expand-target-recall');
  const caps = normalizeTargetRecallOptions(options.targetRecallOptions);
  for (const [flag, key] of [['max-anchors', 'maxAnchors'], ['batch-size', 'batchSize'],
    ['per-anchor', 'perAnchor'], ['max-candidates', 'maxCandidates'], ['max-pages', 'maxPages']]) {
    args.push(`--target-recall-${flag}`, String(caps[key]));
  }
}

module.exports = { parseTargetRecallOptions, appendTargetRecallArgs };
