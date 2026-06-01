# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T08:39:20.403Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave125_next_official_product_intel_20260601/exact_readiness_after_apply

## Executive Numbers

- Rows scanned: 11
- Terminal hold rows: 0
- Action-required rows: 9
- DB Serving Ready rows: 2 (0.1818)
- DB Serving Ready rows excluding terminal holds: 2 (0.1818)
- External index published rows: 0
- Direct KB displayable rows: 11
- Direct KB high-quality-ready rows: 11
- Identity ready rows: 11
- Public commerce doc groups built by dry-run: 2
- Rows with public commerce doc + insight summary: 2
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
| index_doc_shadow_only | 9 |
| db_serving_ready | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 786cosmetics.com | 9 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |
| fentybeauty.com | 2 | 0 | 2 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 11,
  "by_market": {
    "US": 11
  },
  "by_domain": [
    {
      "key": "786cosmetics.com",
      "count": 9
    },
    {
      "key": "fentybeauty.com",
      "count": 2
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 11
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 11,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 2
  },
  "pivota_insights": {
    "direct": {
      "displayable": 11,
      "high_quality_ready": 11,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 11,
      "high_quality_ready": 11,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 11
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_reviewed_formula_and_usage",
        "count": 11
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
        "key": "not_expected_missing",
        "count": 9
      },
      {
        "key": "low_signal_active",
        "count": 2
      }
    ],
    "issues": [
      {
        "key": "low_signal_active",
        "count": 2
      }
    ],
    "issue_domains": [
      {
        "key": "fentybeauty.com::low_signal_active",
        "count": 2
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 11
      }
    ],
    "samples": {
      "low_signal_active": [
        {
          "external_product_id": "ext_b0cae796baeb2e52326f7643",
          "domain": "fentybeauty.com",
          "title": "Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter — Vanilla Dream",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_79da6167f30f91d77e4d018b",
          "domain": "fentybeauty.com",
          "title": "Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter — Fenty Fresh",
          "status": "low_signal_active",
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
        "count": 10
      },
      {
        "key": "no_visible_variant_axis",
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
