# KB x Commerce Index Readiness Audit

Generated: 2026-05-27T17:10:22.701Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave34_rms_rohr_seresilk_serving_sync_20260527/readiness_final_after_authority_fix

## Executive Numbers

- Rows scanned: 3
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 3 (1)
- DB Serving Ready rows excluding terminal holds: 3 (1)
- External index published rows: 0
- Direct KB displayable rows: 3
- Direct KB high-quality-ready rows: 3
- Identity ready rows: 3
- Public commerce doc groups built by dry-run: 3
- Rows with public commerce doc + insight summary: 3
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
| db_serving_ready | 3 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| rmsbeauty.com | 1 | 0 | 1 | 1 | 1 | 0 | ready_no_action |
| rohrremedy.com | 1 | 0 | 1 | 1 | 1 | 0 | ready_no_action |
| seresilk.com.au | 1 | 0 | 1 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 3,
  "by_market": {
    "US": 3
  },
  "by_domain": [
    {
      "key": "rmsbeauty.com",
      "count": 1
    },
    {
      "key": "rohrremedy.com",
      "count": 1
    },
    {
      "key": "seresilk.com.au",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 2
    },
    {
      "key": "set_or_collection",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 2,
    "missing_details": 1,
    "missing_how_to": 0,
    "missing_faq": 3
  },
  "pivota_insights": {
    "direct": {
      "displayable": 3,
      "high_quality_ready": 3,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 3,
      "high_quality_ready": 3,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 3
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 2
      },
      {
        "key": "official_pdp_reviewed_line",
        "count": 1
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
        "key": "missing_hero",
        "count": 2
      },
      {
        "key": "not_applicable_product_family",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 2
      }
    ],
    "issue_domains": [
      {
        "key": "rohrremedy.com::missing_hero",
        "count": 1
      },
      {
        "key": "seresilk.com.au::missing_hero",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 2
      },
      {
        "key": "none",
        "count": 1
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_0d4ffd13b899460cabb1f392",
          "domain": "seresilk.com.au",
          "title": "Gentle Silk Cleanser",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_1b95875bc9bdeee751d0cee1",
          "domain": "rohrremedy.com",
          "title": "Lilly Pilly Face Moisturiser with Omega-3",
          "status": "missing_hero",
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
        "count": 3
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
