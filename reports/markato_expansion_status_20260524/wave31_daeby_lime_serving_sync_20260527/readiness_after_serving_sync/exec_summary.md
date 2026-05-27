# KB x Commerce Index Readiness Audit

Generated: 2026-05-27T11:54:58.510Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave31_daeby_lime_serving_sync_20260527/readiness_after_serving_sync

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
| US | 5766 |
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
| en.limecosmetic.com | 2 | 0 | 2 | 1 | 1 | 0 | ready_no_action |

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
      "key": "en.limecosmetic.com",
      "count": 2
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 4
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 4,
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
        "count": 4
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 4,
    "any_active_items": 0,
    "status": [
      {
        "key": "missing_hero",
        "count": 4
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 4
      }
    ],
    "issue_domains": [
      {
        "key": "daebyskin.com::missing_hero",
        "count": 2
      },
      {
        "key": "en.limecosmetic.com::missing_hero",
        "count": 2
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 4
      }
    ],
    "samples": {
      "missing_hero": [
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
        },
        {
          "external_product_id": "ext_ef9930ea4e8bf403866dc73d",
          "domain": "en.limecosmetic.com",
          "title": "LIME GIGA WHITE TONE-UP CREAM",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_ba4570b613069031f940d9b2",
          "domain": "en.limecosmetic.com",
          "title": "LIME OIL GEL EYE PATCH",
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
        "key": "ready",
        "count": 1
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
