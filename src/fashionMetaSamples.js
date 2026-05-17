// Hand-curated `fashion_meta` / `electronics_meta` overlays for a few sample
// products. The PDP builder consults this when the upstream catalog product
// does NOT carry its own meta — so real backend-stored meta always wins.
//
// Replace the placeholder keys (`product_id`) with real catalog product_ids
// you want to demo the fashion / electronics PDP container against.

const FASHION_META_SAMPLES = {
  sample_fashion_lingerie_001: {
    size_fit_chart: {
      columns: ['Size', 'Bust', 'Underbust'],
      rows: [
        { label: 'XS', values: ['30A-30B', '64-68 cm'], stock: 'in' },
        { label: 'S', values: ['32A-32B', '68-72 cm'], stock: 'in' },
        { label: 'M', values: ['34B-34C', '72-76 cm'], stock: 'low' },
        { label: 'L', values: ['36C-36D', '76-80 cm'], stock: 'in' },
        { label: 'XL', values: ['38D-38DD', '80-84 cm'], stock: 'out' },
      ],
      note: 'Measurements taken on a flat garment; bust range matches US sizing.',
      tip: 'Between sizes? Size up — the lace gives.',
    },
    model: { info: "Model is 5'8\" wearing M", avatar_url: null },
    material: '90% recycled nylon, 10% spandex; lace trim 100% polyamide.',
    origin: 'Knit and sewn in Vietnam',
    care: 'Hand wash cold; lay flat to dry. Do not bleach.',
    styling_pairings: [
      {
        name: 'Silk Robe',
        brand: 'Glow Refinery',
        price: 38,
        img: 'https://images.pivota.ai/samples/silk-robe.jpg',
      },
      {
        name: 'Lace Garter',
        brand: 'Glow Refinery',
        price: 18,
        img: 'https://images.pivota.ai/samples/lace-garter.jpg',
      },
      {
        name: 'Linen Slip',
        brand: 'Glow Refinery',
        price: 42,
        img: 'https://images.pivota.ai/samples/linen-slip.jpg',
      },
    ],
  },
  sample_fashion_summer_dress_001: {
    size_fit_chart: {
      columns: ['Size', 'Bust', 'Waist', 'Length'],
      rows: [
        { label: 'XS', values: ['81 cm', '63 cm', '90 cm'], stock: 'in' },
        { label: 'S', values: ['86 cm', '68 cm', '91 cm'], stock: 'in' },
        { label: 'M', values: ['91 cm', '73 cm', '92 cm'], stock: 'in' },
        { label: 'L', values: ['96 cm', '78 cm', '93 cm'], stock: 'low' },
      ],
      note: 'Length measured from shoulder to hem.',
      tip: null,
    },
    model: { info: "Model is 5'10\" wearing S", avatar_url: null },
    material: '100% organic cotton; OEKO-TEX certified.',
    origin: 'Cut and sewn in Portugal',
    care: 'Machine wash cold on delicate; tumble dry low.',
    styling_pairings: [
      {
        name: 'Straw Tote',
        brand: 'Atlas & Field',
        price: 64,
        img: 'https://images.pivota.ai/samples/straw-tote.jpg',
      },
      {
        name: 'Leather Sandals',
        brand: 'Atlas & Field',
        price: 110,
        img: 'https://images.pivota.ai/samples/leather-sandals.jpg',
      },
    ],
  },
};

