# KB x Commerce Index Readiness Audit

Generated: 2026-05-25T17:17:54.911Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave19_direct_source_probe_20260525/readiness_after_catalog_sync

## Executive Numbers

- Rows scanned: 4
- Terminal hold rows: 0
- Action-required rows: 4
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 0
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 4
- Public commerce doc groups built by dry-run: 4
- Rows with public commerce doc + insight summary: 0
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
| kb_missing | 4 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| daebyskin.com | 2 | 0 | 0 | 0 | 0 | 0 | kb_missing |
| aetasofficial.com | 1 | 0 | 0 | 0 | 0 | 0 | kb_missing |
| seresilk.com.au | 1 | 0 | 0 | 0 | 0 | 0 | kb_missing |

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
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 4,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 4,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_kb",
        "count": 4
      }
    ],
    "effective_issue_domains": [
      {
        "key": "daebyskin.com::missing_kb",
        "count": 2
      },
      {
        "key": "aetasofficial.com::missing_kb",
        "count": 1
      },
      {
        "key": "seresilk.com.au::missing_kb",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "missing",
        "count": 4
      }
    ],
    "evidence_profile": [
      {
        "key": "missing",
        "count": 4
      }
    ],
    "samples": {
      "missing_kb": [
        {
          "external_product_id": "ext_684249c7a94a1a6f43fdbd77",
          "domain": "aetasofficial.com",
          "title": "The Serum",
          "used_product_id": "ext_684249c7a94a1a6f43fdbd77",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_e1c4eb330321ebc6e9672d73",
          "domain": "daebyskin.com",
          "title": "Daily Cleanser",
          "used_product_id": "ext_e1c4eb330321ebc6e9672d73",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_81f5ddbf0c3ba5da04eabf9b",
          "domain": "daebyskin.com",
          "title": "Exfoliating Facial Scrub",
          "used_product_id": "ext_81f5ddbf0c3ba5da04eabf9b",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_4a50d003cfa7b0e4c7fc2f01",
          "domain": "seresilk.com.au",
          "title": "Pure Silk Exfoliator",
          "used_product_id": "ext_4a50d003cfa7b0e4c7fc2f01",
          "quality_state": "missing",
          "evidence_profile": "missing"
        }
      ]
    }
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
