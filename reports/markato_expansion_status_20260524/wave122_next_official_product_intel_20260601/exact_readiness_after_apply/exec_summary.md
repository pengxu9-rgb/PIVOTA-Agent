# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T07:19:21.878Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave122_next_official_product_intel_20260601/exact_readiness_after_apply

## Executive Numbers

- Rows scanned: 5
- Terminal hold rows: 0
- Action-required rows: 3
- DB Serving Ready rows: 2 (0.4)
- DB Serving Ready rows excluding terminal holds: 2 (0.4)
- External index published rows: 0
- Direct KB displayable rows: 5
- Direct KB high-quality-ready rows: 5
- Identity ready rows: 2
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
| identity_blocked | 3 |
| db_serving_ready | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| fentybeauty.com | 2 | 0 | 2 | 1 | 1 | 0 | ready_no_action |
| flowerknows.co | 2 | 0 | 0 | 0 | 0 | 0 | identity_blocked |
| judydoll.com | 1 | 0 | 0 | 0 | 0 | 0 | identity_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 5,
  "by_market": {
    "US": 5
  },
  "by_domain": [
    {
      "key": "fentybeauty.com",
      "count": 2
    },
    {
      "key": "flowerknows.co",
      "count": 2
    },
    {
      "key": "judydoll.com",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 4
    },
    {
      "key": "set_or_collection",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 3,
    "missing_active_raw": 4,
    "missing_details": 0,
    "missing_how_to": 2,
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
        "key": "official_pdp_reviewed_line",
        "count": 3
      },
      {
        "key": "official_pdp_reviewed_formula_and_usage",
        "count": 2
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 2,
    "any_active_items": 2,
    "status": [
      {
        "key": "not_expected_missing",
        "count": 2
      },
      {
        "key": "ready_hero",
        "count": 2
      },
      {
        "key": "not_applicable_product_family",
        "count": 1
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 3
      },
      {
        "key": "pdp_section",
        "count": 2
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 5
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
