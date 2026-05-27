# KB x Commerce Index Readiness Audit

Generated: 2026-05-27T08:51:30.570Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave25_786_serving_sync_20260527/readiness_after_serving_sync

## Executive Numbers

- Rows scanned: 9
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 9 (1)
- DB Serving Ready rows excluding terminal holds: 9 (1)
- External index published rows: 0
- Direct KB displayable rows: 9
- Direct KB high-quality-ready rows: 9
- Identity ready rows: 9
- Public commerce doc groups built by dry-run: 9
- Rows with public commerce doc + insight summary: 9
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
| db_serving_ready | 9 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 786cosmetics.com | 9 | 0 | 9 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 9,
  "by_market": {
    "US": 9
  },
  "by_domain": [
    {
      "key": "786cosmetics.com",
      "count": 9
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 9
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 9,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 0
  },
  "pivota_insights": {
    "direct": {
      "displayable": 9,
      "high_quality_ready": 9,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 9,
      "high_quality_ready": 9,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 9
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 9
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
        "key": "not_expected_missing",
        "count": 9
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 9
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "no_visible_variant_axis",
        "count": 9
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
