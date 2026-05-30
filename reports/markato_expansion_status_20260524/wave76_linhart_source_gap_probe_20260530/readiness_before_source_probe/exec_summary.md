# KB x Commerce Index Readiness Audit

Generated: 2026-05-30T02:52:56.398Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave76_linhart_source_gap_probe_20260530/readiness_before_source_probe

## Executive Numbers

- Rows scanned: 2
- Terminal hold rows: 0
- Action-required rows: 2
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 2
- Direct KB high-quality-ready rows: 2
- Identity ready rows: 0
- Public commerce doc groups built by dry-run: 0
- Rows with public commerce doc + insight summary: 0
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
| identity_blocked | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| linhart.nyc | 2 | 0 | 0 | 0 | 0 | 0 | identity_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 2,
  "by_market": {
    "US": 2
  },
  "by_domain": [
    {
      "key": "linhart.nyc",
      "count": 2
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 1
    },
    {
      "key": "unknown_product",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 2,
    "missing_active_raw": 2,
    "missing_details": 1,
    "missing_how_to": 2,
    "missing_faq": 2
  },
  "pivota_insights": {
    "direct": {
      "displayable": 2,
      "high_quality_ready": 2,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 2,
      "high_quality_ready": 2,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 2
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_reviewed_line",
        "count": 2
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
        "count": 2
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 2
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "no_visible_variant_axis",
        "count": 1
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
