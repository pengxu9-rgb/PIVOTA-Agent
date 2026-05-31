# KB x Commerce Index Readiness Audit

Generated: 2026-05-31T15:19:18.522Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave98_rhode_product_intel_review_20260531/readiness_after_product_intel

## Executive Numbers

- Rows scanned: 6
- Terminal hold rows: 0
- Action-required rows: 1
- DB Serving Ready rows: 5 (0.8333)
- DB Serving Ready rows excluding terminal holds: 5 (0.8333)
- External index published rows: 0
- Direct KB displayable rows: 6
- Direct KB high-quality-ready rows: 5
- Identity ready rows: 6
- Public commerce doc groups built by dry-run: 6
- Rows with public commerce doc + insight summary: 5
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
| db_serving_ready | 5 |
| kb_blocked | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| rhodeskin.com | 6 | 0 | 5 | 0.8333 | 0.8333 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 6,
  "by_market": {
    "US": 6
  },
  "by_domain": [
    {
      "key": "rhodeskin.com",
      "count": 6
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 6
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 0,
    "missing_details": 3,
    "missing_how_to": 0,
    "missing_faq": 6
  },
  "pivota_insights": {
    "direct": {
      "displayable": 6,
      "high_quality_ready": 5,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 6,
      "high_quality_ready": 5,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_card_highlight",
        "count": 1
      },
      {
        "key": "quality_eligible",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "rhodeskin.com::missing_card_highlight",
        "count": 1
      },
      {
        "key": "rhodeskin.com::quality_eligible",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 5
      },
      {
        "key": "eligible",
        "count": 1
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 5
      },
      {
        "key": "community_supported",
        "count": 1
      }
    ],
    "samples": {
      "missing_card_highlight": [
        {
          "external_product_id": "ext_4357d33527506b2749d382ed",
          "domain": "rhodeskin.com",
          "title": "barrier butter",
          "used_product_id": "ext_4357d33527506b2749d382ed",
          "quality_state": "eligible",
          "evidence_profile": "community_supported"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 6,
    "any_active_items": 6,
    "status": [
      {
        "key": "ready_hero",
        "count": 6
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "pdp_section",
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
