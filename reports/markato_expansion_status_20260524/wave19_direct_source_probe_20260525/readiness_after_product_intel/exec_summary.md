# KB x Commerce Index Readiness Audit

Generated: 2026-05-25T17:32:09.292Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave19_direct_source_probe_20260525/readiness_after_product_intel

## Executive Numbers

- Rows scanned: 4
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 4 (1)
- DB Serving Ready rows excluding terminal holds: 4 (1)
- External index published rows: 0
- Direct KB displayable rows: 4
- Direct KB high-quality-ready rows: 4
- Identity ready rows: 4
- Public commerce doc groups built by dry-run: 4
- Rows with public commerce doc + insight summary: 4
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5754 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 4 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| daebyskin.com | 2 | 0 | 2 | 1 | 1 | 0 | ready_no_action |
| aetasofficial.com | 1 | 0 | 1 | 1 | 1 | 0 | ready_no_action |
| seresilk.com.au | 1 | 0 | 1 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 4,
  "by_market": {
    "US": 4
  },
  "by_domain": [
    {
      "key": "daebyskin.com",
      "count": 2
    },
    {
      "key": "aetasofficial.com",
      "count": 1
    },
    {
      "key": "seresilk.com.au",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 3
    },
    {
      "key": "accessory",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 3,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 4
  },
  "pivota_insights": {
    "direct": {
      "displayable": 4,
      "high_quality_ready": 4,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 4,
      "high_quality_ready": 4,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 4
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 3
      },
      {
        "key": "official_pdp_seed",
        "count": 1
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 3,
    "any_active_items": 0,
    "status": [
      {
        "key": "missing_hero",
        "count": 3
      },
      {
        "key": "not_applicable_product_family",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 3
      }
    ],
    "issue_domains": [
      {
        "key": "daebyskin.com::missing_hero",
        "count": 2
      },
      {
        "key": "aetasofficial.com::missing_hero",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 3
      },
      {
        "key": "none",
        "count": 1
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_684249c7a94a1a6f43fdbd77",
          "domain": "aetasofficial.com",
          "title": "The Serum",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_e1c4eb330321ebc6e9672d73",
          "domain": "daebyskin.com",
          "title": "Daily Cleanser",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_81f5ddbf0c3ba5da04eabf9b",
          "domain": "daebyskin.com",
          "title": "Exfoliating Facial Scrub",
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
        "key": "no_visible_variant_axis",
        "count": 3
      },
      {
        "key": "flagged",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "wrong_axis_for_category",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "aetasofficial.com::wrong_axis_for_category",
        "count": 1
      }
    ],
    "samples": {
      "wrong_axis_for_category": [
        {
          "external_product_id": "ext_684249c7a94a1a6f43fdbd77",
          "domain": "aetasofficial.com",
          "title": "The Serum",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "β (cool)",
              "visual": true
            },
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "γ (warm)",
              "visual": true
            }
          ]
        }
      ]
    }
  }
}
```

## Notes

- DB Serving Ready is stricter than KB presence. Seller-only or limited evidence is not counted as high-quality pass.
- Commerce dry-run used the same catalog serving document builder with `includeNonPublic=false` and market-filtered source rows derived from `external_product_seeds`; no DB/index writes were attempted.
- A row can have high-quality KB and still fail DB serving readiness if identity or commerce doc hydration does not expose it.
- External index publication is tracked separately and is not a blocker for the current DB-backed serving path.
- Next remediation should start from `gap_backlog.csv` ordered by lane and domain impact.
