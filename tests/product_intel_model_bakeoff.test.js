const {
  parseArgs,
  summarizeModel,
  compareRowsByCase,
  buildMarkdown,
} = require('../scripts/product_intel_model_bakeoff');

describe('product_intel model bakeoff', () => {
  test('defaults to flash, pro, and 3.1-pro requested models', () => {
    const args = parseArgs(['node', 'script', '--cases', 'fixtures.json']);
    expect(args.models).toEqual([
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'gemini-3.1-pro-preview',
    ]);
  });

  test('summarizes requested and resolved models separately', () => {
    const report = {
      meta: {
        gemini_model_requested: 'gemini-3-pro-preview',
        gemini_completed: 2,
        hybrid_selected: 2,
        baseline_only: 0,
      },
      rows: [
        {
          gemini: {
            meta: {
              requested_model: 'gemini-3-pro-preview',
              resolved_models: ['models/gemini-3-pro-preview-0401'],
            },
          },
          quality_gate: {
            quality_score: 6,
            fail_reasons: [],
            seller_only_violation: false,
          },
          selected: {
            selected_field_count: 5,
          },
        },
        {
          gemini: {
            meta: {
              requested_model: 'gemini-3-pro-preview',
              resolved_models: ['models/gemini-3-pro-preview-0401'],
            },
          },
          quality_gate: {
            quality_score: 5,
            fail_reasons: [],
            seller_only_violation: false,
          },
          selected: {
            selected_field_count: 4,
          },
        },
      ],
    };

    const summary = summarizeModel(report);
    expect(summary.requested_model).toBe('gemini-3-pro-preview');
    expect(summary.resolved_models).toEqual(['models/gemini-3-pro-preview-0401']);
    expect(summary.avg_quality_score).toBe(5.5);
  });

  test('keeps per-case requested model labels while surfacing resolved models', () => {
    const comparisons = compareRowsByCase([
      {
        meta: {
          gemini_model_requested: 'gemini-3-flash-preview',
        },
        rows: [
          {
            case_id: 'case_a',
            gemini: {
              meta: {
                requested_model: 'gemini-3-flash-preview',
                resolved_models: ['models/gemini-3-flash-preview-0410'],
              },
              candidate: {
                product_intel_core: {
                  what_it_is: { body: 'Flash body' },
                  why_it_stands_out: [],
                },
              },
            },
            selected: { selected_mode: 'baseline_only', selected_field_count: 0 },
            quality_gate: { quality_score: 2, fail_reasons: ['weak_highlights'] },
          },
        ],
      },
    ]);

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].models['gemini-3-flash-preview'].requested_model).toBe('gemini-3-flash-preview');
    expect(comparisons[0].models['gemini-3-flash-preview'].resolved_models).toEqual([
      'models/gemini-3-flash-preview-0410',
    ]);
  });

  test('renders resolved model metadata in markdown summary', () => {
    const markdown = buildMarkdown(
      [
        {
          requested_model: 'gemini-3-pro-preview',
          resolved_models: ['models/gemini-3-pro-preview-0401'],
          avg_quality_score: 5.7,
          hybrid_selected: 10,
          baseline_only: 0,
          weak_highlights: 0,
          seller_only_violations: 0,
        },
      ],
      [
        {
          case_id: 'case_a',
          models: {
            'gemini-3-pro-preview': {
              resolved_models: ['models/gemini-3-pro-preview-0401'],
              quality_score: 6,
              selected_mode: 'hybrid_gemini',
              selected_field_count: 5,
              fail_reasons: [],
            },
          },
        },
      ],
      {
        generated_at: '2026-04-09T00:00:00.000Z',
        models: ['gemini-3-pro-preview'],
        case_count: 1,
      },
    );

    expect(markdown).toContain('gemini-3-pro-preview (models/gemini-3-pro-preview-0401)');
    expect(markdown).toContain('resolved=models/gemini-3-pro-preview-0401');
  });
});
