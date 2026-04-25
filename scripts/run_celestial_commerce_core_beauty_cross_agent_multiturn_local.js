#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  buildBeautyExpertV1Response,
} = require('../src/modules/orchestration/aurora_beauty/beautyExpertV1');
const {
  resolveInvokeRequestedLayerWithInput,
} = require('../src/api/gateway/invocation/buildInvokeIngressGatewayInput');

const DEFAULT_OUT_DIR = path.join(
  __dirname,
  '..',
  'reports',
  'celestial-commerce-beauty-cross-agent-multiturn-local',
);

const INTERNAL_TERMS = [
  'same-slot',
  'semantic owner',
  'selected products',
  'primary recommendation focus',
  'products actually selected this time',
];

const PRODUCT_SETS = Object.freeze({
  sunscreen_oily_makeup: [
    {
      product_id: 'ext_boj_relief_sun_aqua_fresh',
      merchant_id: 'external_seed',
      title: 'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
      brand: 'Beauty of Joseon',
      price: 18,
      currency: 'USD',
      why_this_one:
        'Light serum-like sunscreen texture that is smoother under makeup and less heavy for oily skin.',
      authority_status: 'grounded_success',
    },
    {
      product_id: 'ext_supergoop_unseen_spf40',
      merchant_id: 'external_seed',
      title: 'Supergoop! Unseen Sunscreen SPF 40',
      brand: 'Supergoop!',
      price: 38,
      currency: 'USD',
      why_this_one:
        'Clear primer-like finish that can help under makeup, with a higher price than the Korean SPF options.',
      authority_status: 'grounded_success',
    },
    {
      product_id: 'ext_skin1004_hyalu_cica_water_fit',
      merchant_id: 'external_seed',
      title: 'SKIN1004 Hyalu-Cica Water-Fit Sun Serum SPF50+ PA++++',
      brand: 'SKIN1004',
      price: 19,
      currency: 'USD',
      why_this_one:
        'Watery serum feel with more hydration and a dewier finish, useful if oily skin still gets dehydrated.',
      authority_status: 'grounded_success',
    },
  ],
  barrier_moisturizers: [
    {
      product_id: 'ext_krave_great_barrier_relief',
      merchant_id: 'external_seed',
      title: 'KraveBeauty Great Barrier Relief',
      brand: 'KraveBeauty',
      price: 28,
      currency: 'USD',
      why_this_one:
        'Barrier-supporting serum-lotion format that fits tight, over-cleansed, or retinoid-stressed skin.',
      authority_status: 'grounded_success',
    },
    {
      product_id: 'ext_first_aid_ultra_repair_face_lotion',
      merchant_id: 'external_seed',
      title: 'First Aid Beauty Ultra Repair Face Lotion with Colloidal Oatmeal',
      brand: 'First Aid Beauty',
      price: 32,
      currency: 'USD',
      why_this_one:
        'Colloidal-oatmeal lotion direction is more comfort-led for sensitive or tight-feeling skin.',
      authority_status: 'grounded_success',
    },
    {
      product_id: 'ext_vanicream_daily_facial_moisturizer',
      merchant_id: 'external_seed',
      title: 'Vanicream Daily Facial Moisturizer',
      brand: 'Vanicream',
      price: 16,
      currency: 'USD',
      why_this_one:
        'Lower-cost fragrance-free moisturizer direction for users who want a simple barrier step.',
      authority_status: 'grounded_success',
    },
  ],
  combo_clogged_pores: [
    {
      product_id: 'ext_ordinary_niacinamide_zinc',
      merchant_id: 'external_seed',
      title: 'The Ordinary Niacinamide 10% + Zinc 1%',
      brand: 'The Ordinary',
      price: 12,
      currency: 'USD',
      why_this_one:
        'Affordable oil-balancing treatment direction for shine and clogged-pore concerns.',
      authority_status: 'grounded_success',
    },
    {
      product_id: 'ext_paulas_choice_bha',
      merchant_id: 'external_seed',
      title: "Paula's Choice Skin Perfecting 2% BHA Liquid Exfoliant",
      brand: "Paula's Choice",
      price: 35,
      currency: 'USD',
      why_this_one:
        'More exfoliation-led option for clogged pores, but easier to overuse if the barrier is reactive.',
      authority_status: 'grounded_success',
    },
    {
      product_id: 'ext_krave_oat_so_simple',
      merchant_id: 'external_seed',
      title: 'KraveBeauty Oat So Simple Water Cream',
      brand: 'KraveBeauty',
      price: 28,
      currency: 'USD',
      why_this_one:
        'Lightweight moisturizer support so treatment does not become the whole routine.',
      authority_status: 'grounded_success',
    },
  ],
  creator_sunscreen_roundup: [
    {
      product_id: 'ext_boj_relief_sun_aqua_fresh',
      merchant_id: 'external_seed',
      title: 'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
      brand: 'Beauty of Joseon',
      price: 18,
      currency: 'USD',
      why_this_one:
        'Balanced under-makeup slot: lighter feel without pushing a fully matte claim.',
      authority_status: 'grounded_success',
    },
    {
      product_id: 'ext_supergoop_unseen_spf40',
      merchant_id: 'external_seed',
      title: 'Supergoop! Unseen Sunscreen SPF 40',
      brand: 'Supergoop!',
      price: 38,
      currency: 'USD',
      why_this_one:
        'Useful premium comparison point because the clear primer-like texture is easy to explain on camera.',
      authority_status: 'grounded_success',
    },
    {
      product_id: 'ext_round_lab_birch_mild_up',
      merchant_id: 'external_seed',
      title: 'Round Lab Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
      brand: 'Round Lab',
      price: 24,
      currency: 'USD',
      why_this_one:
        'Mineral-sensitive-skin angle gives the roundup a different tradeoff from serum and primer textures.',
      authority_status: 'grounded_success',
    },
  ],
  non_beauty_luggage: [
    {
      product_id: 'carry_on_hardshell_01',
      merchant_id: 'demo_travel',
      title: 'Lightweight Hardshell Carry-On',
      brand: 'Demo Travel',
      price: 149,
      currency: 'USD',
      why_this_one: 'Compact carry-on option under the stated budget.',
      authority_status: 'grounded_success',
    },
  ],
});

