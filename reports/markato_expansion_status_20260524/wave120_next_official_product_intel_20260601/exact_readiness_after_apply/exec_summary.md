# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T04:53:49.939Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave120_next_official_product_intel_20260601/exact_readiness_after_apply

## Executive Numbers

- Rows scanned: 5
- Terminal hold rows: 2
- Action-required rows: 3
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 5
- Direct KB high-quality-ready rows: 5
- Identity ready rows: 5
- Public commerce doc groups built by dry-run: 0
- Rows with public commerce doc + insight summary: 0
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
| index_doc_shadow_only | 3 |
| terminal_hold | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| upcirclebeauty.com | 4 | 1 | 0 | 0 | 0 | 0 | index_doc_shadow_only |
| kyliecosmetics.com | 1 | 1 | 0 | 0 | 0 | 0 | terminal_hold |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 5,
  "by_market": {
    "US": 5
  },
  "by_domain": [
    {
      "key": "upcirclebeauty.com",
      "count": 4
    },
    {
      "key": "kyliecosmetics.com",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 3
    },
    {
      "key": "set_or_collection",
      "count": 1
    },
    {
      "key": "unknown_product",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 1,
    "missing_active_raw": 4,
    "missing_details": 1,
    "missing_how_to": 0,
    "missing_faq": 5
  },
  "pivota_insights": {
    "direct": {
      "displayable": 5,
      "high_quality_ready": 5,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 5,
      "high_quality_ready": 5,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 5
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_reviewed_formula_and_usage",
        "count": 4
      },
      {
        "key": "official_pdp_reviewed_line",
        "count": 1
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 0,
    "any_active_items": 1,
    "status": [
      {
        "key": "not_expected_missing",
        "count": 3
      },
      {
        "key": "not_applicable_product_family",
        "count": 1
      },
      {
        "key": "possibly_inci_guess",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "possibly_inci_guess",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "upcirclebeauty.com::possibly_inci_guess",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 4
      },
      {
        "key": "none",
        "count": 1
      }
    ],
    "samples": {
      "possibly_inci_guess": [
        {
          "external_product_id": "ext_6815bee1060ef71d9a99ce5b",
          "domain": "upcirclebeauty.com",
          "title": "Cleansing Face Milk with Oat Powder + Aloe Vera",
          "status": "possibly_inci_guess",
          "active_items": [
            "Aloe"
          ],
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
