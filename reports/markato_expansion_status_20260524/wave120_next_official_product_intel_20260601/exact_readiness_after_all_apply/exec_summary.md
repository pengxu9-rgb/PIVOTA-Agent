# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T04:56:35.101Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave120_next_official_product_intel_20260601/exact_readiness_after_all_apply

## Executive Numbers

- Rows scanned: 18
- Terminal hold rows: 2
- Action-required rows: 8
- DB Serving Ready rows: 8 (0.4444)
- DB Serving Ready rows excluding terminal holds: 8 (0.5)
- External index published rows: 0
- Direct KB displayable rows: 18
- Direct KB high-quality-ready rows: 18
- Identity ready rows: 13
- Public commerce doc groups built by dry-run: 8
- Rows with public commerce doc + insight summary: 8
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
| db_serving_ready | 8 |
| identity_blocked | 5 |
| index_doc_shadow_only | 3 |
| terminal_hold | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| tirtir.global | 13 | 0 | 8 | 0.6154 | 0.6154 | 0 | identity_blocked |
| upcirclebeauty.com | 4 | 1 | 0 | 0 | 0 | 0 | index_doc_shadow_only |
| kyliecosmetics.com | 1 | 1 | 0 | 0 | 0 | 0 | terminal_hold |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 18,
  "by_market": {
    "US": 18
  },
  "by_domain": [
    {
      "key": "tirtir.global",
      "count": 13
    },
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
      "count": 15
    },
    {
      "key": "set_or_collection",
      "count": 2
    },
    {
      "key": "unknown_product",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 1,
    "missing_active_raw": 8,
    "missing_details": 1,
    "missing_how_to": 0,
    "missing_faq": 18
  },
  "pivota_insights": {
    "direct": {
      "displayable": 18,
      "high_quality_ready": 18,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 18,
      "high_quality_ready": 18,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 13
      },
      {
        "key": "verified",
        "count": 5
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_reviewed_formula_and_usage",
        "count": 10
      },
      {
        "key": "seller_plus_formula_reviews",
        "count": 3
      },
      {
        "key": "seller_plus_external_review",
        "count": 2
      },
      {
        "key": "seller_plus_reviews",
        "count": 2
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
    "hero_expected": 8,
    "any_active_items": 9,
    "status": [
      {
        "key": "ready_hero",
        "count": 7
      },
      {
        "key": "not_expected_missing",
        "count": 6
      },
      {
        "key": "not_applicable_product_family",
        "count": 2
      },
      {
        "key": "possibly_inci_guess",
        "count": 2
      },
      {
        "key": "missing_hero",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "possibly_inci_guess",
        "count": 2
      },
      {
        "key": "missing_hero",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "tirtir.global::missing_hero",
        "count": 1
      },
      {
        "key": "tirtir.global::possibly_inci_guess",
        "count": 1
      },
      {
        "key": "upcirclebeauty.com::possibly_inci_guess",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 16
      },
      {
        "key": "none",
        "count": 2
      }
    ],
    "samples": {
      "possibly_inci_guess": [
        {
          "external_product_id": "ext_6df19f2224fec208ca6eeea7",
          "domain": "tirtir.global",
          "title": "Matcha Bubble Tea Scrub",
          "status": "possibly_inci_guess",
          "active_items": [
            "PDRN"
          ],
          "source_origin": "pdp_section"
        },
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
      ],
      "missing_hero": [
        {
          "external_product_id": "ext_f547012d9e7a18a054240103",
          "domain": "tirtir.global",
          "title": "Mask Fit All Cover Cushion Refill",
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
        "count": 15
      },
      {
        "key": "no_visible_variant_axis",
        "count": 3
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