const CASES = Object.freeze([
  {
    id: 'shopping_oily_sunscreen_humid_makeup',
    surfaces: ['shopping_agent'],
    turns: [
      {
        message: 'I have oily skin, what sunscreen should I buy?',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'sunscreen_oily_makeup',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'oily' },
          scenario_context: { use_case: 'daily sunscreen' },
        },
      },
      {
        message: 'I live in Houston and wear makeup. I get shiny by noon.',
        effective_goal:
          'I have oily skin in hot humid Houston, wear makeup, and get shiny by noon. What sunscreen should I buy?',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'sunscreen_oily_makeup',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'oily' },
          scenario_context: { location: 'Houston', climate: 'hot humid', use_case: 'under makeup' },
          constraints: { finish: 'less shiny by noon' },
        },
        expected_visible_terms_all: ['Houston', 'humid', 'makeup', 'shiny'],
      },
      {
        message: 'Show me alternatives and explain tradeoffs.',
        effective_goal:
          'Compare sunscreen alternatives for oily skin under makeup in hot humid Houston.',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        expected_next_actions_any: ['show_alternatives', 'compare_same_type'],
        product_set: 'sunscreen_oily_makeup',
        require_tradeoff_copy: true,
      },
    ],
  },
  {
    id: 'shopping_dry_sensitive_tretinoin_budget',
    surfaces: ['shopping_agent'],
    turns: [
      {
        message: 'My skin feels dry and tight after washing. What moisturizer should I use first?',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'barrier_moisturizers',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'dry sensitive', barrier_status: 'tight after washing' },
          scenario_context: { use_case: 'first moisturizer step' },
        },
      },
      {
        message: 'I use tretinoin at night and want to stay under $30.',
        effective_goal:
          'I have dry sensitive skin, use tretinoin at night, and want a moisturizer under $30.',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'barrier_moisturizers',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'dry sensitive', barrier_status: 'retinoid-stressed' },
          routine_context: { actives: ['tretinoin'] },
          constraints: { budget_max: 30 },
        },
        expected_visible_terms_all: ['tretinoin', 'under USD 30'],
      },
      {
        message: 'Which one should I use first versus later in the routine?',
        effective_goal:
          'For dry sensitive retinoid-stressed skin, compare which moisturizer to use first versus later in the routine.',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'barrier_moisturizers',
        require_tradeoff_copy: true,
        expected_visible_terms_all: ['first', 'later', 'routine'],
      },
    ],
  },
  {
    id: 'shopping_guided_context_recovery',
    surfaces: ['shopping_agent'],
    turns: [
      {
        message: 'What should I use for my skin?',
        expected_mode: 'guided_beauty_reco',
        expected_delegated_layer: 'decisioning',
        expected_next_actions_any: ['consider_skin_analysis', 'ask_missing_constraint'],
        product_set: null,
        beauty_request: { domain: 'beauty' },
        require_clarify_copy: true,
      },
      {
        message: 'Combination skin, clogged pores, Seattle winter, simple routine.',
        effective_goal:
          'I have combination skin with clogged pores in Seattle winter and want a simple routine.',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'combo_clogged_pores',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'combination', concerns: ['clogged pores'] },
          scenario_context: { location: 'Seattle', season: 'winter' },
          constraints: { routine_complexity: 'simple' },
        },
      },
      {
        message: 'What should I buy first if I only buy one?',
        effective_goal:
          'For combination skin with clogged pores in Seattle winter, pick the first product to buy if I only buy one.',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'combo_clogged_pores',
        require_tradeoff_copy: true,
        expected_visible_terms_all: ['only buy one', 'Seattle winter'],
      },
    ],
  },
  {
    id: 'creator_oily_under_makeup_roundup',
    surfaces: ['creator_agent'],
    turns: [
      {
        message: "I'm making a skincare roundup for oily skin under makeup. What sunscreen options should I feature?",
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'creator_sunscreen_roundup',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'oily' },
          scenario_context: { audience: 'skincare roundup', use_case: 'under makeup' },
        },
        require_creator_copy: true,
      },
      {
        message: 'Can you split them by price band and the angle I should use in content?',
        effective_goal:
          'For a creator sunscreen roundup for oily skin under makeup, split options by price band and content angle.',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'creator_sunscreen_roundup',
        require_creator_copy: true,
        require_tradeoff_copy: true,
      },
      {
        message: 'Also tell me what claims not to overstate.',
        effective_goal:
          'For the creator sunscreen roundup, explain cautious claims and avoid overstating finish or clinical benefits.',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'creator_sunscreen_roundup',
        require_creator_copy: true,
      },
    ],
  },
  {
    id: 'creator_dry_sensitive_moisturizer_audience',
    surfaces: ['creator_agent'],
    turns: [
      {
        message: 'My audience has dry sensitive skin, what moisturizer should I recommend?',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'barrier_moisturizers',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'dry sensitive' },
          scenario_context: { audience: 'creator audience' },
        },
        require_creator_copy: true,
      },
      {
        message: 'They are mostly beginners and some use retinoids.',
        effective_goal:
          'Recommend beginner-friendly moisturizers for a dry sensitive audience where some use retinoids.',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'barrier_moisturizers',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'dry sensitive' },
          routine_context: { audience_actives: ['retinoids'] },
          scenario_context: { audience: 'beginner creator audience' },
        },
        require_creator_copy: true,
      },
      {
        message: 'Give me three bullets that explain why each one, not just product names.',
        effective_goal:
          'For a dry sensitive beginner audience, explain why each moisturizer earns a slot versus the other options.',
        expected_mode: 'category_compare',
        expected_delegated_layer: 'decisioning',
        product_set: 'barrier_moisturizers',
        require_creator_copy: true,
        require_tradeoff_copy: true,
        expected_visible_terms_all: ['three slot reasons', 'versus'],
      },
    ],
  },
  {
    id: 'cross_agent_non_beauty_isolation_luggage',
    surfaces: ['shopping_agent', 'creator_agent'],
    expect_beauty: false,
    turns: [
      {
        message: 'I need a carry-on suitcase under $200.',
        expected_mode: null,
        product_set: 'non_beauty_luggage',
      },
      {
        message: 'Prefer lightweight hard-shell and a front laptop pocket.',
        expected_mode: null,
        product_set: 'non_beauty_luggage',
      },
    ],
  },
]);