const ELECTRONICS_META_SAMPLES = {
  sample_electronics_macbook_air_m3: {
    configurator_groups: [
      {
        id: 'memory',
        label: 'Memory',
        options: [
          { id: 'mem_16', label: '16GB unified memory', delta: 0 },
          { id: 'mem_24', label: '24GB unified memory', delta: 200 },
        ],
      },
      {
        id: 'storage',
        label: 'Storage',
        options: [
          { id: 'ssd_256', label: '256GB SSD', delta: 0 },
          { id: 'ssd_512', label: '512GB SSD', delta: 200 },
          { id: 'ssd_1tb', label: '1TB SSD', delta: 400 },
        ],
      },
    ],
    protection_plans: [
      { id: 'none', label: 'No coverage', price: 0, sub: 'Standard 1-year limited warranty' },
      { id: 'applecare', label: 'AppleCare+ for Mac', price: 99, sub: '3 years of expert support', popular: true },
      { id: 'applecare_tl', label: 'AppleCare+ with Theft & Loss', price: 149, sub: '3 years including theft and loss' },
    ],
    pro_reviews: [
      { source: 'Wirecutter', verdict: 'Best laptop for most people', score: '4.7', url: 'https://www.nytimes.com/wirecutter/reviews/best-laptops/' },
      { source: 'The Verge', verdict: 'A near-perfect everyday Mac', score: '9.0', url: 'https://www.theverge.com/reviews/macbook-air-m3' },
    ],
    in_box: [
      'MacBook Air',
      'USB-C Charge Cable (2 m)',
      '30W USB-C Power Adapter',
      'Documentation',
    ],
    compare_with: { product_ids: [] },
    spec_groups: [
      {
        group: 'Chip',
        rows: [
          ['Chip', 'Apple M3'],
          ['CPU', '8-core'],
          ['GPU', '10-core'],
        ],
      },
      {
        group: 'Display',
        rows: [
          ['Size', '13.6-inch Liquid Retina'],
          ['Resolution', '2560 × 1664'],
          ['Brightness', '500 nits'],
        ],
      },
      {
        group: 'Battery',
        rows: [
          ['Up to', '18 hours wireless web'],
          ['Charging', '70W USB-C with optional fast-charge'],
        ],
      },
    ],
  },
  sample_electronics_wh1000xm5: {
    protection_plans: [
      { id: 'none', label: 'No coverage', price: 0, sub: 'Standard 1-year limited warranty' },
      { id: 'sq_2yr', label: 'Squaretrade 2-Year Plan', price: 39, sub: 'Covers drops and spills', popular: true },
    ],
    pro_reviews: [
      { source: 'Wirecutter', verdict: 'Top pick over-ear noise-cancelling', score: '4.6', url: 'https://www.nytimes.com/wirecutter/reviews/best-noise-cancelling-headphones/' },
    ],
    in_box: ['Headphones', 'Carrying case', 'USB-C charging cable', 'Audio cable', 'Documentation'],
    spec_groups: [
      { group: 'Battery', rows: [['Playback', 'Up to 30 hours'], ['Charging', 'USB-C, 3 min for 3 hours']] },
      { group: 'Connectivity', rows: [['Bluetooth', '5.2'], ['Codecs', 'LDAC, AAC, SBC']] },
      { group: 'Weight', rows: [['Headphones', '250 g']] },
    ],
  },
  // Real catalog product: Sony WH-1000XM5 listed on agent.pivota.cc.
  // Fields below are sourced ONLY from Sony's published spec sheet
  // (https://electronics.sony.com/audio/headphones/c/all-headphones)
  // and real, public review URLs — no fabricated values about the merchant.
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

function lookupSampleFashionMeta(productId) {
  const key = String(productId || '').trim();
  if (!key) return null;
  return FASHION_META_SAMPLES[key] || null;
}

function lookupSampleElectronicsMeta(productId) {
  const key = String(productId || '').trim();
  if (!key) return null;
  return ELECTRONICS_META_SAMPLES[key] || null;
}

function sampleFashionMetaKeys() {
  return Object.keys(FASHION_META_SAMPLES);
}

function sampleElectronicsMetaKeys() {
  return Object.keys(ELECTRONICS_META_SAMPLES);
}

module.exports = {
  FASHION_META_SAMPLES,
  ELECTRONICS_META_SAMPLES,
  lookupSampleFashionMeta,
  lookupSampleElectronicsMeta,
  sampleFashionMetaKeys,
  sampleElectronicsMetaKeys,
};
