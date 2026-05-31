# KB x Commerce Index Readiness Audit

Generated: 2026-05-31T14:11:09.958Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave97_next_expansion_20260531/readiness_after_serving_resync

## Executive Numbers

- Rows scanned: 6
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 6 (1)
- DB Serving Ready rows excluding terminal holds: 6 (1)
- External index published rows: 0
- Direct KB displayable rows: 6
- Direct KB high-quality-ready rows: 6
- Identity ready rows: 6
- Public commerce doc groups built by dry-run: 6
- Rows with public commerce doc + insight summary: 6
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5774 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 6 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| reapandglow.com | 3 | 0 | 3 | 1 | 1 | 0 | ready_no_action |
| anua.com | 2 | 0 | 2 | 1 | 1 | 0 | ready_no_action |
| nativeatlas.com | 1 | 0 | 1 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 6,
  "by_market": {
    "US": 6
  },
  "by_domain": [
    {
      "key": "reapandglow.com",
      "count": 3
    },
    {
      "key": "anua.com",
      "count": 2
    },
    {
      "key": "nativeatlas.com",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 6
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 4,
    "missing_details": 1,
    "missing_how_to": 0,
    "missing_faq": 3
  },
  "pivota_insights": {
    "direct": {
      "displayable": 6,
      "high_quality_ready": 6,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 6,
      "high_quality_ready": 6,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 6
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 4
      },
      {
        "key": "official_pdp_seed",
        "count": 2
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 4,
    "any_active_items": 3,
    "status": [
      {
        "key": "ready_hero",
        "count": 3
      },
      {
        "key": "not_expected_missing",
        "count": 2
      },
      {
        "key": "missing_hero",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "reapandglow.com::missing_hero",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 5
      },
      {
        "key": "none",
        "count": 1
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_b20d88539f9351b8db39595d",
          "domain": "reapandglow.com",
          "title": "Ayurvedic Deep Hydrating Rejuvenation Crème",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "none"
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
        "count": 2
      },
      {
        "key": "flagged",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "default_option_size_evidence_missing_axis",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "nativeatlas.com::default_option_size_evidence_missing_axis",
        "count": 1
      }
    ],
    "samples": {
      "default_option_size_evidence_missing_axis": [
        {
          "external_product_id": "ext_04f175344e976ae32c16abad",
          "domain": "nativeatlas.com",
          "title": "RESTORING Cleansing Oil",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "default",
              "axis_kind": "volume",
              "value": "4 oz",
              "visual": false
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
