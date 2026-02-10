const ISSUE_LABELS_ZH = Object.freeze({
  redness: '泛红',
  shine: '出油',
  texture: '肤感粗糙',
  tone: '肤色不均',
  acne: '易长痘区域',
});

const TEMPLATES_ZH = Object.freeze({
  ingredient_why: Object.freeze({
    redness: Object.freeze({
      key: 'ingredient_why_redness_zh_v1',
      text: '{ingredient_name}可帮助改善高亮区域的泛红外观，并支持肌肤舒适度。',
    }),
    shine: Object.freeze({
      key: 'ingredient_why_shine_zh_v1',
      text: '{ingredient_name}可帮助改善高亮区域的出油外观表现。',
    }),
    texture: Object.freeze({
      key: 'ingredient_why_texture_zh_v1',
      text: '{ingredient_name}可帮助改善高亮区域的肤感粗糙外观。',
    }),
    tone: Object.freeze({
      key: 'ingredient_why_tone_zh_v1',
      text: '{ingredient_name}可帮助改善高亮区域的肤色不均外观。',
    }),
    acne: Object.freeze({
      key: 'ingredient_why_acne_zh_v1',
      text: '{ingredient_name}可帮助改善高亮区域易长痘部位的外观状态。',
    }),
  }),
  product_why_match: Object.freeze({
    redness: Object.freeze({
      key: 'product_why_redness_zh_v1',
      text: '含{ingredient_name}；可帮助改善高亮区域的泛红外观。',
    }),
    shine: Object.freeze({
      key: 'product_why_shine_zh_v1',
      text: '含{ingredient_name}；可帮助改善高亮区域的出油外观。',
    }),
    texture: Object.freeze({
      key: 'product_why_texture_zh_v1',
      text: '含{ingredient_name}；可帮助改善高亮区域的肤感粗糙外观。',
    }),
    tone: Object.freeze({
      key: 'product_why_tone_zh_v1',
      text: '含{ingredient_name}；可帮助改善高亮区域的肤色不均外观。',
    }),
    acne: Object.freeze({
      key: 'product_why_acne_zh_v1',
      text: '含{ingredient_name}；可帮助改善高亮区域易长痘部位的外观。',
    }),
  }),
  module_explanation_short: Object.freeze({
    redness: Object.freeze({
      key: 'module_explain_redness_zh_v1',
      text: '高亮区域提示{module_label}存在泛红相关外观信号。',
    }),
    shine: Object.freeze({
      key: 'module_explain_shine_zh_v1',
      text: '高亮区域提示{module_label}存在出油相关外观信号。',
    }),
    texture: Object.freeze({
      key: 'module_explain_texture_zh_v1',
      text: '高亮区域提示{module_label}存在肤感粗糙相关外观信号。',
    }),
    tone: Object.freeze({
      key: 'module_explain_tone_zh_v1',
      text: '高亮区域提示{module_label}存在肤色不均相关外观信号。',
    }),
    acne: Object.freeze({
      key: 'module_explain_acne_zh_v1',
      text: '高亮区域提示{module_label}存在易长痘相关外观信号。',
    }),
  }),
  how_to_use: Object.freeze({
    conservative: Object.freeze({
      key: 'how_to_use_conservative_zh_v1',
      text: '建议从低频开始，皮肤状态稳定后再谨慎调整。',
    }),
  }),
  generic_safe: Object.freeze({
    default: Object.freeze({
      key: 'generic_safe_zh_v1',
      text: '基于高亮区域，此步骤仅用于支持肌肤外观稳定与舒适。',
    }),
  }),
});

module.exports = {
  ISSUE_LABELS_ZH,
  TEMPLATES_ZH,
};
