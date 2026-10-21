'use strict';

// Every word and shape the retinoid safety lexicon (src/services/retinoidSafetySignal.js) must
// catch, shared by the unit suite and the invoke-route suite so the two can never drift apart.

const HARD = {
  pregnancy_lactation_fertility: [
    'pregnant', 'pregnancy safe', 'preggo', 'preggers', 'mom to be', 'mom-to-be', 'maternity', 'bun in the oven',
    'obgyn approved', 'ob-gyn approved', 'first trimester', 'trimester', 'ivf', 'fertility', 'trying to conceive', 'ttc',
    'conceiving', 'expecting', 'new mom', 'bf mom', 'pumping', 'for moms', 'postpartum', 'post partum', 'breastfeeding',
    'breast feeding', 'breastfed baby', 'nursing', 'lactating', 'lactation',
    // typos
    'pregnacy', 'pregancy', 'preganant', 'pregnent', 'breastfeding', 'pregnanat', 'pergnant',
    // other scripts and emoji
    '임산부', '임신', '수유', 'беременность', 'для беременных', 'ตั้งครรภ์', '🤰', '🤰🏽', '🤱', '🫃',
    // Latin-script languages
    'embarazada', 'lactancia', 'enceinte', 'allaitement', 'schwanger', 'schwangerschaft', 'stillzeit', 'gravidanza', 'incinta',
    'grávida', 'gestante', 'amamentação', 'hamil', 'mang thai', 'gebelik', 'zwanger',
    // Japanese / Chinese
    '妊婦', '妊活', '産後', '産婦', '妊娠中', '授乳中', '孕妇', '孕期', '哺乳期', '坐月子', '月子', '产后', '產後', '宝妈',
    // obfuscation
    'pre-gnant', 'p r e g n a n t', 'p.r.e.g.n.a.n.t', 'рrеgnаnt', 'prеgnant', 'preg\u200Bnant', 'preg\u00ADnant',
    '#momtobe', '#pregnant', '#PregnancySkincare', 'ＰＲＥＧＮＡＮＴ', 'PREGNANT', 'b r e a s t f e e d i n g', 'p r e g n e n t', 'i v f', 'o b g y n', '임\u200B산부', '임\u{E0020}산부', '妊\u200C婦', 'pr3gn4nt', 'pregn4nt', 'ᴘʀᴇɢɴᴀɴᴛ', '𝐩𝐫𝐞𝐠𝐧𝐚𝐧𝐭', 'ⓟⓡⓔⓖⓝⓐⓝⓣ', 'p\u0336r\u0336e\u0336g\u0336n\u0336a\u0336n\u0336t\u0336',
    'preg\u{E0020}nant', 'pregnant%20', 'embarazo', 'gestação', 'knocked up', 'eating for two', 'with child', '임부', '출산',
    'кормление грудью', 'गर्भवती', 'حامل', 'マタニティ', '喂奶', '母乳', 'mang bầu',
  ],
  child_under_12: [
    'for kids', 'kid', 'kiddo', 'child', 'children', 'infant', 'toddler', 'newborn', 'baby', 'babies', '👶',
    'for 9 year old', 'for my 8 year old', '8yo', '10 y/o', 'age 9', 'aged 11', 'my 10-year-old', 'six year old',
    '6 month old', 'niños', 'enfant', 'my son is 10', 'daughter who is nine', 'elementary school', '🍼',
    '宝宝', '婴儿', '儿童', '小孩', '孩子', '赤ちゃん', '子供', '10岁',
  ],
  isotretinoin_layering: [
    'on accutane', 'accutane', 'roaccutane', 'isotretinoin', 'on isotretinoin', 'on tretinoin', 'using tretinoin',
    'on adapalene', 'prescribed tretinoin', 'acutane', 'isotretinion', 'accu-tane', 'iso tretinoin', 'i use tretinoin at night',
  ],
};

// Distant negations: these gate only when the same text also names a retinoid.
const HARD_NEGATION_PHRASES = [
  "don't want", 'do not want', 'dont want', "can't use", 'cannot use', "can't tolerate", 'cannot tolerate', 'anything but',
  'never', 'stop using', 'stopped', 'quit', 'no more', 'no thanks', 'not for me', 'hate', 'i react to',
  'gives me rash', 'gives me a rash', 'broke me out', 'breaks me out', 'allergic to', 'sans', 'free', '0%',
  "aren't for me", "isn't for me", 'nope', 'skip', 'w/o', 'ditch',
];

const SOFT = {
  teen_12_17: [
    'teen', 'teens', 'middle school', 'teenager', 'teenage acne', 'tween', 'minors', 'junior', 'student', 'high school',
    '13yo', '15 year old', 'age 16', 'aged 12', 'seventeen year old', '青少年', '学生', '16岁',
  ],
  skin_condition: [
    'redness', 'very dry', 'thin skin', 'psoriasis', 'sunburn', 'sunburned', 'post procedure', 'post-procedure',
    'broken skin', 'inflamed', 'itchy', 'flaky', 'atopic', 'stinging', 'peeling', 'dermatitis', 'eczema', 'rosacea',
    'reactive', 'allergic', 'intolerance', '过敏', '泛红', '皮炎', '湿疹', '玫瑰痤疮',
  ],
  sensitivity: ['sensitive', 'sensitive skin', 'sensitized', 'sensitised', '敏感肌'],
};

// No signal at all: every one of these must stay exactly as on main.
const NEUTRAL = [
  'moisturizer', 'retinol serum', 'retinol cream', 'retinol', 'night cream', 'serum', 'acne treatment', 'acne cleanser',
  'sunscreen spf 50', 'for 18 year old', 'for my 18 year old', '25 year old skin', 'age 30', 'gift for mom',
  'mother of pearl highlighter', '10% niacinamide + retinol', '0.3% retinol serum', 'retinol 1%', 'used retinol for 2 years',
  'anti aging serum', 'lip balm', 'red lipstick', 'kidney bean mask', 'skincare', 'expectation', 'nurse shark',
  'ammonium lactate lotion', 'lactic acid serum', 'hydrating toner', 'spf 30',
];

module.exports = { HARD, HARD_NEGATION_PHRASES, SOFT, NEUTRAL };
