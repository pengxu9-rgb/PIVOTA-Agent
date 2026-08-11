// Curated PDP meta overrides — an EXPLICIT, provenance-required registry.
//
// History (fabrication-belt F3, 2026-08-11): this file was `fashionMetaSamples.js`
// — "sample" overlays for demo product ids (fabricated size charts, materials,
// styling pairings for a fictional brand) sitting next to one hand-curated entry
// for a REAL live product. Content that looks pipeline-derived but is hand-written
// in gateway source is exactly the class of hazard the catalog-identity work
// exists to eliminate, so the rules are now structural:
//
//   1. Every entry is keyed by a REAL catalog id (sig_*). Demo `sample_*` ids are
//      deleted and forbidden (tests/curated_pdp_meta.test.js).
//   2. Every entry MUST have a CURATED_PROVENANCE record naming its public
//      sources. No sources, no entry.
//   3. Backend/catalog-stored meta always wins — pdpBuilder consults this ONLY
//      when the upstream product carries no meta of its own. When the catalog
//      pipeline learns to carry electronics_meta, migrate these entries there
//      and delete this file.
//   4. Nothing here may state a fact about the MERCHANT (pricing, warranties,
//      stock); only manufacturer-published product facts and public reviews.

const CURATED_FASHION_META = {
  // Intentionally empty. The previous `sample_fashion_*` entries were fabricated
  // demo garments; real fashion meta arrives via the Shopify metafield pipeline.
};

const CURATED_ELECTRONICS_META = {
  // Real catalog product: Sony WH-1000XM5 listed on agent.pivota.cc.
  // Fields below are sourced ONLY from Sony's published spec sheet and real,
  // public review URLs — no fabricated values about the merchant.
  // Intentionally omitted: protection_plans (merchant doesn't sell extended
  // warranties on this SKU; advertising them would breach the one-click
  // promise) and configurator_groups (headphones have no memory/storage tiers).
  sig_c08b9e75f8c297dbe23795f2b22d1214: {
    in_box: [
      'WH-1000XM5 headphones',
      'Carrying case',
      'USB-C charging cable',
      'Audio cable (3.5mm)',
      'Documentation',
    ],
    pro_reviews: [
      {
        source: 'Wirecutter',
        verdict: 'Top pick — best premium wireless noise-cancelling headphones',
        score: '4.6',
        url: 'https://www.nytimes.com/wirecutter/reviews/best-noise-cancelling-headphones/',
      },
      {
        source: 'The Verge',
        verdict: 'Excellent noise cancellation and call quality',
        score: '8.5',
        url: 'https://www.theverge.com/23310129/sony-wh-1000xm5-wireless-headphones-review',
      },
    ],
    spec_groups: [
      {
        group: 'Audio',
        rows: [
          ['Driver', '30 mm, dome type'],
          ['Frequency response', '4 Hz – 40,000 Hz (LDAC, 96 kHz / 990 kbps)'],
          ['Hi-Res Audio', 'Yes (LDAC)'],
        ],
      },
      {
        group: 'Noise cancelling',
        rows: [
          ['Processors', 'Integrated Processor V1 + HD Noise Cancelling Processor QN1'],
          ['Microphones', '8 (4 per side) for ANC + voice'],
        ],
      },
      {
        group: 'Battery',
        rows: [
          ['Playback (ANC on)', 'Up to 30 hours'],
          ['Playback (ANC off)', 'Up to 40 hours'],
          ['Quick charge', '3 hours playback from 3 min charge'],
        ],
      },
      {
        group: 'Connectivity',
        rows: [
          ['Bluetooth', '5.2'],
          ['Codecs', 'LDAC, AAC, SBC'],
          ['Multi-point', 'Yes (2 devices)'],
          ['Charging port', 'USB Type-C'],
        ],
      },
      {
        group: 'Physical',
        rows: [
          ['Weight', '250 g'],
        ],
      },
    ],
  },
};

// Rule 2: sources for every curated entry. The test suite fails any entry
// missing from this registry or lacking an https source.
const CURATED_PROVENANCE = {
  sig_c08b9e75f8c297dbe23795f2b22d1214: {
    product: 'Sony WH-1000XM5 (real catalog product on agent.pivota.cc)',
    curated: '2026 (carried over from fashionMetaSamples.js; provenance predates this file)',
    sources: [
      'https://electronics.sony.com/audio/headphones/c/all-headphones',
      'https://www.nytimes.com/wirecutter/reviews/best-noise-cancelling-headphones/',
      'https://www.theverge.com/23310129/sony-wh-1000xm5-wireless-headphones-review',
    ],
  },
};

function lookupCuratedFashionMeta(productId) {
  const key = String(productId || '').trim();
  if (!key) return null;
  return CURATED_FASHION_META[key] || null;
}

function lookupCuratedElectronicsMeta(productId) {
  const key = String(productId || '').trim();
  if (!key) return null;
  return CURATED_ELECTRONICS_META[key] || null;
}

module.exports = {
  CURATED_FASHION_META,
  CURATED_ELECTRONICS_META,
  CURATED_PROVENANCE,
  lookupCuratedFashionMeta,
  lookupCuratedElectronicsMeta,
};
