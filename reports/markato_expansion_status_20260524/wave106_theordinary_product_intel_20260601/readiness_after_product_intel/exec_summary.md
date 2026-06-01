# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T02:27:34.602Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave106_theordinary_product_intel_20260601/readiness_after_product_intel

## Executive Numbers

- Rows scanned: 8
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 8 (1)
- DB Serving Ready rows excluding terminal holds: 8 (1)
- External index published rows: 0
- Direct KB displayable rows: 8
- Direct KB high-quality-ready rows: 8
- Identity ready rows: 8
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

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| theordinary.com | 8 | 0 | 8 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 8,
  "by_market": {
    "US": 8
  },
  "by_domain": [
    {
      "key": "theordinary.com",
      "count": 8
    }
  ],
  "by_product_family": [
    {
      "key": "set_or_collection",
      "count": 8
    }
  ],
  "coverage": {
    "missing_inci": 4,
    "missing_active_raw": 0,
    "missing_details": 0,
    "missing_how_to": 1,
    "missing_faq": 4
  },
  "pivota_insights": {
    "direct": {
      "displayable": 8,
      "high_quality_ready": 8,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 8,
      "high_quality_ready": 8,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 8
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_seed",
        "count": 5
      },
      {
        "key": "seller_plus_formula",
        "count": 3
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 0,
    "any_active_items": 0,
    "status": [
      {
        "key": "not_applicable_product_family",
        "count": 8
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 8
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 7
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
