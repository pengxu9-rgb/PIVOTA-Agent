# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T04:38:43.991Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave118_next_batches_20260601/exact_readiness_after_apply

## Executive Numbers

- Rows scanned: 4
- Terminal hold rows: 0
- Action-required rows: 3
- DB Serving Ready rows: 1 (0.25)
- DB Serving Ready rows excluding terminal holds: 1 (0.25)
- External index published rows: 0
- Direct KB displayable rows: 4
- Direct KB high-quality-ready rows: 4
- Identity ready rows: 3
- Public commerce doc groups built by dry-run: 1
- Rows with public commerce doc + insight summary: 1
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
| index_doc_shadow_only | 2 |
| db_serving_ready | 1 |
| seed_content_blocked | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| rmsbeauty.com | 2 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |
| us.nuxe.com | 2 | 0 | 1 | 0.5 | 0.5 | 0 | seed_content_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 4,
  "by_market": {
    "US": 4
  },
  "by_domain": [
    {
      "key": "rmsbeauty.com",
      "count": 2
    },
    {
      "key": "us.nuxe.com",
      "count": 2
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 2
    },
    {
      "key": "accessory",
      "count": 1
    },
    {
      "key": "set_or_collection",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 2,
    "missing_active_raw": 0,
    "missing_details": 1,
    "missing_how_to": 0,
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
        "key": "official_pdp_reviewed_line",
        "count": 2
      },
      {
        "key": "official_pdp_reviewed_formula_and_usage",
        "count": 1
      },
      {
        "key": "official_pdp_reviewed_key_ingredients_and_usage",
        "count": 1
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
        "key": "not_applicable_product_family",
        "count": 2
      },
      {
        "key": "ready_hero",
        "count": 2
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 2
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
        "count": 4
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
