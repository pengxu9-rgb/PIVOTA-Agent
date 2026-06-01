# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T02:06:05.351Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave103_jurlique_product_intel_20260601/readiness_after_product_intel

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
| www.jurlique.com | 6 | 0 | 6 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 6,
  "by_market": {
    "US": 6
  },
  "by_domain": [
    {
      "key": "www.jurlique.com",
      "count": 6
    }
  ],
  "by_product_family": [
    {
      "key": "set_or_collection",
      "count": 6
    }
  ],
  "coverage": {
    "missing_inci": 2,
    "missing_active_raw": 0,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 6
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
        "count": 6
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
        "count": 6
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 6
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 6
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
