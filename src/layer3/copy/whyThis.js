function buildWhyThis(input) {
  const { category, candidate, lookSpec } = input;
  const area = lookSpec.breakdown[category];

  const finish = area.finish;
  const coverage = area.coverage;
  const productFinish = candidate.tags.finish[0] || 'unknown finish';
  const productTexture = candidate.tags.texture[0] || candidate.tags.effect[0] || 'unknown texture';
  const productCoverage = candidate.tags.coverage[0] || 'unknown coverage';
  const keyNote = area.keyNotes?.[0];

  const whyThis = [
    `Matches the reference ${category} look with a ${finish} finish and ${coverage} coverage.`,
    `This product is tagged as ${productFinish}, ${productTexture}, and ${productCoverage}.`,
    keyNote ? `It also aligns with the reference note "${keyNote}".` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const evidence = [
    `lookSpec.breakdown.${category}.finish`,
    `lookSpec.breakdown.${category}.coverage`,
    'product.tags.finish',
    'product.tags.texture',
    'product.tags.coverage',
    'product.priceTier',
    'product.availabilityByMarket.US',
  ];
  if (keyNote) evidence.push(`lookSpec.breakdown.${category}.keyNotes[0]`);

  return { whyThis, evidence };
}

module.exports = {
  buildWhyThis,
};

