const ISSUE_LABELS_EN = Object.freeze({
  redness: 'visible redness',
  shine: 'excess shine',
  texture: 'uneven texture',
  tone: 'uneven tone',
  acne: 'blemish-prone areas',
});

const TEMPLATES_EN = Object.freeze({
  ingredient_why: Object.freeze({
    redness: Object.freeze({
      key: 'ingredient_why_redness_en_v1',
      text: '{ingredient_name} supports skin comfort and helps reduce the appearance of redness in highlighted areas.',
    }),
    shine: Object.freeze({
      key: 'ingredient_why_shine_en_v1',
      text: '{ingredient_name} helps improve the appearance of excess shine in highlighted areas.',
    }),
    texture: Object.freeze({
      key: 'ingredient_why_texture_en_v1',
      text: '{ingredient_name} helps improve the appearance of uneven texture in highlighted areas.',
    }),
    tone: Object.freeze({
      key: 'ingredient_why_tone_en_v1',
      text: '{ingredient_name} helps improve the appearance of uneven tone in highlighted areas.',
    }),
    acne: Object.freeze({
      key: 'ingredient_why_acne_en_v1',
      text: '{ingredient_name} supports a clearer-looking appearance in blemish-prone highlighted areas.',
    }),
  }),
  product_why_match: Object.freeze({
    redness: Object.freeze({
      key: 'product_why_redness_en_v1',
      text: 'Contains {ingredient_name}; helps improve the appearance of redness in highlighted areas.',
    }),
    shine: Object.freeze({
      key: 'product_why_shine_en_v1',
      text: 'Contains {ingredient_name}; helps improve the appearance of excess shine in highlighted areas.',
    }),
    texture: Object.freeze({
      key: 'product_why_texture_en_v1',
      text: 'Contains {ingredient_name}; helps improve the appearance of uneven texture in highlighted areas.',
    }),
    tone: Object.freeze({
      key: 'product_why_tone_en_v1',
      text: 'Contains {ingredient_name}; helps improve the appearance of uneven tone in highlighted areas.',
    }),
    acne: Object.freeze({
      key: 'product_why_acne_en_v1',
      text: 'Contains {ingredient_name}; supports a clearer-looking appearance in blemish-prone highlighted areas.',
    }),
  }),
  module_explanation_short: Object.freeze({
    redness: Object.freeze({
      key: 'module_explain_redness_en_v1',
      text: 'Highlighted areas suggest visible redness signals in the {module_label} area.',
    }),
    shine: Object.freeze({
      key: 'module_explain_shine_en_v1',
      text: 'Highlighted areas suggest excess shine signals in the {module_label} area.',
    }),
    texture: Object.freeze({
      key: 'module_explain_texture_en_v1',
      text: 'Highlighted areas suggest uneven texture signals in the {module_label} area.',
    }),
    tone: Object.freeze({
      key: 'module_explain_tone_en_v1',
      text: 'Highlighted areas suggest uneven tone signals in the {module_label} area.',
    }),
    acne: Object.freeze({
      key: 'module_explain_acne_en_v1',
      text: 'Highlighted areas suggest blemish-prone signals in the {module_label} area.',
    }),
  }),
  how_to_use: Object.freeze({
    conservative: Object.freeze({
      key: 'how_to_use_conservative_en_v1',
      text: 'Start low and slow, then adjust only if your skin stays comfortable.',
    }),
  }),
  generic_safe: Object.freeze({
    default: Object.freeze({
      key: 'generic_safe_en_v1',
      text: 'Based on highlighted areas, this step supports cosmetic skin comfort and visible balance.',
    }),
  }),
});

module.exports = {
  ISSUE_LABELS_EN,
  TEMPLATES_EN,
};
