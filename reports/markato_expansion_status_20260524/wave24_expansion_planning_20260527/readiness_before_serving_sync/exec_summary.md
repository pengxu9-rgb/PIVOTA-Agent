# KB x Commerce Index Readiness Audit

Generated: 2026-05-27T07:07:02.026Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave24-20260527/reports/markato_expansion_status_20260524/wave24_expansion_planning_20260527/readiness_before_serving_sync

## Executive Numbers

- Rows scanned: 25
- Terminal hold rows: 0
- Action-required rows: 25
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 25
- Direct KB high-quality-ready rows: 25
- Identity ready rows: 25
- Public commerce doc groups built by dry-run: 0
- Rows with public commerce doc + insight summary: 0
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5766 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| index_doc_shadow_only | 25 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 7journeys.com | 5 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |
| abyssianhaircare.com | 5 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |
| apiceuticals.com | 5 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |
| khus-khus.com | 5 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |
| lhamour.com | 5 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 25,
  "by_market": {
    "US": 25
  },
  "by_domain": [
    {
      "key": "7journeys.com",
      "count": 5
    },
    {
      "key": "abyssianhaircare.com",
      "count": 5
    },
    {
      "key": "apiceuticals.com",
      "count": 5
    },
    {
      "key": "khus-khus.com",
      "count": 5
    },
    {
      "key": "lhamour.com",
      "count": 5
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 25
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 21,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 20
  },
  "pivota_insights": {
    "direct": {
      "displayable": 25,
      "high_quality_ready": 25,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 25,
      "high_quality_ready": 25,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 25
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 25
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 23,
    "any_active_items": 0,
    "status": [
      {
        "key": "missing_hero",
        "count": 20
      },
      {
        "key": "low_signal_active",
        "count": 4
      },
      {
        "key": "not_expected_missing",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 20
      },
      {
        "key": "low_signal_active",
        "count": 4
      }
    ],
    "issue_domains": [
      {
        "key": "7journeys.com::missing_hero",
        "count": 5
      },
      {
        "key": "khus-khus.com::missing_hero",
        "count": 5
      },
      {
        "key": "lhamour.com::missing_hero",
        "count": 5
      },
      {
        "key": "abyssianhaircare.com::missing_hero",
        "count": 4
      },
      {
        "key": "apiceuticals.com::low_signal_active",
        "count": 4
      },
      {
        "key": "apiceuticals.com::missing_hero",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 25
      }
    ],
    "samples": {
      "low_signal_active": [
        {
          "external_product_id": "ext_4e95b920b4c6a5295d55aa46",
          "domain": "apiceuticals.com",
          "title": "PROPOWAX™ Antioxidant Conditioner 300ml",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_d17dfc05f98d0400d5129f1c",
          "domain": "apiceuticals.com",
          "title": "PROPOWAX™ Antioxidant Shower Gel 300ml",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_1e27467ab07ddb83ad74c213",
          "domain": "apiceuticals.com",
          "title": "PROPOWAX™ Antioxidant Shampoo 300ml",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_c0e5209513c083e2c649c1a1",
          "domain": "apiceuticals.com",
          "title": "PROPOWAX™ Antioxidant Body Lotion 300ml",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        }
      ],
      "missing_hero": [
        {
          "external_product_id": "ext_d3d708f481903ba2a6f9b732",
          "domain": "apiceuticals.com",
          "title": "PROPOWAX™ Antioxidant Dry Oil 100ml",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_6ae70ce8a0cf2d0f8615d4dc",
          "domain": "khus-khus.com",
          "title": "SURYA body elixir",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_290f05b3b8bfbfdb4e079d09",
          "domain": "khus-khus.com",
          "title": "D DROP humectant factor",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_f27f918bac908cf6ba236b83",
          "domain": "khus-khus.com",
          "title": "KAI repair balm",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_f86a3606bf6dc20fc810f99d",
          "domain": "khus-khus.com",
          "title": "SANS AGE face serum",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_4dace0e8a2fe70b378b91c2c",
          "domain": "khus-khus.com",
          "title": "BLEU body serum",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_1e7b8274600d0395757a3b60",
          "domain": "7journeys.com",
          "title": "7 Journeys Miracle Timeless Eye Cream 30g (Hydrating & Glowing)",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_2da51d2f8d19211c89fb2a30",
          "domain": "7journeys.com",
          "title": "7 Journeys Miracle Glow Serum Mask 25ml (10 Sheets)",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_718736656c3aa82e74546c28",
          "domain": "7journeys.com",
          "title": "7 Journeys Glow Renewal Serum 45ml (Hydrated & Glowing Skin)",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_299e2dc017565ab3081f8c26",
          "domain": "7journeys.com",
          "title": "7 Journeys Extra Soft Glow Renewal Moisturizer 50g - Hydrating & Firming",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        }
      ]
    }
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 20
      },
      {
        "key": "no_visible_variant_axis",
        "count": 5
      }
    ],
    "issues": [],
    "issue_domains": [],
    "samples": {}
  }
}
```

## Notes

- DB Serving Ready is stricter than KB presence. Seller-only or limited evidence is not counted as high-quality pass.
- Commerce dry-run used the same catalog serving document builder with `includeNonPublic=false` and market-filtered source rows derived from `external_product_seeds`; no DB/index writes were attempted.
- A row can have high-quality KB and still fail DB serving readiness if identity or commerce doc hydration does not expose it.
- External index publication is tracked separately and is not a blocker for the current DB-backed serving path.
- Next remediation should start from `gap_backlog.csv` ordered by lane and domain impact.
