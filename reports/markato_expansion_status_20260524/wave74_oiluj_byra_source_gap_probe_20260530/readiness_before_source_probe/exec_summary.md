# KB x Commerce Index Readiness Audit

Generated: 2026-05-30T02:26:26.332Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave74_oiluj_byra_source_gap_probe_20260530/readiness_before_source_probe

## Executive Numbers

- Rows scanned: 4
- Terminal hold rows: 0
- Action-required rows: 1
- DB Serving Ready rows: 3 (0.75)
- DB Serving Ready rows excluding terminal holds: 3 (0.75)
- External index published rows: 0
- Direct KB displayable rows: 4
- Direct KB high-quality-ready rows: 4
- Identity ready rows: 4
- Public commerce doc groups built by dry-run: 4
- Rows with public commerce doc + insight summary: 4
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5770 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 3 |
| seed_content_blocked | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| oiluj.com | 3 | 0 | 3 | 1 | 1 | 0 | ready_no_action |
| byrabeauty.com | 1 | 0 | 0 | 0 | 0 | 0 | seed_content_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 4,
  "by_market": {
    "US": 4
  },
  "by_domain": [
    {
      "key": "oiluj.com",
      "count": 3
    },
    {
      "key": "byrabeauty.com",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 4
    }
  ],
  "coverage": {
    "missing_inci": 4,
    "missing_active_raw": 4,
    "missing_details": 1,
    "missing_how_to": 1,
    "missing_faq": 4
  },
  "pivota_insights": {
    "direct": {
      "displayable": 4,
      "high_quality_ready": 4,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 4,
      "high_quality_ready": 4,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 4
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_seed",
        "count": 3
      },
      {
        "key": "official_pdp_reviewed_limited",
        "count": 1
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
        "count": 4
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 4
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "no_visible_variant_axis",
        "count": 3
      },
      {
        "key": "ready",
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
