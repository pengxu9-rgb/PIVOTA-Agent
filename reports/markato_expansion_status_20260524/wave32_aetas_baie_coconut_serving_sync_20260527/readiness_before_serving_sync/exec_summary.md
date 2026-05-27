# KB x Commerce Index Readiness Audit

Generated: 2026-05-27T13:48:26.369Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave32_aetas_baie_coconut_serving_sync_20260527/readiness_before_serving_sync

## Executive Numbers

- Rows scanned: 3
- Terminal hold rows: 0
- Action-required rows: 3
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 3
- Direct KB high-quality-ready rows: 3
- Identity ready rows: 3
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
| index_doc_shadow_only | 3 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| aetasofficial.com | 1 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |
| baiebotanique.com | 1 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |
| coconutmatter.com | 1 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 3,
  "by_market": {
    "US": 3
  },
  "by_domain": [
    {
      "key": "aetasofficial.com",
      "count": 1
    },
    {
      "key": "baiebotanique.com",
      "count": 1
    },
    {
      "key": "coconutmatter.com",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 3
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 3,
    "missing_details": 1,
    "missing_how_to": 0,
    "missing_faq": 3
  },
  "pivota_insights": {
    "direct": {
      "displayable": 3,
      "high_quality_ready": 3,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 3,
      "high_quality_ready": 3,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 3
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 3
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 2,
    "any_active_items": 0,
    "status": [
      {
        "key": "missing_hero",
        "count": 2
      },
      {
        "key": "not_expected_missing",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 2
      }
    ],
    "issue_domains": [
      {
        "key": "aetasofficial.com::missing_hero",
        "count": 1
      },
      {
        "key": "baiebotanique.com::missing_hero",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 3
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_f11383c339335d64f05a964e",
          "domain": "baiebotanique.com",
          "title": "Regenerating Eye Cream",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_684249c7a94a1a6f43fdbd77",
          "domain": "aetasofficial.com",
          "title": "The Serum",
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
        "count": 2
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
