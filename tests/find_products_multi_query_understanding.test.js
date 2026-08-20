const {
  understandShoppingQuery,
  buildSearchQualityContract,
  resolveBeautyCategoryPathPrefixFromText,
} = require('../src/findProductsMulti/queryUnderstanding');

describe('find_products_multi query understanding', () => {
  test('corrects known fragrance typos before category routing', () => {
    const out = understandShoppingQuery({ rawQuery: 'tom ford fragarance', source: 'shopping_agent' });

    expect(out.corrected_query).toBe('tom ford fragrance');
    expect(out.effective_query).toBe('tom ford fragrance');
    expect(out.category_path_prefix).toBe('beauty/fragrance/');
    expect(out.brand_candidates).toEqual(expect.arrayContaining(['tom ford']));
    expect(out.corrections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          token: 'fragarance',
          replacement: 'fragrance',
          source: 'known_beauty_category_typo',
        }),
      ]),
    );
  });

  test('binds generic category follow-ups to current conversation brand context', () => {
    const out = understandShoppingQuery({
      rawQuery: 'fragrance',
      conversationMessages: [
        { role: 'user', content: 'tom ford fragarance' },
        { role: 'assistant', content: 'I found Tom Ford fragrance options.' },
        { role: 'user', content: 'fragrance' },
      ],
      sessionRecentQueries: ['fenty lipsticks'],
    });

    expect(out.effective_query).toBe('tom ford fragrance');
    expect(out.context_scope).toBe('conversation');
    expect(out.context_binding).toEqual(
      expect.objectContaining({
        brand: 'tom ford',
        reason: 'generic_category_followup_conversation_brand',
      }),
    );
  });

  test('does not bind generic category to session recent queries', () => {
    const out = understandShoppingQuery({
      rawQuery: 'fragrance',
      conversationMessages: [],
      sessionRecentQueries: ['tom ford fragarance'],
    });

    expect(out.effective_query).toBe('fragrance');
    expect(out.context_scope).toBe('none');
    expect(out.risk_flags).toEqual(expect.arrayContaining(['session_recent_queries_ignored_for_context']));
  });

  test('binds session recent query only when continuation is explicit', () => {
    const out = understandShoppingQuery({
      rawQuery: 'continue previous search',
      conversationMessages: [],
      sessionRecentQueries: ['tom ford fragarance'],
    });

    expect(out.effective_query).toBe('tom ford fragrance');
    expect(out.context_scope).toBe('session_explicit');
    expect(out.context_binding).toEqual(
      expect.objectContaining({
        reason: 'explicit_session_previous_query',
        source_query: 'tom ford fragarance',
      }),
    );
  });

  test('keeps fragrance-free moisturizer out of fragrance routing', () => {
    const out = understandShoppingQuery({ rawQuery: 'fragrance-free barrier moisturizer' });

    expect(out.category_path_prefix).toBe('beauty/skincare/moisturize/');
    expect(out.hard_negatives.fragrance_free_skincare).toBe(true);
    expect(resolveBeautyCategoryPathPrefixFromText('fragrance-free barrier moisturizer')).toBe(
      'beauty/skincare/moisturize/',
    );
  });

  test('does not route donation foundation wording as makeup foundation', () => {
    const out = understandShoppingQuery({ rawQuery: 'donate to the clara lionel foundation' });
    const contract = buildSearchQualityContract({
      rawQuery: 'donate to the clara lionel foundation',
      market: 'US',
    });

    expect(out.category_path_prefix).toBeNull();
    expect(out.risk_flags).toEqual(expect.arrayContaining(['non_merchandise_query_guard']));
    expect(out.hard_negatives.non_merchandise_query).toBe(true);
    expect(contract.target_domain).toBe('other');
    expect(contract.query_class).toBe('ambiguous_or_non_shopping');
    expect(contract.clarification_allowed).toBe(true);
    expect(contract.hard_constraints.brand).toBeNull();
    expect(contract.hard_constraints.category_path_prefix).toBeNull();
  });

  test('flags strict lipstick intent separately from lip oil or balm', () => {
    expect(understandShoppingQuery({ rawQuery: 'fenty beauty lipsticks' }).hard_negatives.strict_lipstick).toBe(true);
    expect(understandShoppingQuery({ rawQuery: 'fenty lip oil' }).hard_negatives.strict_lipstick).toBe(false);
  });

  test('binds acne recommendation follow-up skin and location slots to the prior concern', () => {
    const out = understandShoppingQuery({
      rawQuery: 'i think i am aoily skin, and i live in SF.',
      conversationMessages: [
        { role: 'user', content: 'i have acne issue, recommend some products to take care of it' },
        {
          role: 'assistant',
          content:
            'I need a bit more context before narrowing products: skin_type, environment. A skin analysis can help if you want a more precise routine, but it is not required to continue.',
        },
        { role: 'user', content: 'i think i am aoily skin, and i live in SF.' },
      ],
      source: 'shopping_agent_ui',
    });

    expect(out.corrected_query).toBe('i think i am oily skin, and i live in SF.');
    expect(out.effective_query).toBe('acne treatment serum oily skin San Francisco');
    expect(out.category_path_prefix).toBe('beauty/skincare/treat/');
    expect(out.context_scope).toBe('conversation');
    expect(out.context_binding).toEqual(
      expect.objectContaining({
        reason: 'beauty_slot_followup_conversation_context',
        source_query: 'i have acne issue, recommend some products to take care of it',
      }),
    );
    expect(out.beauty_context.bound).toEqual(
      expect.objectContaining({
        concern: 'acne',
        skin_type: 'oily',
        location: 'San Francisco',
      }),
    );
  });

  test('does not convert a profile-only skin statement into a product search without conversation concern', () => {
    const out = understandShoppingQuery({
      rawQuery: 'i think i am an oily skin, and i live in SF.',
      conversationMessages: [],
    });

    expect(out.effective_query).toBe('i think i am an oily skin, and i live in SF.');
    expect(out.context_scope).toBe('none');
  });

  test.each([
    ['fenty', 'brand_browse', 'beauty', 'fenty beauty', null],
    ['fenty lipstick', 'brand_category', 'beauty', 'fenty beauty', 'beauty/makeup/lip/'],
    ['rare beauty blush', 'brand_category', 'beauty', 'rare beauty', 'beauty/makeup/face/blush/'],
    ['the ordinary niacinamide', 'brand_category', 'beauty', 'the ordinary', 'beauty/skincare/treat/'],
    ['lipstick', 'category_browse', 'beauty', null, 'beauty/makeup/lip/'],
    ['barrier moisturizer', 'category_browse', 'beauty', null, 'beauty/skincare/moisturize/'],
    ['acne oily skin serum', 'need_solution', 'beauty', null, 'beauty/skincare/treat/'],
    ['fragrance-free sunscreen', 'constraint_search', 'beauty', null, 'beauty/skincare/sun/'],
    ['pregnancy safe cleanser', 'constraint_search', 'beauty', null, 'beauty/skincare/cleanse/'],
    ['foundation', 'category_browse', 'beauty', null, 'beauty/makeup/face/'],
    ['fenty donate to the clara lionel foundation', 'ambiguous_or_non_shopping', 'other', null, null],
    ['zara', 'ambiguous_or_non_shopping', 'other', null, null],
    ['nike shoes', 'ambiguous_or_non_shopping', 'other', null, null],
    ['wireless earbuds', 'ambiguous_or_non_shopping', 'other', null, null],
  ])('builds search quality contract for %s', (query, queryClass, domain, brand, categoryPathPrefix) => {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'US' });

    expect(contract.contract_version).toBe('search_quality_contract_v1');
    expect(contract.query_class).toBe(queryClass);
    expect(contract.target_domain).toBe(domain);
    expect(contract.hard_constraints.brand?.canonical || null).toBe(brand);
    expect(contract.hard_constraints.category_path_prefix).toBe(categoryPathPrefix);
  });

  test('search quality contract preserves fragrance-free skincare as skincare constraint', () => {
    const contract = buildSearchQualityContract({ rawQuery: 'fragrance-free moisturizer' });

    expect(contract.query_class).toBe('constraint_search');
    expect(contract.hard_constraints.category_path_prefix).toBe('beauty/skincare/moisturize/');
    expect(contract.hard_constraints.exclusions).toEqual(expect.arrayContaining(['fragrance_product']));
    expect(contract.hard_constraints.fragrance_free_skincare).toBe(true);
  });

  test('search quality contract marks strict lipstick exclusions', () => {
    const contract = buildSearchQualityContract({ rawQuery: 'fenty lipstick' });

    expect(contract.query_class).toBe('brand_category');
    expect(contract.hard_constraints.strict_lipstick).toBe(true);
    expect(contract.hard_constraints.exclusions).toEqual(expect.arrayContaining(['lip_gloss_oil_balm_mask']));
  });

  // 2026-08-20 — Mechanism 3 of the "No products matched this search" zeros.
  // The contract's category vocabulary had no rule for toner or any haircare
  // noun, so bare `toner` / `shampoo` / `conditioner` / `hair mask` /
  // `hair oil` classified other/ambiguous_or_non_shopping and the safe-empty
  // branch answered a confident zero in ~0.2s, BEFORE any SQL — silently
  // nullifying the #2035/#2039 category-browse union for exactly its target
  // vocabulary (measured live on search_catalog: 8 fast-zeros, every one of
  // them a contract miss; `gentle shampoo` only survived because "gentle" is
  // a constraint signal). These rows pin the repaired vocabulary; buckets
  // verified on prod the same day (beauty/skincare/tone/toner: 333
  // serving-eligible rows, 58 mist-titled; beauty/haircare/*: 473).
  test.each([
    ['toner', 'category_browse', 'beauty/skincare/tone/'],
    ['best toner', 'category_browse', 'beauty/skincare/tone/'],
    ['toner pads', 'category_browse', 'beauty/skincare/tone/'],
    ['face mist', 'category_browse', 'beauty/skincare/tone/'],
    ['shampoo', 'category_browse', 'beauty/haircare/'],
    ['dry shampoo', 'category_browse', 'beauty/haircare/'],
    ['conditioner', 'category_browse', 'beauty/haircare/'],
    ['leave-in conditioner', 'category_browse', 'beauty/haircare/'],
    ['hair mask', 'category_browse', 'beauty/haircare/'],
    ['hair oil', 'category_browse', 'beauty/haircare/'],
    ['hair care', 'category_browse', 'beauty/haircare/'],
    ['gentle shampoo', 'constraint_search', 'beauty/haircare/'],
    // hair-anchored forms must be claimed HERE, not by the skincare
    // cream/serum/treatment arms that sit later in the rule list.
    ['hair serum', 'category_browse', 'beauty/haircare/'],
    ['hair cream', 'category_browse', 'beauty/haircare/'],
    ['hair treatment', 'category_browse', 'beauty/haircare/'],
  ])('beauty category vocabulary covers %s', (query, queryClass, categoryPathPrefix) => {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'US' });
    expect(contract.target_domain).toBe('beauty');
    expect(contract.query_class).toBe(queryClass);
    expect(contract.hard_constraints.category_path_prefix).toBe(categoryPathPrefix);
  });

  test.each([
    // Non-beauty senses of the new nouns stay out of the beauty domain: a
    // safe-empty (or clarify) is CORRECT for these, and a haircare browse is
    // not.
    ['printer toner'],
    ['toner cartridge'],
    ['fabric conditioner'],
    ['lip conditioner'],
  ])('non-beauty sense of %s stays unclassified', (query) => {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'US' });
    expect(contract.query_class).toBe('ambiguous_or_non_shopping');
    expect(contract.hard_constraints.category_path_prefix).toBeNull();
  });

  // 2026-08-20 — measured tail of the same Mechanism-3 defect (flip-day
  // probe): setting powder, brow pencil/gel, contour stick, eye shadow
  // palette, micellar water, clay mask, bronzer, makeup remover all
  // classified ambiguous and safe-emptied before any SQL. Buckets verified
  // on prod the same day: beauty/makeup/face/powder 99 serving-eligible
  // rows, beauty/makeup/eye/brow 44, beauty/makeup/eye/eyeshadow 58,
  // beauty/makeup/face/bronzer 33 (13 contour-titled — why contour shares
  // the bronzer leaf), beauty/skincare/cleanse 425, beauty/skincare/treat/mask 407.
  test.each([
    ['setting powder', 'category_browse', 'beauty/makeup/face/powder/'],
    ['best setting powder', 'category_browse', 'beauty/makeup/face/powder/'],
    ['translucent powder', 'category_browse', 'beauty/makeup/face/powder/'],
    ['loose powder', 'category_browse', 'beauty/makeup/face/powder/'],
    ['pressed powder', 'category_browse', 'beauty/makeup/face/powder/'],
    ['brow pencil', 'category_browse', 'beauty/makeup/eye/brow/'],
    ['eyebrow pencil', 'category_browse', 'beauty/makeup/eye/brow/'],
    ['brow gel', 'category_browse', 'beauty/makeup/eye/brow/'],
    ['brow pomade', 'category_browse', 'beauty/makeup/eye/brow/'],
    // brow powder belongs to the brow rule, not the face-powder rule.
    ['brow powder', 'category_browse', 'beauty/makeup/eye/brow/'],
    ['eye shadow palette', 'category_browse', 'beauty/makeup/eye/eyeshadow/'],
    ['eyeshadow palette', 'category_browse', 'beauty/makeup/eye/eyeshadow/'],
    ['eyeshadow', 'category_browse', 'beauty/makeup/eye/eyeshadow/'],
    ['bronzer', 'category_browse', 'beauty/makeup/face/bronzer/'],
    ['contour stick', 'category_browse', 'beauty/makeup/face/bronzer/'],
    ['contour palette', 'category_browse', 'beauty/makeup/face/bronzer/'],
    // contour cream must be claimed here, NOT by the moisturizer rule's bare
    // `cream` arm that sits later in the rule list.
    ['contour cream', 'category_browse', 'beauty/makeup/face/bronzer/'],
    ['micellar water', 'category_browse', 'beauty/skincare/cleanse/'],
    ['makeup remover', 'category_browse', 'beauty/skincare/cleanse/'],
    ['make up remover', 'category_browse', 'beauty/skincare/cleanse/'],
    ['eye makeup remover', 'category_browse', 'beauty/skincare/cleanse/'],
    ['clay mask', 'category_browse', 'beauty/skincare/treat/mask/'],
    ['mud mask', 'category_browse', 'beauty/skincare/treat/mask/'],
  ])('beauty category vocabulary tail covers %s', (query, queryClass, categoryPathPrefix) => {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'US' });
    expect(contract.target_domain).toBe('beauty');
    expect(contract.query_class).toBe(queryClass);
    expect(contract.hard_constraints.category_path_prefix).toBe(categoryPathPrefix);
  });

  test.each([
    // Unanchored or non-beauty senses of the tail nouns stay unclassified —
    // safe-empty (or clarify) is CORRECT for these.
    ['powder'],
    ['baby powder'],
    ['protein powder'],
    ['palette'],
    ['contour'],
    ['contour pillow'],
    ['nail polish remover'],
    // Measured on prod 2026-08-20: ZERO catalog rows anywhere (any
    // eligibility) title-match pore strips or vitamin e oil, so there is no
    // bucket a rule could name — the safe-empty is at least honest here.
    // Remove these two rows when a producer starts minting those buckets.
    ['pore strips'],
    ['vitamin e oil'],
  ])('unanchored tail noun %s stays unclassified', (query) => {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'US' });
    expect(contract.query_class).toBe('ambiguous_or_non_shopping');
    expect(contract.hard_constraints.category_path_prefix).toBeNull();
  });

  test.each([
    // First match wins — earlier rules keep their claims over the tail rules.
    ['powder foundation', 'beauty/makeup/face/'],
    ['lip mask', 'beauty/makeup/lip/'],
    ['hair mask', 'beauty/haircare/'],
  ])('%s keeps its earlier-rule claim over the tail rules', (query, categoryPathPrefix) => {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'US' });
    expect(contract.query_class).toBe('category_browse');
    expect(contract.hard_constraints.category_path_prefix).toBe(categoryPathPrefix);
  });

  // 2026-08-20 — second residue pass over the Mechanism-3 vocabulary.
  // Every term here classified ambiguous and safe-emptied before any SQL;
  // buckets verified on prod the same day: face/highlighter 69 eligible
  // rows, face/primer 30, eye/eyeliner 48, makeup/lip 519 (lip liner rows
  // split across the competing lip/ and lips/ trees), treat/mask 407 (68
  // face|sheet-mask-titled), nails/nail-polish 38, treat/exfoliant 69,
  // skincare/face-oil 18, body-care/deodorant 11, body-care/body-wash 8,
  // haircare/general 244 (13 hairspray-titled).
  test.each([
    ['highlighter', 'category_browse', 'beauty/makeup/face/highlighter/'],
    ['liquid highlighter', 'category_browse', 'beauty/makeup/face/highlighter/'],
    ['primer', 'category_browse', 'beauty/makeup/face/primer/'],
    ['face primer', 'category_browse', 'beauty/makeup/face/primer/'],
    ['makeup primer', 'category_browse', 'beauty/makeup/face/primer/'],
    ['eyeliner', 'category_browse', 'beauty/makeup/eye/eyeliner/'],
    ['eye liner', 'category_browse', 'beauty/makeup/eye/eyeliner/'],
    ['lip liner', 'category_browse', 'beauty/makeup/lip/'],
    ['lip pencil', 'category_browse', 'beauty/makeup/lip/'],
    ['lip tint', 'category_browse', 'beauty/makeup/lip/'],
    ['face mask', 'category_browse', 'beauty/skincare/treat/mask/'],
    ['sheet mask', 'category_browse', 'beauty/skincare/treat/mask/'],
    ['overnight mask', 'category_browse', 'beauty/skincare/treat/mask/'],
    ['nail polish', 'category_browse', 'beauty/makeup/nails/nail-polish/'],
    ['gel nail polish', 'category_browse', 'beauty/makeup/nails/nail-polish/'],
    ['nail lacquer', 'category_browse', 'beauty/makeup/nails/nail-polish/'],
    ['exfoliant', 'category_browse', 'beauty/skincare/treat/exfoliant/'],
    ['exfoliator', 'category_browse', 'beauty/skincare/treat/exfoliant/'],
    ['chemical peel', 'category_browse', 'beauty/skincare/treat/exfoliant/'],
    ['peeling gel', 'category_browse', 'beauty/skincare/treat/exfoliant/'],
    ['body scrub', 'category_browse', 'beauty/skincare/treat/exfoliant/'],
    ['face oil', 'category_browse', 'beauty/skincare/face-oil/'],
    ['facial oil', 'category_browse', 'beauty/skincare/face-oil/'],
    ['deodorant', 'category_browse', 'beauty/body-care/deodorant/'],
    ['antiperspirant', 'category_browse', 'beauty/body-care/deodorant/'],
    ['shower gel', 'category_browse', 'beauty/body-care/body-wash/'],
    ['hairspray', 'category_browse', 'beauty/haircare/'],
    ['hair spray', 'category_browse', 'beauty/haircare/'],
  ])('beauty category vocabulary second pass covers %s', (query, queryClass, categoryPathPrefix) => {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'US' });
    expect(contract.target_domain).toBe('beauty');
    expect(contract.query_class).toBe(queryClass);
    expect(contract.hard_constraints.category_path_prefix).toBe(categoryPathPrefix);
  });

  test.each([
    // Non-beauty senses of the second-pass nouns stay unclassified.
    ['highlighter pen'],
    ['highlighter markers'],
    ['paint primer'],
    ['primer paint'],
    ['wall primer'],
    // Bare nouns whose dominant sense is not a beauty product.
    ['peel'],
    ['scrub'],
    ['mask'],
    // Measured on prod 2026-08-20 and deliberately NOT claimed: setting
    // spray's bucket (makeup/setting-spray) holds 2 rows with ~5 more
    // scattered — no browsable home; bath bomb has 8 rows all in the bare
    // `beauty` root — no bucket a rule could name. Remove these rows when a
    // producer starts minting those buckets.
    ['setting spray'],
    ['bath bomb'],
  ])('second-pass non-claim %s stays unclassified', (query) => {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'US' });
    expect(contract.query_class).toBe('ambiguous_or_non_shopping');
    expect(contract.hard_constraints.category_path_prefix).toBeNull();
  });

  test.each([
    // Ordering: the exfoliant rule sits BELOW cleanser and toner, so the
    // exfoliating variants of those categories browse their own buckets
    // (13 exfoli-titled eligible rows live in cleanse/, 8 in tone/).
    ['exfoliating cleanser', 'beauty/skincare/cleanse/'],
    ['exfoliating toner', 'beauty/skincare/tone/'],
    // hair oil/mask keep the haircare claim over face_oil/face_mask.
    ['hair oil', 'beauty/haircare/'],
    ['hair mask', 'beauty/haircare/'],
  ])('%s keeps its earlier-rule claim over the second-pass rules', (query, categoryPathPrefix) => {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'US' });
    expect(contract.query_class).toBe('category_browse');
    expect(contract.hard_constraints.category_path_prefix).toBe(categoryPathPrefix);
  });

  test('body mist keeps its fragrance claim over the toner mist arm', () => {
    const contract = buildSearchQualityContract({ rawQuery: 'body mist', market: 'US' });
    expect(contract.query_class).toBe('category_browse');
    expect(contract.hard_constraints.category_path_prefix).toBe('beauty/fragrance/');
  });

  // The conditioner guards are \b-anchored lookbehinds. An unanchored
  // (?<!air\s) is satisfied by the trailing "air " of hAIR / repAIR — which
  // silently excluded "hair conditioner", the most canonical phrasing of the
  // whole category (caught in pre-merge review by execution, not reading).
  // Pinned at the RESOLVER level, not via buildSearchQualityContract: a
  // pre-existing brandLexicon defect substring-matches the "r co" of
  // "…r conditioner" as the R+Co brand, so the contract-level class for
  // these queries is polluted by an unrelated bug (filed as a follow-up).
  test.each([
    ['hair conditioner', 'beauty/haircare/'],
    ['repair conditioner', 'beauty/haircare/'],
    ['curly hair conditioner', 'beauty/haircare/'],
    ['air conditioner', ''],
    ['air conditioners', ''],
    ['fabric conditioner', ''],
    ['lip conditioner', ''],
  ])('conditioner guard anchoring: %s', (query, expectedPrefix) => {
    expect(resolveBeautyCategoryPathPrefixFromText(query) || '').toBe(expectedPrefix);
  });

  test('long brand product-title queries use exact product anchors instead of broad category paths', () => {
    const contract = buildSearchQualityContract({
      rawQuery: 'rare beauty positive light tinted moisturizer',
      market: 'US',
    });

    expect(contract.query_class).toBe('exact_product');
    expect(contract.target_domain).toBe('beauty');
    expect(contract.hard_constraints.brand?.canonical).toBe('rare beauty');
    expect(contract.hard_constraints.exact_product_anchor).toBe('positive light tinted moisturizer');
    expect(contract.hard_constraints.category_path_prefix).toBeNull();
  });
});
