function currencyForMarket(market) {
  return market === 'JP' ? 'JPY' : 'USD';
}

function priceForMarket(market) {
  return market === 'JP' ? 3200 : 32;
}

function breakdownForLocale(locale) {
  if (locale === 'ja') {
    return {
      base: [
        { label: '質感', value: 'セミマット' },
        { label: '仕上げ', value: '薄く重ねて密着' },
      ],
      eye: [
        { label: 'トーン', value: 'ソフトブラウン' },
        { label: '形', value: '目尻を少し長めに' },
      ],
      lip: [
        { label: '色', value: 'ローズベージュ' },
        { label: '質感', value: '透け感' },
      ],
    };
  }

  return {
    base: [
      { label: 'Finish', value: 'Soft-matte' },
      { label: 'Application', value: 'Thin layers, well blended' },
    ],
    eye: [
      { label: 'Tone', value: 'Soft brown' },
      { label: 'Shape', value: 'Slightly lifted outer corner' },
    ],
    lip: [
      { label: 'Shade', value: 'Rose beige' },
      { label: 'Finish', value: 'Sheer' },
    ],
  };
}

function adjustmentsForLocale(locale) {
  if (locale === 'ja') {
    return [
      {
        id: 'adj-1',
        label: 'ベース',
        description: '厚塗りにしない。スポンジで境目をしっかりぼかす。',
        applied: false,
      },
      {
        id: 'adj-2',
        label: 'アイ',
        description: '締め色は控えめ。ラメは黒目上に少量。',
        applied: false,
      },
      {
        id: 'adj-3',
        label: 'リップ',
        description: '輪郭をぼかす。中心だけ濃くして立体感を出す。',
        applied: false,
      },
    ];
  }

  return [
    {
      id: 'adj-1',
      label: 'Base',
      description: 'Avoid heavy layers. Blend edges with a damp sponge.',
      applied: false,
    },
    {
      id: 'adj-2',
      label: 'Eyes',
      description: 'Keep the deepest shade minimal. Add shimmer only on the center.',
      applied: false,
    },
    {
      id: 'adj-3',
      label: 'Lips',
      description: 'Blur the lip line. Concentrate color in the center.',
      applied: false,
    },
  ];
}

function makeSku({ skuId, name, brand, price, currency }) {
  return {
    skuId,
    name,
    brand,
    shade: '',
    price,
    currency,
    imageUrl: '',
    productUrl: '',
    inStock: true,
  };
}

function makeKit(market) {
  const currency = currencyForMarket(market);
  const price = priceForMarket(market);
  return {
    base: {
      best: makeSku({ skuId: 'sku_base_best', name: 'Base Best', brand: 'Pivota', price, currency }),
      dupe: makeSku({ skuId: 'sku_base_dupe', name: 'Base Dupe', brand: 'Pivota', price: Math.max(1, price - 8), currency }),
    },
    eye: {
      best: makeSku({ skuId: 'sku_eye_best', name: 'Eye Best', brand: 'Pivota', price, currency }),
      dupe: makeSku({ skuId: 'sku_eye_dupe', name: 'Eye Dupe', brand: 'Pivota', price: Math.max(1, price - 10), currency }),
    },
    lip: {
      best: makeSku({ skuId: 'sku_lip_best', name: 'Lip Best', brand: 'Pivota', price, currency }),
      dupe: makeSku({ skuId: 'sku_lip_dupe', name: 'Lip Dupe', brand: 'Pivota', price: Math.max(1, price - 12), currency }),
    },
  };
}

function makeMockLookResult({ shareId, market, locale }) {
  return {
    undertone: 'neutral',
    breakdown: breakdownForLocale(locale),
    adjustments: adjustmentsForLocale(locale),
    kit: makeKit(market),
    shareId,
    warnings: ['MOCK_RESULT'],
  };
}

module.exports = {
  makeMockLookResult,
};