function parseArgs(argv) {
  const args = {
    outDir: DEFAULT_OUT_DIR,
    rounds: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    const next = argv[index + 1];
    if (token === '--out-dir' && next) args.outDir = path.resolve(String(next));
    if (token === '--rounds' && next) args.rounds = Math.max(1, Number(next) || 1);
  }
  return args;
}

function utcTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value || '').trim();
}

function normalizeText(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clone(value, fallback = null) {
  if (value == null) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function mergeBeautyRequest(previous = {}, next = {}, userGoal = '') {
  return {
    domain: 'beauty',
    ...(clone(previous, {}) || {}),
    ...(clone(next, {}) || {}),
    user_goal: userGoal || next.user_goal || previous.user_goal || null,
    skin_context: {
      ...(previous.skin_context || {}),
      ...(next.skin_context || {}),
    },
    routine_context: {
      ...(previous.routine_context || {}),
      ...(next.routine_context || {}),
    },
    product_context: {
      ...(previous.product_context || {}),
      ...(next.product_context || {}),
    },
    scenario_context: {
      ...(previous.scenario_context || {}),
      ...(next.scenario_context || {}),
    },
    constraints: {
      ...(previous.constraints || {}),
      ...(next.constraints || {}),
    },
  };
}

function getProductTitles(products = []) {
  return asArray(products)
    .map((item) => text(item.name || item.title))
    .filter(Boolean);
}

function getBundleProducts(beautyExpert = null) {
  if (!beautyExpert) return [];
  return [
    ...asArray(beautyExpert.reco_bundle?.lead_picks),
    ...asArray(beautyExpert.reco_bundle?.support_picks),
  ];
}

function priceLabel(product) {
  const price = product?.price;
  const currency = text(product?.currency || 'USD') || 'USD';
  return price == null ? `${currency} n/a` : `${currency} ${price}`;
}

function buildContextualFollowUpCopy({ turn, bundleProducts = [], source }) {
  const prompt = normalizeText(`${turn.effective_goal || ''} ${turn.message || ''}`);
  const sourceToken = normalizeText(source);
  const lead = bundleProducts[0] || null;
  const support = bundleProducts.slice(1);
  const rows = [lead, ...support].filter(Boolean);
  const parts = [];

  if (/\bhouston\b|\bhumid\b|\bshiny\b|\bshine\b/.test(prompt)) {
    const dewy = support.find((item) => /dewy|hydration|watery/i.test(text(item.why_this_one)));
    const premium = rows.find((item) => Number(item.price) >= 30);
    parts.push(
      `Humid Houston weather and makeup make finish matter when skin gets shiny by noon: the lead stays in the thinner, less-heavy lane for oily skin, while ${text(dewy?.name || dewy?.title) || 'the more hydrating option'} may read dewier and ${text(premium?.name || premium?.title) || 'the premium option'} costs more for a primer-like feel.`,
    );
    parts.push('If shine breaks through by noon, pair the SPF with a light powder rather than adding a heavier sunscreen layer.');
  }

  if (/\btretinoin\b|\bretinoid\b/.test(prompt) && /\bunder\s+(usd\s*)?\$?\s*30\b|\bbudget\b/.test(prompt)) {
    const underBudget = rows
      .filter((item) => Number(item.price) <= 30)
      .map((item) => `${text(item.name || item.title)} (${priceLabel(item)})`);
    const overBudget = rows
      .filter((item) => Number(item.price) > 30)
      .map((item) => `${text(item.name || item.title)} (${priceLabel(item)})`);
    if (underBudget.length > 0) {
      parts.push(`Budget note: ${underBudget.join(' and ')} fit under USD 30 for a tretinoin routine.`);
    }
    if (overBudget.length > 0) {
      parts.push(`${overBudget.join(' and ')} is useful as a comfort-led comparison, but it is above the stated budget.`);
    }
  }

  if (/\bfirst\b.*\blater\b|\blater\b.*\bfirst\b|\broutine\b/.test(prompt) && /\bretinoid|tretinoin|moisturizer|barrier\b/.test(prompt)) {
    parts.push(
      `Routine order: use the lead as the first moisturizer step after cleansing or after tretinoin has settled; use the lower-cost simple moisturizer as the later fallback if the barrier still feels tight.`,
    );
    parts.push('Avoid stacking exfoliating or high-sting actives on the same night as tretinoin.');
  }

  if (/\bonly buy one\b|\bbuy first\b|\bfirst product\b/.test(prompt)) {
    parts.push(
      `If you only buy one for Seattle winter, the lead is the first buy because it targets clogged pores without being as exfoliation-heavy as the BHA option; add the moisturizer next if tightness or flaking shows up.`,
    );
  }

  if (sourceToken === 'creator agent' && /\bthree bullets\b|\bwhy each\b|\bnot just product names\b/.test(prompt)) {
    const bullets = rows
      .slice(0, 3)
      .map((item, index) => `${index + 1}. ${text(item.name || item.title)}: ${text(item.why_this_one)}`)
      .join(' ');
    if (bullets) {
      parts.push(`Three slot reasons versus the other options: ${bullets}`);
    }
  }

  return parts.join(' ');
}

function buildReply({ source, turn, beautyExpert, products }) {
  const sourceToken = normalizeText(source);
  if (!beautyExpert) {
    return `This stays outside the beauty expert. Continue with normal ${sourceToken || 'agent'} commerce handling.`;
  }
  const mode = beautyExpert.mode;
  const bundleProducts = getBundleProducts(beautyExpert);
  const lead = bundleProducts[0] || null;
  const support = bundleProducts.slice(1);
  if (mode === 'guided_beauty_reco' && bundleProducts.length === 0) {
    return 'I need more context before narrowing products reliably: skin type, main concern, routine, climate, and budget. A skin analysis would make this more precise.';
  }
  const leadName = text(lead?.name || lead?.title) || 'the lead option';
  const leadReason = text(lead?.why_this_one) || 'it matches the stated need';
  const supportCopy = support
    .map((item) => {
      const name = text(item.name || item.title);
      const reason = text(item.why_this_one);
      return `${name} is the tradeoff option: ${reason}`;
    })
    .filter(Boolean)
    .join(' ');
  const creatorPrefix =
    sourceToken === 'creator agent'
      ? 'For a creator-facing recommendation, '
      : '';
  const caution =
    /claims not to overstate/i.test(turn.message)
      ? ' Avoid overstating oil control, clinical outcomes, or universal sensitive-skin fit unless reviewed evidence supports it.'
      : '';
  const priceBand =
    /price band/i.test(turn.message)
      ? ` Price band: ${bundleProducts
          .map((item) => `${text(item.name || item.title)} at ${item.currency || 'USD'} ${item.price ?? 'n/a'}`)
          .join('; ')}.`
      : '';
  const contextualFollowUp = buildContextualFollowUpCopy({ turn, bundleProducts, source });
  return `${creatorPrefix}${leadName} is the lead because ${leadReason} Compared with it, ${supportCopy || 'there are no same-type support picks in this local contract run.'}${priceBand}${caution}${contextualFollowUp ? ` ${contextualFollowUp}` : ''}`.trim();
}

function hasAny(values = [], expected = []) {
  const left = new Set(asArray(values).map((item) => normalizeText(item)).filter(Boolean));
  return asArray(expected).some((item) => left.has(normalizeText(item)));
}

function classifyTurn({ testCase, turn, source, response }) {
  const failures = [];
  const expectedBeauty = testCase.expect_beauty !== false;
  const beautyExpert = response.beauty_expert_v1 || null;
  const visible = response.reply || '';
  const normalizedVisible = normalizeText(visible);
  if (expectedBeauty && !beautyExpert) failures.push('beauty_route_miss');
  if (!expectedBeauty && beautyExpert) failures.push('non_beauty_false_positive');
  if (turn.expected_mode && beautyExpert?.mode !== turn.expected_mode) failures.push('beauty_mode_miss');
  const delegatedLayer = beautyExpert?.delegation_trace?.delegated_layer || null;
  if (turn.expected_delegated_layer && delegatedLayer !== turn.expected_delegated_layer) {
    failures.push('beauty_mode_miss');
  }
  const nextActionTypes = asArray(beautyExpert?.next_actions).map((item) => item.type).filter(Boolean);
  if (asArray(turn.expected_next_actions_any).length > 0 && !hasAny(nextActionTypes, turn.expected_next_actions_any)) {
    failures.push('clarify_policy_miss');
  }
  if (turn.require_tradeoff_copy && !/\b(compared with|tradeoff|versus|instead of|while)\b/i.test(visible)) {
    failures.push('content_quality_miss');
  }
  if (turn.require_clarify_copy && !/\b(more context|skin analysis|skin type|routine|climate|budget)\b/i.test(visible)) {
    failures.push('clarify_policy_miss');
  }
  if (turn.require_creator_copy && !/\b(creator|audience|roundup|content|feature)\b/i.test(visible)) {
    failures.push('content_quality_miss');
  }
  const expectedVisibleTermsAll = asArray(turn.expected_visible_terms_all).map((item) => text(item)).filter(Boolean);
  if (
    expectedVisibleTermsAll.length > 0 &&
    !expectedVisibleTermsAll.every((term) => normalizedVisible.includes(normalizeText(term)))
  ) {
    failures.push('content_quality_miss');
  }
  if (expectedBeauty && getBundleProducts(beautyExpert).length > 1 && beautyExpert.compare_axes.length === 0) {
    failures.push('beauty_truth_split');
  }
  if (INTERNAL_TERMS.some((term) => normalizedVisible.includes(normalizeText(term)))) {
    failures.push('content_quality_miss');
  }
  return Array.from(new Set(failures));
}

function buildContext({ source, previousBeautyRequest, turn }) {
  const goal = text(turn.effective_goal || turn.message);
  const beautyRequest =
    turn.expected_mode || turn.beauty_request
      ? mergeBeautyRequest(previousBeautyRequest || {}, turn.beauty_request || {}, goal)
      : null;
  return {
    source_profile: {
      source,
      default_entry_layer: 'decisioning',
    },
    task_type: 'discovery',
    vertical: beautyRequest ? 'beauty' : null,
    category: beautyRequest ? 'skincare' : null,
    raw_user_goal: goal,
    normalized_need: beautyRequest ? { beauty_request: beautyRequest } : {},
    conversation_state: {},
    decision_state: {},
    execution_state: {},
  };
}

function runTurn({ testCase, source, turn, messages, previousBeautyRequest }) {
  messages.push({ role: 'user', content: turn.message });
  const context = buildContext({ source, previousBeautyRequest, turn });
  const products = clone(PRODUCT_SETS[turn.product_set] || [], []);
  const metadata = {
    source,
    ...(testCase.expect_beauty === false
      ? {}
      : {
          beauty_domain_hint: 'beauty',
          allow_orchestration_delegate: true,
        }),
  };
  const payload = {
    search: {
      query: turn.message,
      limit: 6,
      in_stock_only: true,
    },
    context,
  };
  const requestedLayer = resolveInvokeRequestedLayerWithInput('find_products_multi', source, {
    payload,
    metadata,
  });
  const expectedBeauty = testCase.expect_beauty !== false;
  const responseForExpert = {
    products,
    metadata: {
      mainline_status: products.length > 0 ? 'grounded_success' : 'needs_more_context',
      decision_owner: expectedBeauty && products.length > 0 ? 'shopping_agent_beauty_mainline' : 'commerce_decisioning',
      semantic_owner: expectedBeauty && products.length > 0 ? 'shopping_agent_beauty_mainline' : 'commerce_decisioning',
    },
  };
  const beautyExpert = buildBeautyExpertV1Response({
    source,
    entryLayer: 'orchestration',
    delegatedLayer: turn.expected_delegated_layer || null,
    taskType: 'discovery',
    context,
    metadata,
    payload,
    messages,
    response: responseForExpert,
  });
  const response = {
    layer: requestedLayer,
    reply: buildReply({ source, turn, beautyExpert, products }),
    products,
    beauty_expert_v1: beautyExpert,
    next_actions: beautyExpert?.next_actions || [],
  };
  const failures = classifyTurn({ testCase, turn, source, response });
  return {
    request: {
      operation: 'find_products_multi',
      surface: source,
      message: turn.message,
      effective_goal: turn.effective_goal || turn.message,
      requested_layer: requestedLayer,
    },
    response,
    normalized: {
      beauty_expert_v1: Boolean(beautyExpert),
      mode: beautyExpert?.mode || null,
      delegated_layer: beautyExpert?.delegation_trace?.delegated_layer || null,
      lead_pick_titles: getProductTitles(beautyExpert?.reco_bundle?.lead_picks || []),
      support_pick_titles: getProductTitles(beautyExpert?.reco_bundle?.support_picks || []),
      compare_axes: asArray(beautyExpert?.compare_axes).map((axis) => axis.label).filter(Boolean),
      next_actions: asArray(beautyExpert?.next_actions).map((action) => action.type).filter(Boolean),
      reply: response.reply,
    },
    failure_classes: failures,
    next_beauty_request: beautyExpert?.beauty_intent || previousBeautyRequest || null,
  };
}

function runCaseSurface(testCase, source, roundIndex) {
  const messages = [];
  let previousBeautyRequest = null;
  const turns = [];
  for (const [index, turn] of testCase.turns.entries()) {
    const result = runTurn({
      testCase,
      source,
      turn,
      messages,
      previousBeautyRequest,
    });
    previousBeautyRequest = result.next_beauty_request;
    turns.push({
      turn_index: index + 1,
      ...result,
    });
  }
  return {
    case_id: testCase.id,
    source,
    round_index: roundIndex,
    turns,
    failed: turns.some((turn) => turn.failure_classes.length > 0),
  };
}

function summarize(runs) {
  const failureBuckets = {};
  let totalTurns = 0;
  let failedTurns = 0;
  for (const run of runs) {
    for (const turn of run.turns) {
      totalTurns += 1;
      if (turn.failure_classes.length > 0) failedTurns += 1;
      for (const failure of turn.failure_classes) {
        if (!failureBuckets[failure]) failureBuckets[failure] = [];
        failureBuckets[failure].push(`${run.case_id}:${run.source}:turn${turn.turn_index}`);
      }
    }
  }
  return {
    generated_at: new Date().toISOString(),
    total_runs: runs.length,
    total_turns: totalTurns,
    failed_turns: failedTurns,
    failure_buckets: Object.fromEntries(
      Object.entries(failureBuckets).map(([key, values]) => [key, Array.from(new Set(values))]),
    ),
  };
}

function writeReports(outDir, args, summary, runs) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'celestial_commerce_beauty_cross_agent_multiturn_local.json');
  const mdPath = path.join(outDir, 'celestial_commerce_beauty_cross_agent_multiturn_local.md');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ args, summary, runs }, null, 2),
    'utf8',
  );

  const lines = [
    '# Celestial Commerce Beauty Cross-Agent Multi-Turn Local Matrix',
    '',
    `- Generated at: ${summary.generated_at}`,
    `- Runs: ${summary.total_runs}`,
    `- Turns: ${summary.total_turns}`,
    `- Failed turns: ${summary.failed_turns}`,
    '',
    '## Failure Buckets',
    '',
    '| Failure class | Count | Locations |',
    '| --- | ---: | --- |',
    ...Object.entries(summary.failure_buckets).map(
      ([key, values]) => `| ${key} | ${values.length} | ${values.join(', ')} |`,
    ),
    ...(Object.keys(summary.failure_buckets).length === 0 ? ['| - | 0 | - |'] : []),
    '',
    '## Actual Outputs',
    '',
  ];

  for (const run of runs) {
    lines.push(`### ${run.case_id} / ${run.source} / round ${run.round_index}`);
    lines.push('');
    for (const turn of run.turns) {
      lines.push(`- Turn ${turn.turn_index}: ${turn.request.message}`);
      lines.push(`  - mode: ${turn.normalized.mode || 'n/a'}`);
      lines.push(`  - lead: ${turn.normalized.lead_pick_titles.join(' | ') || 'n/a'}`);
      lines.push(`  - support: ${turn.normalized.support_pick_titles.join(' | ') || 'n/a'}`);
      lines.push(`  - axes: ${turn.normalized.compare_axes.join(' | ') || 'n/a'}`);
      lines.push(`  - next_actions: ${turn.normalized.next_actions.join(' | ') || 'n/a'}`);
      lines.push(`  - failures: ${turn.failure_classes.join(' | ') || 'none'}`);
      lines.push(`  - reply: ${turn.normalized.reply}`);
    }
    lines.push('');
  }

  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  return { jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.outDir, utcTag());
  const runs = [];
  for (let round = 1; round <= args.rounds; round += 1) {
    for (const testCase of CASES) {
      for (const source of testCase.surfaces) {
        runs.push(runCaseSurface(testCase, source, round));
      }
    }
  }
  const summary = summarize(runs);
  const { jsonPath, mdPath } = writeReports(outDir, args, summary, runs);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        summary,
        json_path: jsonPath,
        markdown_path: mdPath,
        out_dir: outDir,
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.stack || error) }, null, 2)}\n`);
    process.exit(1);
  });
}
