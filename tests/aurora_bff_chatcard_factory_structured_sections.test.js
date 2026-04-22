const { mapLegacyCardToSpecCards } = require('../src/auroraBff/chatCardFactory');
const { ChatCardSchema, ChatCardsResponseSchema } = require('../src/auroraBff/chatCardsSchema');

describe('aurora chatCardFactory structured sections for adapter inputs', () => {
  test('product_verdict card includes product_verdict_structured section', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'product_analysis',
        card_id: 'legacy_product_analysis',
        payload: {
          assessment: {
            verdict: 'Good fit',
            suitability: 'good',
            match_score: 84,
            product_name: 'Barrier Serum',
            reasons: ['Supports barrier hydration.'],
            how_to_use: {
              timing: 'PM',
              notes: ['Start 3 nights per week.'],
            },
          },
          evidence: {
            science: {
              key_ingredients: ['Panthenol', 'Ceramide'],
              risk_notes: ['Potential tingling in very sensitive skin.'],
            },
          },
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('product_verdict');
    const sections = Array.isArray(cards[0].sections) ? cards[0].sections : [];
    const structured = sections.find((section) => section && section.kind === 'product_verdict_structured');
    expect(structured).toBeTruthy();
  });

  test('skin_status card includes skin_status_structured section', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'skin_status',
        card_id: 'legacy_skin_status',
        payload: {
          profile: {
            skinType: 'oily',
            barrierStatus: 'impaired',
            goals: ['acne', 'dehydration'],
          },
          features: [{ observation: 'Shiny T-zone with dehydration signs.' }],
          strategy: 'Stabilize barrier first.',
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('skin_status');
    const sections = Array.isArray(cards[0].sections) ? cards[0].sections : [];
    const structured = sections.find((section) => section && section.kind === 'skin_status_structured');
    expect(structured).toBeTruthy();
    expect(structured.diagnosis).toBeTruthy();
  });

  test('effect_review card includes effect_review_structured section', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'effect_review',
        card_id: 'legacy_effect_review',
        payload: {
          reasons: ['Response is slower than expected due to inconsistent usage.'],
          target_state: ['Reduce redness flare-ups.'],
          core_principles: ['Keep routine stable for 14 days.'],
          safety_notes: ['Pause strong acids if stinging persists.'],
          routine_bridge: {
            why_now: 'Routine consistency unlocks cleaner effect attribution.',
            cta_label: 'Refine AM/PM routine',
          },
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('effect_review');
    const sections = Array.isArray(cards[0].sections) ? cards[0].sections : [];
    const structured = sections.find((section) => section && section.kind === 'effect_review_structured');
    expect(structured).toBeTruthy();
    expect(Array.isArray(structured.priority_findings)).toBe(true);
  });

  test('travel card exposes productized planner view model and keeps category-only shopping honest', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'env_stress',
        card_id: 'env_travel_planner',
        payload: {
          schema_version: 'aurora.ui.env_stress.v1',
          notes: ['Missing: recent_logs', 'barrier_status=stable', 'Scenario: uv (inferred)'],
          travel_readiness: {
            destination_context: {
              destination: 'Shanghai, China',
              start_date: '2026-04-20',
              end_date: '2026-04-24',
              env_source: 'weather_api',
            },
            origin_context: { label: 'Seattle, Washington, United States' },
            delta_vs_origin: {
              uv: { home: 5.7, destination: 8.1, delta: 2.4, unit: '' },
              humidity: { home: 77, destination: 79, delta: 2, unit: '%' },
              summary_tags: ['higher_uv', 'wetter'],
            },
            forecast_window: [{ date: '2026-04-20', temp_low_c: 13, temp_high_c: 22 }],
            confidence: { missing_inputs: ['recent_logs'] },
            phase_plan: [
              {
                id: 'pre_trip_prepare',
                title: 'Before you leave',
                timing: 'T-3 to T-1',
                why: 'Prepare tolerated products.',
                actions: ['Pack tolerated SPF and moisturizer.'],
                product_role_ids: ['sun_protection'],
                product_ids: [],
                coverage_status: 'category_only',
              },
            ],
            categorized_kit: [
              {
                id: 'sun_protection',
                title: 'Elevated UV',
                preparations: [{ name: 'Face SPF50+ PA++++ sunscreen' }],
                brand_suggestions: null,
                category_suggestions: [{ product: 'Face SPF50+ PA++++ sunscreen', match_status: 'category_guidance' }],
              },
            ],
            shopping_preview: {
              mode: 'category_guidance',
              coverage_status: 'category_only',
              products: [
                {
                  rank: 0,
                  product_id: null,
                  name: 'Legacy sunscreen row',
                  brand: null,
                  category: 'Elevated UV',
                  product_source: 'rule_fallback',
                  reasons: ['Legacy row should be quarantined.'],
                },
                {
                  rank: 1,
                  product_id: null,
                  name: 'Face SPF50+ PA++++ sunscreen',
                  brand: null,
                  category: 'Elevated UV',
                  product_source: 'category_guidance',
                  authority_status: 'category_only',
                  match_status: 'category_guidance',
                  display_mode: 'category_only',
                  is_grounded: false,
                  reasons: ['Category: Elevated UV'],
                },
              ],
              buying_channels: ['beauty_retail', 'pharmacy'],
              city_hint: 'Shanghai, China',
            },
            structured_sections: {
              flight_day_plan: ['Before boarding: apply moisturizer.', 'First 48 hours after landing: go barrier mode.'],
              phased_plan: ['Pre-trip (T-2 to T-1): keep routine unchanged.', 'On-site days: reapply SPF.'],
              active_handling: ['Skip acids/retinoids on flight day.'],
            },
          },
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards.length).toBe(1);
    expect(cards[0].type).toBe('travel');
    const reminder = cards[0].sections.find((section) => section.kind === 'checklist');
    expect(reminder.items).toEqual(
      expect.arrayContaining([
        'Seattle, Washington, United States -> Shanghai, China · 2026-04-20 -> 2026-04-24',
        'No recent skin logs, so the plan stays conservative.',
        'Shopping guidance is category-only until catalog products are grounded.',
      ]),
    );
    expect(JSON.stringify(reminder.items)).not.toMatch(/Missing: recent_logs|barrier_status=/);

    const structured = cards[0].sections.find((section) => section.kind === 'travel_structured');
    expect(structured.travel_planner.schema_version).toBe('aurora.ui.travel_planner.v1');
    expect(structured.travel_planner.phase_plan[0].id).toBe('pre_trip_prepare');
    expect(structured.travel_planner.phase_plan[0].actions).toEqual(['Pack tolerated SPF and moisturizer.']);
    expect(structured.travel_planner.shopping.mode).toBe('category_guidance');
    expect(structured.travel_planner.shopping.grounded_products).toEqual([]);
    expect(structured.travel_planner.shopping.legacy_rows_dropped_count).toBe(1);
    expect(structured.travel_planner.shopping.category_guidance.some((row) => row.name === 'Legacy sunscreen row')).toBe(false);
    expect(structured.travel_planner.shopping.category_guidance[0].product_source).toBe('category_guidance');
    expect(structured.travel_planner.shopping.buying_channel_labels).toEqual(['beauty retailers', 'pharmacies']);
  });

  test('triage card includes triage_structured section', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'triage',
        card_id: 'legacy_triage',
        payload: {
          details: ['Pause exfoliating acids for 48 hours.'],
          actions: ['Use barrier moisturizer twice daily.'],
          red_flags: ['Persistent burning sensation'],
          risk_level: 'high',
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('triage');
    const sections = Array.isArray(cards[0].sections) ? cards[0].sections : [];
    const structured = sections.find((section) => section && section.kind === 'triage_structured');
    expect(structured).toBeTruthy();
    expect(Array.isArray(structured.action_points)).toBe(true);
  });

  test('nudge card includes nudge_structured section', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'nudge',
        card_id: 'legacy_nudge',
        payload: {
          message: 'Keep your routine stable for one more week.',
          hints: ['Stability helps isolate what works.'],
          cadence_days: 7,
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('nudge');
    const sections = Array.isArray(cards[0].sections) ? cards[0].sections : [];
    const structured = sections.find((section) => section && section.kind === 'nudge_structured');
    expect(structured).toBeTruthy();
    expect(typeof structured.message).toBe('string');
  });

  test('error card maps to type error (not nudge) and passes schema validation', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'error',
        card_id: 'err_test_123',
        payload: { error: 'CHAT_FAILED' },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards.length).toBe(1);
    expect(cards[0].type).toBe('error');
    expect(cards[0].type).not.toBe('nudge');
    expect(cards[0].title).toBe('Something went wrong');
    expect(cards[0].payload.error_code).toBe('CHAT_FAILED');
    expect(cards[0].actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'retry' })]),
    );
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
  });

  test('error card maps correctly for CN language', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'error',
        card_id: 'err_test_cn',
        payload: { error: 'UPSTREAM_TIMEOUT' },
      },
      { requestId: 'req_card_factory', language: 'CN', index: 0 },
    );

    expect(cards[0].type).toBe('error');
    expect(cards[0].title).toBe('出了点问题');
    expect(cards[0].tags).toEqual(['错误']);
    expect(cards[0].payload.error_code).toBe('UPSTREAM_TIMEOUT');
  });

  test('unknown card type still falls back to nudge (not error)', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'some_future_type',
        card_id: 'unknown_type_card',
        payload: { message: 'Future feature hint.' },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards.length).toBe(1);
    expect(cards[0].type).toBe('nudge');
    expect(cards[0].type).not.toBe('error');
  });

  test('error card preserves detail from payload.detail field', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'error',
        card_id: 'err_detail',
        payload: { error: 'ENRICHMENT_FAILED', detail: 'Catalog search returned non-200' },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards[0].type).toBe('error');
    const bulletSection = cards[0].sections.find((s) => s.kind === 'bullets');
    expect(bulletSection).toBeTruthy();
    expect(bulletSection.items[0]).toBe('Catalog search returned non-200');
  });

  test('routine_fit_summary card passes through with schema-compatible type', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'routine_fit_summary',
        card_id: 'legacy_routine_fit',
        title: 'Routine fit',
        payload: {
          overall_fit: 'partial_match',
          fit_score: 0.5,
          summary: 'Some strong matches, with a few gaps to adjust.',
          highlights: ['Barrier support is solid.'],
          concerns: ['AM protection could be stronger.'],
          dimension_scores: {
            ingredient_match: { score: 0.5, note: 'Mostly aligned' },
          },
          next_questions: ['What should I adjust first?'],
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(Array.isArray(cards)).toBe(true);
    expect(cards[0].type).toBe('routine_fit_summary');
    expect(cards[0].title).toBe('Routine fit');
    expect(cards[0].payload.summary).toBe('Some strong matches, with a few gaps to adjust.');
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
  });

  test('offers_resolved maps to a renderable recommendations card instead of nudge', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'offers_resolved',
        card_id: 'legacy_offers_resolved',
        payload: {
          items: [
            {
              product: {
                product_id: 'prod_winona_repair',
                merchant_id: 'mid_winona',
                brand: 'Winona',
                display_name: 'Winona Soothing Repair Serum',
                image_url: 'https://example.com/winona.jpg',
              },
              metadata: {
                pdp_open_path: 'internal',
              },
              pdp_open: {
                path: 'ref',
                product_ref: {
                  product_id: 'prod_winona_repair',
                  merchant_id: 'mid_winona',
                },
              },
            },
          ],
          market: 'US',
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('recommendations');
    expect(cards[0].title).toBe('Items Found');
    const section = cards[0].sections.find((entry) => entry && entry.kind === 'product_cards');
    expect(section).toBeTruthy();
    expect(section.products[0]).toMatchObject({
      name: 'Winona Soothing Repair Serum',
      brand: 'Winona',
      product_id: 'prod_winona_repair',
      merchant_id: 'mid_winona',
    });
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
  });

  test('recommendations cards expose rich product rows under payload.sections and preserve PDP contract fields', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'recommendations',
        card_id: 'legacy_recommendations_rich',
        payload: {
          recommendation_meta: {
            selected_target_ids: ['oil_control_treatment', 'daily_sunscreen'],
            ranked_targets: [
              {
                target_id: 'oil_control_treatment',
                target_label: 'Oil-control treatment',
                product_candidates: [
                  {
                    product_id: 'prod_oil_balance',
                    merchant_id: 'merchant_oil_balance',
                    brand: 'Clear Lab',
                    name: 'Oil Balance Serum',
                  },
                  {
                    brand: 'Clear Lab',
                    name: 'Oil Balance Serum',
                  },
                  {
                    product_id: 'prod_budget_balance',
                    merchant_id: 'merchant_budget_balance',
                    brand: 'Budget Lab',
                    name: 'Budget Balance Serum',
                    price: { amount: 9, currency: 'USD', unknown: false },
                    category: 'treatment',
                    similarity_score: 0.82,
                  },
                ],
              },
              {
                target_id: 'daily_sunscreen',
                target_label: 'Daily sunscreen',
                product_candidates: [
                  {
                    product_id: 'prod_daily_spf',
                    merchant_id: 'merchant_daily_spf',
                    brand: 'Solaris',
                    name: 'Daily UV Fluid SPF 50',
                  },
                ],
              },
            ],
          },
          roles: [
            {
              role_id: 'oil_control_treatment',
              label: 'Oil-control treatment',
              preferred_step: 'targeted treatment',
            },
            {
              role_id: 'daily_sunscreen',
              label: 'Daily sunscreen',
              preferred_step: 'sunscreen',
            },
          ],
          recommendations: [
            {
              product_id: 'prod_oil_balance',
              merchant_id: 'merchant_oil_balance',
              brand: 'Clear Lab',
              name: 'Oil Balance Serum',
              image_url: 'https://example.com/oil-balance.jpg',
              matched_role_id: 'oil_control_treatment',
              why_this_one: 'Directly targets excess shine without feeling heavy.',
              best_for: ['Excess oil', 'Mid-day shine'],
              key_features: ['Niacinamide 10%', 'Zinc 1%'],
              price: { amount: 12, currency: 'USD', unknown: false },
              canonical_product_ref: {
                product_id: 'prod_oil_balance',
                merchant_id: 'merchant_oil_balance',
              },
              pdp_open: {
                path: 'ref',
                product_ref: {
                  product_id: 'prod_oil_balance',
                  merchant_id: 'merchant_oil_balance',
                },
              },
              alternatives: [
                {
                  kind: 'dupe',
                  name: 'Budget Balance Serum',
                  brand: 'Budget Lab',
                },
              ],
              social_proof: {
                rating: 4.7,
                review_count: 128,
              },
            },
          ],
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('recommendations');
    const section = cards[0].sections.find((entry) => entry && entry.kind === 'product_cards');
    expect(section).toBeTruthy();
    expect(section.products[0]).toMatchObject({
      product_id: 'prod_oil_balance',
      merchant_id: 'merchant_oil_balance',
      name: 'Oil Balance Serum',
      brand: 'Clear Lab',
      matched_role_id: 'oil_control_treatment',
      role_scope: 'oil_control_treatment',
      selected_target_id: 'oil_control_treatment',
      comparison_mode: 'routine_mix',
      price_label: '$12',
      alternatives_count: 1,
      canonical_product_ref: {
        product_id: 'prod_oil_balance',
        merchant_id: 'merchant_oil_balance',
      },
      pdp_open: {
        path: 'ref',
      },
      social_proof: {
        rating: 4.7,
        review_count: 128,
      },
      product_candidates: [
        {
          product_id: 'prod_budget_balance',
          merchant_id: 'merchant_budget_balance',
          brand: 'Budget Lab',
          name: 'Budget Balance Serum',
        },
      ],
      alternative_candidates: [
        {
          product_id: 'prod_budget_balance',
          merchant_id: 'merchant_budget_balance',
          brand: 'Budget Lab',
          name: 'Budget Balance Serum',
        },
      ],
      same_role_candidate_count: 1,
    });
    expect(section.products[0].product_candidates.map((row) => row.product_id || row.name)).toEqual([
      'prod_budget_balance',
    ]);
    expect(cards[0].payload.sections[0].products[0]).toMatchObject({
      product_id: 'prod_oil_balance',
      image_url: 'https://example.com/oil-balance.jpg',
      why_this_one: 'Directly targets excess shine without feeling heavy.',
      same_role_candidate_count: 1,
    });
    expect(cards[0].payload.sections[0].products[0].alternative_candidates).toHaveLength(1);
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
  });

  test('recommendations card prefers target-aligned why copy over off-target product description claims', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'recommendations',
        card_id: 'legacy_recommendations_off_target_copy',
        payload: {
          recommendation_meta: {
            selected_target_ids: ['oil_control_treatment'],
            ranked_targets: [
              {
                target_id: 'oil_control_treatment',
                target_label: 'Oil-control treatment',
              },
            ],
          },
          recommendations: [
            {
              product_id: 'prod_niacinamide',
              merchant_id: 'merchant_niacinamide',
              brand: 'The Ordinary',
              name: 'Niacinamide 10% + Zinc 1%',
              matched_role_id: 'oil_control_treatment',
              matched_role_label: 'Oil-control treatment',
              why_this_one: 'This serum targets dullness and uneven tone.',
              best_for: ['Best for excess oil and mid-day shine'],
              key_features: ['Oil-control support', 'Zinc 1%'],
              price: { amount: 12, currency: 'USD', unknown: false },
            },
          ],
        },
      },
      { requestId: 'req_card_factory_off_target_copy', language: 'EN', index: 0 },
    );

    const product = cards[0].payload.sections[0].products[0];
    expect(product.why_this_one).toMatch(/excess oil|mid-day shine|oil-control/i);
    expect(product.why_this_one).not.toMatch(/dullness|uneven tone/i);
  });

  test('recommendations card does not promote standalone ingredients into why copy', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'recommendations',
        card_id: 'legacy_recommendations_standalone_why',
        payload: {
          recommendation_meta: {
            selected_target_ids: ['tone_mark_treatment'],
            ranked_targets: [
              {
                target_id: 'tone_mark_treatment',
                target_label: 'Tone and post-breakout mark treatment',
              },
            ],
          },
          recommendations: [
            {
              product_id: 'prod_dark_spot',
              merchant_id: 'merchant_dark_spot',
              brand: 'First Aid Beauty',
              name: 'Dark Spot Serum with Niacinamide',
              matched_role_id: 'tone_mark_treatment',
              matched_role_label: 'Tone and post-breakout mark treatment',
              why_this_one: 'Glycerin',
              key_features: ['Niacinamide', 'Panthenol (B5)', 'Glycerin', 'Lightweight serum'],
              short_description: 'Targets post-breakout marks and uneven tone with niacinamide support.',
              price: { amount: 42, currency: 'USD', unknown: false },
            },
          ],
        },
      },
      { requestId: 'req_card_factory_standalone_why', language: 'EN', index: 0 },
    );

    const product = cards[0].payload.sections[0].products[0];
    expect(product.why_this_one).toMatch(/post-breakout marks|uneven tone|niacinamide/i);
    expect(product.why_this_one).not.toBe('Glycerin');
    expect(product.why_this_one).not.toBe('Lightweight serum');
    expect(product.key_features).toContain('Glycerin');
  });

  test('recommendations card keeps role-aligned narrative why over short best-for labels', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'recommendations',
        card_id: 'legacy_recommendations_barrier_copy',
        payload: {
          recommendation_meta: {
            selected_target_ids: ['barrier_moisturizer'],
            ranked_targets: [
              {
                target_id: 'barrier_moisturizer',
                target_label: 'Barrier-support moisturizer',
              },
            ],
          },
          recommendations: [
            {
              product_id: 'prod_barrier_cream',
              merchant_id: 'external_seed',
              brand: 'Haruharu Wonder',
              name: '5 Ceramide Barrier Moisturizing Cream / Unscented',
              matched_role_id: 'barrier_moisturizer',
              matched_role_label: 'Barrier-support moisturizer',
              best_for: 'Best for barrier support and richer comfort',
              why_this_one: 'The visible ceramide-capsule concept makes this more of a barrier-focused cream than a simple lightweight daily moisturizer.',
              key_features: ['Ceramide NP'],
              short_description: 'Ceramide capsule cream for barrier support and richer daily moisture.',
              price: { amount: 24, currency: 'USD', unknown: false },
            },
          ],
        },
      },
      { requestId: 'req_card_factory_barrier_copy', language: 'EN', index: 0 },
    );

    const product = cards[0].payload.sections[0].products[0];
    expect(product.best_for).toEqual(['Suited for barrier support and richer comfort']);
    expect(product.why_this_one).toMatch(/ceramide-capsule|barrier-focused cream/i);
    expect(product.why_this_one).not.toBe('Best for barrier support and richer comfort');
  });

  test('recommendations card does not let off-role best-for text override hydration why copy', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'recommendations',
        card_id: 'legacy_recommendations_hydration_copy',
        payload: {
          recommendation_meta: {
            selected_target_ids: ['hydrating_serum_or_essence'],
            ranked_targets: [
              {
                target_id: 'hydrating_serum_or_essence',
                target_label: 'Hydrating serum or essence',
              },
            ],
          },
          recommendations: [
            {
              product_id: 'prod_water_essence',
              merchant_id: 'external_seed',
              brand: 'Jurlique',
              name: 'Activating Water Essence+',
              matched_role_id: 'hydrating_serum_or_essence',
              matched_role_label: 'Hydrating serum or essence',
              best_for: 'Best for smoother layering under sunscreen or makeup',
              why_this_one: 'Skin Type: All Skin Types. Helps with dull, dehydrated skin. Texture: lightweight, watery.',
              key_features: ['Glycerin', 'Hyaluronic acid', 'Lightweight serum'],
              price: { amount: 49, currency: 'USD', unknown: false },
            },
          ],
        },
      },
      { requestId: 'req_card_factory_hydration_copy', language: 'EN', index: 0 },
    );

    const product = cards[0].payload.sections[0].products[0];
    expect(product.why_this_one).toMatch(/dehydrated|watery|hyaluronic|glycerin/i);
    expect(product.why_this_one).not.toBe('Useful for smoother layering under sunscreen or makeup');
  });

  test('recommendations card neutralizes absolute marketing copy in visible product fields', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'recommendations',
        card_id: 'legacy_recommendations_neutral_copy',
        payload: {
          recommendation_meta: {
            selected_target_ids: ['daily_sunscreen'],
            ranked_targets: [
              {
                target_id: 'daily_sunscreen',
                target_label: 'Daily sunscreen',
              },
            ],
          },
          recommendations: [
            {
              product_id: 'round_lab_mild_up',
              merchant_id: 'external_seed',
              brand: 'Round Lab',
              name: 'Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
              matched_role_id: 'daily_sunscreen',
              matched_role_label: 'Daily sunscreen',
              why_this_one: 'Gentle, Effective Physical UV Protection. Experience superior sun protection with a lightweight mineral sunscreen.',
              short_description: 'Effectively protects with superior UV coverage.',
              key_features: ['Highly effective UV protection', 'Superior mineral filter feel'],
              price: { amount: 25, currency: 'USD', unknown: false },
            },
          ],
        },
      },
      { requestId: 'req_card_factory_neutral_copy', language: 'EN', index: 0 },
    );

    const product = cards[0].payload.sections[0].products[0];
    const visibleText = [
      product.why_this_one,
      product.short_description,
      ...(Array.isArray(product.key_features) ? product.key_features : []),
    ].join(' ');
    expect(visibleText).not.toMatch(/\b(?:best|most|effective|effectively|superior|highly effective|ideal|strongest)\b/i);
    expect(product.why_this_one).toMatch(/physical uv protection|sun protection|lightweight mineral sunscreen/i);
  });

  test('recommendations card filters sunscreen peer rails by product identity, not seed category labels', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'recommendations',
        card_id: 'legacy_recommendations_sunscreen_peer_filter',
        payload: {
          recommendation_meta: {
            selected_target_ids: ['daily_sunscreen_finish_fit'],
            ranked_targets: [
              {
                target_id: 'daily_sunscreen_finish_fit',
                target_label: 'Daily sunscreen with finish fit',
                product_candidates: [
                  {
                    product_id: 'prod_wrinkle_corrector',
                    merchant_id: 'external_seed',
                    brand: 'Murad',
                    name: 'Targeted Wrinkle Corrector',
                    category: 'Sunscreen',
                    product_type: 'Sunscreen',
                    retrieval_source: 'external_seed',
                  },
                  {
                    product_id: 'prod_spf_moisturizer',
                    merchant_id: 'external_seed',
                    brand: 'Murad',
                    name: 'Superactive Moisturizer SPF 50: Hydrating',
                    category: 'Sunscreen',
                    product_type: 'Sunscreen',
                    retrieval_source: 'external_seed',
                  },
                ],
              },
            ],
          },
          recommendations: [
            {
              product_id: 'prod_lead_spf',
              merchant_id: 'external_seed',
              brand: 'Murad',
              name: 'Superactive Moisturizer SPF 50: Brightening',
              matched_role_id: 'daily_sunscreen_finish_fit',
              matched_role_label: 'Daily sunscreen with finish fit',
              why_this_one: 'SPF 50 daily protection with a wearable finish.',
              best_for: 'Daily SPF',
              key_features: ['SPF 50'],
              price: { amount: 55, currency: 'USD', unknown: false },
            },
          ],
        },
      },
      { requestId: 'req_card_factory_sunscreen_peer_filter', language: 'EN', index: 0 },
    );

    const product = cards[0].payload.sections[0].products[0];
    expect(product.product_candidates.map((row) => row.name)).toEqual([
      'Superactive Moisturizer SPF 50: Hydrating',
    ]);
    expect(product.alternative_candidates.map((row) => row.name)).toEqual([
      'Superactive Moisturizer SPF 50: Hydrating',
    ]);
  });

  test('recommendations card rewrites finish-fit same-slot why copy into shopper tradeoffs', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'recommendations',
        card_id: 'legacy_recommendations_finish_fit_tradeoffs',
        payload: {
          recommendation_meta: {
            selected_target_ids: ['daily_sunscreen_finish_fit'],
            ranked_targets: [
              {
                target_id: 'daily_sunscreen_finish_fit',
                target_label: 'Daily sunscreen with finish fit',
              },
            ],
          },
          recommendations: [
            {
              product_id: 'prod_unseen',
              merchant_id: 'external_seed',
              brand: 'Supergoop',
              name: 'Unseen Sunscreen SPF 50',
              matched_role_id: 'daily_sunscreen_finish_fit',
              matched_role_label: 'Daily sunscreen with finish fit',
              short_description: 'A daily sunscreen built around soft-focus powders for comfortable daytime layering under makeup.',
              why_this_one: 'it points to lighter, smoother daytime layering instead of a richer cream finish',
            },
            {
              product_id: 'prod_mineral_unseen',
              merchant_id: 'external_seed',
              brand: 'Supergoop',
              name: 'Mineral Unseen Sunscreen SPF 40',
              matched_role_id: 'daily_sunscreen_finish_fit',
              matched_role_label: 'Daily sunscreen with finish fit',
              short_description: 'Sheer, weightless, scentless mineral sunscreen that’s recommended for sensitive skin.',
              why_this_one: 'Sheer, weightless, scentless mineral sunscreen that’s recommended for sensitive skin.',
            },
            {
              product_id: 'prod_superscreen',
              merchant_id: 'external_seed',
              brand: 'Supergoop',
              name: 'Superscreen Hydrating Daily Cream SPF 40',
              matched_role_id: 'daily_sunscreen_finish_fit',
              matched_role_label: 'Daily sunscreen with finish fit',
              short_description: 'A hydrating daily cream SPF with moisturizer-style hydration cues.',
              why_this_one: 'Daily SPF cream with moisturizer-style hydration cues.',
            },
          ],
        },
      },
      { requestId: 'req_card_factory_finish_fit_tradeoffs', language: 'EN', index: 0 },
    );

    const products = cards[0].payload.sections[0].products;
    expect(products[0].why_this_one).toMatch(/keeps the finish lighter and smoother under makeup|lighter, smoother daytime layering/i);
    expect(products[1].why_this_one).toMatch(/leans more mineral|sensitive-skin-friendly|sheer, weightless finish/i);
    expect(products[1].why_this_one).not.toMatch(/^Sheer, weightless, scentless mineral sunscreen/i);
    expect(products[2].why_this_one).toMatch(/leans richer and more moisturizing|more cushion under makeup/i);
    expect(products[0].short_description).toMatch(/keeps the sunscreen feel lighter and smoother under makeup|lighter, smoother sunscreen feel|under makeup/i);
    expect(products[1].short_description).toMatch(/leans more mineral|sensitive-skin-friendly|sheer, weightless finish/i);
    expect(products[1].short_description).not.toMatch(/^Sheer, weightless, scentless mineral sunscreen/i);
    expect(products[2].short_description).toMatch(/leans richer and more moisturizing|more cushion under makeup/i);
  });

  test('recommendations card infers finish-fit tradeoffs from product titles when raw copy is generic', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'recommendations',
        card_id: 'legacy_recommendations_finish_fit_title_cues',
        payload: {
          recommendation_meta: {
            selected_target_ids: ['daily_sunscreen_finish_fit'],
            ranked_targets: [
              {
                target_id: 'daily_sunscreen_finish_fit',
                target_label: 'Daily sunscreen with finish fit',
              },
            ],
          },
          recommendations: [
            {
              product_id: 'prod_unseen',
              merchant_id: 'external_seed',
              brand: 'Supergoop',
              name: 'Supergoop Unseen Sunscreen SPF 50',
              matched_role_id: 'daily_sunscreen_finish_fit',
              matched_role_label: 'Daily sunscreen with finish fit',
              short_description: 'Weightless formula for daily wear.',
            },
            {
              product_id: 'prod_fab_mineral',
              merchant_id: 'external_seed',
              brand: 'First Aid Beauty',
              name: 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
              matched_role_id: 'daily_sunscreen_finish_fit',
              matched_role_label: 'Daily sunscreen with finish fit',
              short_description: 'Silky liquid formula for lightweight sun protection.',
            },
            {
              product_id: 'prod_fab_milk',
              merchant_id: 'external_seed',
              brand: 'First Aid Beauty',
              name: 'Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45',
              matched_role_id: 'daily_sunscreen_finish_fit',
              matched_role_label: 'Daily sunscreen with finish fit',
              short_description: 'Comfort-focused SPF for daily wear.',
            },
          ],
        },
      },
      { requestId: 'req_card_factory_finish_fit_title_cues', language: 'EN', index: 0 },
    );

    const products = cards[0].payload.sections[0].products;
    expect(products[1].why_this_one).toMatch(/leans more mineral|sensitive-skin-friendly|sheer, weightless finish/i);
    expect(products[1].short_description).toMatch(/leans more mineral|sensitive-skin-friendly|sheer, weightless finish/i);
    expect(products[2].why_this_one).toMatch(/leans richer and more moisturizing|more cushion under makeup/i);
    expect(products[2].short_description).toMatch(/leans richer and more moisturizing|more cushion under makeup/i);
  });

  test('recommendations card rewrites matte finish-fit sunscreen into shine-control tradeoff copy', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'recommendations',
        card_id: 'legacy_recommendations_finish_fit_matte_tradeoff',
        payload: {
          recommendation_meta: {
            selected_target_ids: ['daily_sunscreen_finish_fit'],
            ranked_targets: [
              {
                target_id: 'daily_sunscreen_finish_fit',
                target_label: 'Daily sunscreen with finish fit',
              },
            ],
          },
          recommendations: [
            {
              product_id: 'prod_aqua_fresh',
              merchant_id: 'external_seed',
              brand: 'Beauty of Joseon',
              name: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
              matched_role_id: 'daily_sunscreen_finish_fit',
              matched_role_label: 'Daily sunscreen with finish fit',
              short_description: 'A lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
              why_this_one: 'it keeps the finish lighter and smoother under makeup if you want a less heavy daytime layer',
            },
            {
              product_id: 'prod_matte_fit',
              merchant_id: 'external_seed',
              brand: 'SKINTIFIC',
              name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
              matched_role_id: 'daily_sunscreen_finish_fit',
              matched_role_label: 'Daily sunscreen with finish fit',
              short_description: 'Protect your skin from UVA, UVB, and blue light with Matte Fit Serum Sunscreen SPF 50+ PA++++.',
              description: 'This oil-controlling, non-greasy formula with Oat Extract and Zinc PCA is perfect for oily and acne-prone skin. Fast-absorbing, smooth finish with 8-hour shine control.',
              key_features: ['Zinc PCA'],
            },
          ],
        },
      },
      { requestId: 'req_card_factory_finish_fit_matte_tradeoff', language: 'EN', index: 0 },
    );

    const products = cards[0].payload.sections[0].products;
    expect(products[1].why_this_one).toMatch(/matte|shine-controlling|less slip under makeup/i);
    expect(products[1].why_this_one).not.toMatch(/mineral|sensitive-skin-friendly/i);
    expect(products[1].short_description).toMatch(/matte|shine-controlling|less slip under makeup/i);
    expect(products[1].short_description).not.toMatch(/UVA, UVB, and blue light/i);
  });

  test('recommendations card rewrites Day Dew style finish-fit sunscreen into dewy hydration tradeoff copy', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'recommendations',
        card_id: 'legacy_recommendations_finish_fit_dewy_tradeoff',
        payload: {
          recommendation_meta: {
            selected_target_ids: ['daily_sunscreen_finish_fit'],
            ranked_targets: [
              {
                target_id: 'daily_sunscreen_finish_fit',
                target_label: 'Daily sunscreen with finish fit',
              },
            ],
          },
          recommendations: [
            {
              product_id: 'prod_aqua_fresh',
              merchant_id: 'external_seed',
              brand: 'Beauty of Joseon',
              name: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
              matched_role_id: 'daily_sunscreen_finish_fit',
              matched_role_label: 'Daily sunscreen with finish fit',
              short_description: 'A lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
              why_this_one: 'it keeps the finish lighter and smoother under makeup if you want a less heavy daytime layer',
            },
            {
              product_id: 'prod_day_dew',
              merchant_id: 'external_seed',
              brand: 'Beauty of Joseon',
              name: 'Day Dew Sunscreen',
              matched_role_id: 'daily_sunscreen_finish_fit',
              matched_role_label: 'Daily sunscreen with finish fit',
              short_description: 'Fresh-dewy SPF for daily wear and makeup-friendly layering.',
              description: 'Pairs niacinamide, hyaluronic acid, and glycerin with makeup-friendly layering for cleaner daytime layering.',
            },
          ],
        },
      },
      { requestId: 'req_card_factory_finish_fit_dewy_tradeoff', language: 'EN', index: 0 },
    );

    const products = cards[0].payload.sections[0].products;
    expect(products[1].why_this_one).toMatch(/fresher and dewier|more hydration without a heavier cream feel/i);
    expect(products[1].short_description).toMatch(/fresher, dewier sunscreen feel|more hydration without a heavy cream finish/i);
    expect(products[1].short_description).not.toMatch(/Fresh-dewy SPF for daily wear/i);
  });

  test('offers_resolved shares the rich product row contract and mirrors it into payload.sections', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'offers_resolved',
        card_id: 'legacy_offers_resolved_rich',
        payload: {
          items: [
            {
              product: {
                product_id: 'prod_solar_fluid',
                merchant_id: 'merchant_solar',
                brand: 'Solaris',
                display_name: 'Daily UV Fluid SPF 50',
                image_url: 'https://example.com/uv-fluid.jpg',
                price: {
                  amount: 19,
                  currency: 'USD',
                  unknown: false,
                },
                social_proof: {
                  rating: 4.8,
                  review_count: 240,
                },
              },
              metadata: {
                pdp_open_path: 'internal',
              },
              pdp_open: {
                path: 'ref',
                product_ref: {
                  product_id: 'prod_solar_fluid',
                  merchant_id: 'merchant_solar',
                },
              },
            },
          ],
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    const section = cards[0].sections.find((entry) => entry && entry.kind === 'product_cards');
    expect(section.products[0]).toMatchObject({
      product_id: 'prod_solar_fluid',
      merchant_id: 'merchant_solar',
      name: 'Daily UV Fluid SPF 50',
      price_label: '$19',
      role_scope: 'resolved_offer',
      selected_target_id: 'resolved_offer',
      comparison_mode: 'direct_offer_lookup',
      social_proof: {
        rating: 4.8,
        review_count: 240,
      },
    });
    expect(cards[0].payload.sections[0].products[0]).toMatchObject({
      product_id: 'prod_solar_fluid',
      pdp_open: {
        path: 'ref',
      },
    });
  });

  test('product_parse does not degrade into a fallback nudge card', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'product_parse',
        card_id: 'legacy_product_parse',
        payload: {
          product: {
            product_id: 'prod_winona_repair',
            merchant_id: 'mid_winona',
          },
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards).toEqual([]);
  });

  test('returning_triage card remains schema-compatible instead of degrading to nudge', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'returning_triage',
        card_id: 'returning_triage_1',
        payload: {
          title: 'Continue your diagnosis',
          sections: [
            {
              kind: 'previous_diagnosis_summary',
              summary_text: 'Your previous diagnosis points to oily, acne-prone skin.',
            },
            {
              kind: 'returning_action_selection',
              actions: [{ action_id: 'chip.action.reassess', label: 'Re-assess my skin' }],
            },
          ],
          actions: [{ type: 'chip.action.reassess', label: 'Re-assess my skin' }],
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('returning_triage');
    expect(cards[0].title).toBe('Continue your diagnosis');
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
    expect(() => ChatCardsResponseSchema.parse({
      version: '1.0',
      request_id: 'req_card_factory',
      trace_id: 'trace_card_factory',
      assistant_text: 'Welcome back.',
      cards,
      follow_up_questions: [],
      suggested_quick_replies: [],
      ops: {
        thread_ops: [],
        profile_patch: [],
        routine_patch: [],
        experiment_events: [],
      },
      safety: {
        risk_level: 'none',
        red_flags: [],
        disclaimer: 'none',
      },
      telemetry: {
        intent: 'skin_diagnosis',
        intent_confidence: 0.9,
        entities: [],
        ui_language: 'EN',
        matching_language: 'EN',
        language_mismatch: false,
        language_resolution_source: 'header',
      },
    })).not.toThrow();
  });

  test('skin_progress card remains schema-compatible instead of degrading to nudge', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'skin_progress',
        card_id: 'skin_progress_1',
        payload: {
          title: 'Skin progress',
          sections: [
            { kind: 'progress_baseline', text_en: 'Baseline captured two weeks ago.' },
            { kind: 'progress_delta', concern_deltas: [{ concern: 'acne', trend: 'improved', note_en: 'Breakouts eased.' }] },
            { kind: 'progress_highlights', improvements: ['Less redness'], regressions: [], stable: [] },
            { kind: 'progress_recommendation', text_en: 'Keep the routine stable for one more week.' },
          ],
          actions: [{ type: 'chip.action.reassess', label: 'Re-assess my skin now' }],
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('skin_progress');
    expect(cards[0].title).toBe('Skin progress');
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
  });

  test('aurora_debug card stays visible in chatcards mode for live debug triage', () => {
    const cards = mapLegacyCardToSpecCards(
      {
        type: 'aurora_debug',
        card_id: 'legacy_aurora_debug',
        payload: {
          contract_status: 'empty_structured',
          mainline_status: 'severe_parse_or_prompt_failure',
          primary_failure_reason: 'artifact_missing',
          telemetry_failure_reason: 'empty_structured',
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('aurora_debug');
    expect(cards[0].title).toBe('Aurora debug');
    expect(cards[0].payload.contract_status).toBe('empty_structured');
    expect(() => ChatCardSchema.parse(cards[0])).not.toThrow();
  });

  test('routine audit cards pass through with schema-compatible types', () => {
    const verdictCards = mapLegacyCardToSpecCards(
      {
        type: 'routine_verdict_v1',
        card_id: 'routine_verdict_card',
        payload: {
          overall_verdict: 'needs_simplification',
          top_issues: [{ text: 'Retinol and acid are stacked in the same PM window.' }],
          top_3_actions: [{ title: 'Split the actives across different nights' }],
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 0 },
    );
    const userFitCards = mapLegacyCardToSpecCards(
      {
        type: 'routine_user_fit_v1',
        card_id: 'routine_user_fit_card',
        payload: {
          overall_user_fit_score: 61,
          goal_coverage: [{ goal: 'acne', product: 'Retinol serum', state: 'neutral' }],
          risk_mismatches: [{ issue: 'Barrier is impaired while two strong actives are stacked.', state: 'hurts' }],
        },
      },
      { requestId: 'req_card_factory', language: 'EN', index: 1 },
    );

    expect(() => ChatCardSchema.parse(verdictCards[0])).not.toThrow();
    expect(() => ChatCardSchema.parse(userFitCards[0])).not.toThrow();
    expect(verdictCards[0].type).toBe('routine_verdict_v1');
    expect(userFitCards[0].type).toBe('routine_user_fit_v1');
  });

  test('chatcards schema accepts four-card routine audit responses', () => {
    const response = {
      version: '1.0',
      request_id: 'req_routine_audit',
      trace_id: 'trace_routine_audit',
      assistant_text: 'Routine audit ready.',
      cards: [
        { id: 'c1', type: 'routine_verdict_v1', priority: 1, title: 'Routine verdict', sections: [], actions: [], tags: [] },
        { id: 'c2', type: 'routine_product_audit_v1', priority: 1, title: 'Product audit', sections: [], actions: [], tags: [] },
        { id: 'c3', type: 'routine_user_fit_v1', priority: 1, title: 'User fit', sections: [], actions: [], tags: [] },
        { id: 'c4', type: 'routine_adjustment_plan_v1', priority: 1, title: 'Adjustment plan', sections: [], actions: [], tags: [] },
      ],
      follow_up_questions: [],
      suggested_quick_replies: [],
      ops: {
        thread_ops: [],
        profile_patch: [],
        routine_patch: [],
        experiment_events: [],
      },
      safety: {
        risk_level: 'low',
        red_flags: [],
        disclaimer: 'none',
      },
      telemetry: {
        intent: 'routine_review',
        intent_confidence: 0.92,
        entities: [],
        ui_language: 'EN',
        matching_language: 'EN',
        language_mismatch: false,
        language_resolution_source: 'body',
      },
    };

    expect(() => ChatCardsResponseSchema.parse(response)).not.toThrow();
  });
});
