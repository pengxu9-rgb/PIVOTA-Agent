# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T03:01:32.972Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave110_sigmabeauty_official_seed_20260601/readiness_after_rejection_fix

## Executive Numbers

- Rows scanned: 10
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 10 (1)
- DB Serving Ready rows excluding terminal holds: 10 (1)
- External index published rows: 0
- Direct KB displayable rows: 10
- Direct KB high-quality-ready rows: 10
- Identity ready rows: 10
- Public commerce doc groups built by dry-run: 10
- Rows with public commerce doc + insight summary: 10
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
| db_serving_ready | 10 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| sigmabeauty.com | 10 | 0 | 10 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 10,
  "by_market": {
    "US": 10
  },
  "by_domain": [
    {
      "key": "sigmabeauty.com",
      "count": 10
    }
  ],
  "by_product_family": [
    {
      "key": "set_or_collection",
      "count": 7
    },
    {
      "key": "accessory",
      "count": 3
    }
  ],
  "coverage": {
    "missing_inci": 7,
    "missing_active_raw": 0,
    "missing_details": 2,
    "missing_how_to": 0,
    "missing_faq": 8
  },
  "pivota_insights": {
    "direct": {
      "displayable": 10,
      "high_quality_ready": 10,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 10,
      "high_quality_ready": 10,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 10
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_seed",
        "count": 10
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
        "count": 10
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 10
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 10
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
