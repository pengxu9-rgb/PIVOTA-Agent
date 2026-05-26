# KB x Commerce Index Readiness Audit

Generated: 2026-05-26T13:03:40.453Z

Scope: active external seeds, market=US, include_attached=true, limit=14

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/markato_active_coconut_source_recheck_20260526/readiness_target_14_after_product_intel

## Executive Numbers

- Rows scanned: 14
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 14 (1)
- DB Serving Ready rows excluding terminal holds: 14 (1)
- External index published rows: 0
- Direct KB displayable rows: 14
- Direct KB high-quality-ready rows: 14
- Identity ready rows: 14
- Public commerce doc groups built by dry-run: 14
- Rows with public commerce doc + insight summary: 14
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5764 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 14 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| activedrip.com | 8 | 0 | 8 | 1 | 1 | 0 | ready_no_action |
| coconutmatter.com | 6 | 0 | 6 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 14,
  "by_market": {
    "US": 14
  },
  "by_domain": [
    {
      "key": "activedrip.com",
      "count": 8
    },
    {
      "key": "coconutmatter.com",
      "count": 6
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 14
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 14,
    "missing_details": 14,
    "missing_how_to": 0,
    "missing_faq": 14
  },
  "pivota_insights": {
    "direct": {
      "displayable": 14,
      "high_quality_ready": 14,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 14,
      "high_quality_ready": 14,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 14
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_seed",
        "count": 13
      },
      {
        "key": "seller_plus_formula",
        "count": 1
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 4,
    "any_active_items": 1,
    "status": [
      {
        "key": "not_expected_missing",
        "count": 10
      },
      {
        "key": "missing_hero",
        "count": 3
      },
      {
        "key": "ready_hero",
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
        "key": "activedrip.com::missing_hero",
        "count": 3
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 14
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_94e9169cdf21031b65f760c9",
          "domain": "activedrip.com",
          "title": "HA + PEPTIDES EYE CARE",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_833660ffbf5c744869351463",
          "domain": "activedrip.com",
          "title": "R-Q10 EYE CARE",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_11509e4feaf83a2419d8c77d",
          "domain": "activedrip.com",
          "title": "KOJIC DRIP",
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
        "count": 12
      },
      {
        "key": "ready",
        "count": 2
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
