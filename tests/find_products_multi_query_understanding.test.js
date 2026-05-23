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
